# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## [0.2.0] - 2026-10-12

### Added
- **Web 设置页（跳数可调）**：侧边栏 → Plugins → dsh-session-link → 配置。
  宿主侧导出 schemastery `Config`（字段带范围与描述），浏览器半边 `lib/client.js` 注册进
  `plugins.bundle.config` 槽，通过 settings 域自己的客户端服务 `ctx.configForms` 读写该条目的 Config；
  `applies: 'live'`，保存后宿主重新激活条目，**不用重启 dsh** 就能改跳数上限等参数。
  可改：`maxHops` / `rateLimitPerMinute` / `dedupeWindowMs` / `maxTextChars` / `verifyCapability` / `auditFile`，
  每项都能「恢复默认」（等价于从用户层删除该键）。
- `npm run probe:settings`：**不用浏览器**验证「新起的 dsh 进程会不会给这个插件建设置页」——
  把一次性 overlay 插件塞进 `dsh --profile headless --patch <临时文件>`（不写 prompt、不调模型），
  读回宿主 `ctx.settings.describe()` 的结论（命名空间/可编辑字段/当前值），`--write` 再走一次真实写入+回滚。
  2026-10-12 真机结果：`dsh-session-link PRESENT`、六个可编辑字段、`maxHops → 7`（revision 1）后回滚到 6、
  非可编辑字段被拒 `Config field "readDefaultLimit" is not volatile`。
- 显示元数据：`locale/zh.json`、`locale/en.json` 的 `meta.title/description`，以及 `./icon` 导出。
- `schemastery` 成为运行时依赖（schema 与设置页需要）；`Config` 加载失败时插件仍可挂载，只是没有 schema 校验与设置页。
- 8 个 Config schema 回归用例（默认值、边界拒绝、描述齐全、可序列化、与 `resolveConfig` 一致）。
- 7 个**浏览器半边**回归用例：用一个最小 React 替身（含 render-phase setState 收敛与 mount effect）跑组件，覆盖
  「宿主表单 / configForms 服务 / 缺失通道」三条数据源分支、summary 视图、以及 save/重置按钮的启用条件。

### Fixed（设置页三次真机失败的根因）
- **设置命名空间只暴露 `.volatile()` 字段**：宿主 `dsh-settings` 的 `volatileForm()` 只投影 `meta.volatile` 字段，
  没有 volatile 字段的条目不会出现在设置命名空间里 —— 所以页面上一直没有可编辑项。
  六个 UI 字段现在标记为 volatile；`.volatile()` 来自 `@deepseek-ai/schemastery`（DSH fork），
  加载顺序改为「fork → npm 包（只做校验）」，并在 schema 里对方法缺失做兜底。
- **volatile 字段是 `{ get() }` 包装对象**：`resolveConfig()` 现在统一解包（并加类型护栏），
  否则引擎会把包装对象当数字用；新增回归用例覆盖「包装值 → plain 值」。
- 客户端读取镜像快照时用错字段：答案在 `snapshot.view`（`SettingsDescribeView`）而不是 `snapshot.value`；
  且 `status` 四态里 `idle` 表示「还没有答案」，不能当成 `ready` 去查命名空间。
- 数据源改为「宿主表单 props.form → `ctx.configForms`（settings 域自己的客户端服务）→ 可读说明」，
  只硬依赖 `slots`；真找不到时把宿主已注册的命名空间列在错误信息里，便于一眼定位。
- **空设置页的提示改成三个真原因**（旧文案只说「确认 patch 里有这一行」，把最常见的原因藏了）：
  ① 进程启动早于插件更新（改 `lib/` 必须重启，刷新页面不够）；② Config 没有可编辑字段；③ 条目缺失或被禁用。
- `.volatile()` 缺失时的兜底改为直接写 `meta.volatile`（宿主只读这个标记），
  这样即便部署里解析不到 `@deepseek-ai/schemastery`，设置页照样出现；`EDITABLE_FIELDS` 导出并与
  schema 的 volatile 集合互相钉住（回归用例）。注意 schemastery 的 schema 是**可调用对象**
  （`typeof` 是 `function`），判断"能不能标记"不能写成 `typeof === 'object'`。

### Changed
- 所有 `@deepseek-ai/dsh*` peer 标记为 **optional**：npm 默认会自动安装 peer，而 npm 上这些包只有远古版本
  （`0.1.0-rc.6`），会让 `npm install` 直接崩在 arborist 里。它们本来只由宿主提供。
- `check-manifest` 增加客户端半边校验：`dsh.client.platform`、`./client` 导出且走
  `__ModuleLoader__.load` 且 id 等于包名、locale 元数据、`./icon`、以及文件是否会被打进 tarball。
- CI 增加 `npm ci`（有了运行时依赖）。

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
- 135 个离线单测（`node --test`）+ 真机端到端脚本 `scripts/e2e-live.mjs`
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
