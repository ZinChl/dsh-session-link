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
- 109 个离线单测（`node --test`，零运行时依赖）+ 真机端到端脚本 `scripts/e2e-live.mjs`
  + zstd 多帧会话日志读取器 `scripts/session-log.mjs`。
- 文档：README（中文）/ README_EN / docs/protocol.md / docs/verification.md / docs/troubleshooting.md。

### Changed (相对任务文档的字面要求)
- **恢复冷会话时会传 `agentOptions`**：实测「只传 `resumeSessionId`」会让恢复出来的 agent 没有模型路由，
  persona 段的 `{{model}}` 解析失败导致整轮报错。现在改为**只传目标自己记录的那一份**路由，
  与宿主 `dsh-api-session-controller.resumeObserved` 的做法一致；「调用方能力集不传染」由能力守卫保证。
  详见 README「三条硬保证」与 docs/verification.md。

### Fixed
- 归档守卫最初读的是 `workspace.archivedSessionIds`（每个 workspace 的字段，实际不存在），
  导致归档会话仍会被唤醒；端到端测试暴露后改为读 `workspaceRegistry.archivedSessionIds`（registry 全局集合）。
