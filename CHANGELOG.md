# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [0.1.0] - 2026-10-12

首个版本。目标：让同一 DSH 进程内的会话能互相读、互相发消息，且**不改变目标会话的能力集**。

### Added
- 五个模型可见工具：`session_list` / `session_read` / `session_send` / `session_ask` / `check_delivery`。
- SLEP v1 信封协议：可信前导 + 不可伪造的 `<agent_message>` 边界，正文中的边界标记会被转义；
  信封携带 `thread` / `hop` / `request_id` / `replyTo`，对方可对等回信。
- 跳数预算（`maxHops`，默认 6）：两个 agent 互相唤醒会被掐断，不会无限对轰。
- 能力守卫：冷会话恢复时 `agentOptions` 与 `setup` **只取目标自己的持久化记录**；
  恢复前后各探测一次，preset 或模型路由变化 → 回滚并拒绝（`CAPABILITY_DRIFT`）；
  目标的 preset 无法解析 → 拒绝而不是降级。
- 归档守卫（读 `workspaceRegistry.archivedSessionIds`，registry 全局集合）、自激守卫（拒绝发给自己）。
- 幂等：显式 `requestId` + 正文指纹窗口去重；状态可跨进程从审计文件重放。
- 限流：每对「发送方→接收方」默认 12 条/分钟。
- 审计：NDJSON 一行一决策（delivery / refusal / status），自动轮转；回执由同一份文件重放。
- 优雅降级：缺 `sessionQuery`/`agents`/`agentPresets`/`workspaceRegistry` 时返回可读说明，不抛裸异常。
- 120 个离线单测（`node --test`，零运行时依赖）+ 真机端到端脚本 `scripts/e2e-live.mjs`
  + zstd 多帧会话日志读取器 `scripts/session-log.mjs`。
- 文档：README（中文）/ README_EN / docs/protocol.md / docs/verification.md / docs/troubleshooting.md。

### Added
- `session_list` 的标题回退：本机真机发现 `sessionQuery.readTitleSnapshots`（批量）会返回空/失败，
  而 `readTitle`（单个）正常 —— 现在批量拿不到时自动逐个读取，并把原因写进 `degraded`
  （`批量标题失败（…），已逐个读取`），不再静默显示"(无标题)"。3 个回归用例。

### Changed (相对任务文档的字面要求)
- **恢复冷会话时会传 `agentOptions`**：实测「只传 `resumeSessionId`」会让恢复出来的 agent 没有模型路由，
  persona 段的 `{{model}}` 解析失败导致整轮报错。现在改为**只传目标自己记录的那一份**路由，
  与宿主 `dsh-api-session-controller.resumeObserved` 的做法一致；「调用方能力集不传染」由能力守卫保证。
  详见 README「三条硬保证」与 docs/verification.md。

### Fixed
- **工具定义被编译两次导致 web profile 里整条插件 fiber `failed`**（2026-10-12 装机后实测）：
  宿主的 `defineTool` 会**原地改写**传入的 options（把 `parameters` 换成编译后的 JSON Schema），
  而重构后五个定义既在声明处编译、又在末尾 `map(defineTool)` 里编译一次，
  第二次就报 `JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object`。
  现在 `createToolOptions` 只产出原始 spec、`createToolDefinitions` 对**全新对象**只编译一次；
  并加了 4 个回归测试（用「会原地改写的假 defineTool」模拟宿主行为）、修好了 smoke 脚本
  （此前它只测了 schema 编译，没有走真实装配路径，所以没拦住这个 bug）。
- 装配改为**逐个工具**编译+注册：某一个定义被宿主拒绝时只损失那一个工具，
  不再让整条 fiber 失败、五个工具全没了（有对应测试）。
- **`session_read` / `session_list` 的返回值不是无损 JSON**（2026-10-12 第二次重启后实测）：
  目标会话没有标题时 `titleOf()` 返回 `undefined`，而 `undefined` 成员会让宿主的
  "value is not lossless JSON" 校验直接判非法，工具调用报错。顶层统一过 `compact()`，
  并补 2 个回归用例（无会话身份的调用方 / 无标题·cwd·preset 的会话）。
- 归档守卫最初读的是 `workspace.archivedSessionIds`（每个 workspace 的字段，实际不存在），
  导致归档会话仍会被唤醒；端到端测试暴露后改为读 `workspaceRegistry.archivedSessionIds`（registry 全局集合）。
