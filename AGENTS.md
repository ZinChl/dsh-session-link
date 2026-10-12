# AGENTS.md — 在本仓库里干活前先读这个

## 这是什么

`dsh-session-link`：DeepSeek Harness（DSH）的跨会话通信插件。给同一进程内的会话提供
`session_list` / `session_read` / `session_send` / `session_ask` / `check_delivery` 五个工具。

## 不能回退的硬约束（改动前先看有没有测试盯着）

1. **不新建会话**：代码里不允许出现 `agents.create`；`session_send` 对未知 id 必须报 `TARGET_NOT_FOUND`。
2. **不改变目标会话的能力集**：冷会话恢复时 `agentOptions` 与 `setup` **只能**来自目标自己的持久化记录
   （`lib/engine.js` 的 `buildResumeOptions`）。调用方的任何字段都不许出现在 `agents.resume` 的入参里。
   目标 preset 解析不出来 → 拒绝（`CAPABILITY_DRIFT`），**不许**降级成默认组合。
3. **归档会话拒绝投递且不唤醒**：归档集合是 `ctx.workspaceRegistry.archivedSessionIds`（registry **全局**集合，
   不是 `workspace.archivedSessionIds` —— 这里曾经出过 bug，见 CHANGELOG）。
4. **拒绝发给自己**。
5. **同进程**：不放任何网络传输。
6. **缺服务要降级成可读结果**，不许把裸异常抛给 agent loop。
7. **审计**：每个决策落一行 NDJSON；回执由同一份文件重放（内存与落盘不能分叉）。
8. **幂等**：`requestId` 与正文指纹两道。
9. **投递内容不可信**：`lib/envelope.js` 负责属性净化与边界转义，改它必须补 `tests/envelope.test.mjs` 的用例。
10. **不写 profile**：插件不碰 `~/.dsh/profiles/**`，安装/卸载只走 `dsh plugin add/remove`。

## 环境坑（踩过）

- **npm 有同名包**：`dsh-session-link@0.2.x`（PwnKY，功能不同）。本仓库**不发布 npm**，
  安装一律用 `github:ZinChl/dsh-session-link` 或本地路径。
- **兼容门**：DSH 只校验 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 开头的 peer，且**不能写上界**。
  `npm run check:manifest` 会拦住这类回归。
- **会话日志是 zstd 多帧**：`zlib.zstdDecompressSync(整文件)` 只解第一帧。
  用 `scripts/session-log.mjs`（它按 magic 切帧）。
- **恢复冷会话必须带模型路由**：只传 `resumeSessionId` 会让 persona 的 `{{model}}` 解析失败、整轮报错。
  这是真机跑出来的结论，别"顺手简化"回文档里的字面写法。
- **`dsh plugin remove` 会残留 `node_modules/<包名>` 软链**（依赖与 bundles 已清干净）。
- **宿主的 `defineTool` 会原地改写 options**（把 `parameters` 换成编译后的 JSON Schema）。
  同一个 option 对象编译两次必炸：`parameters.type must be a value schema object`。
  所以 `createToolOptions`（纯 spec）与 `createToolDefinitions`（编译一次）必须分开用；
  回归测试见 `tests/tool-definitions.test.mjs`。
- **Cordis 缓存已 import 的模块，HMR 不监听 `link:` 依赖**：改完 `lib/` 必须重启 dsh 才生效，
  `plugin_manager` 的关/开只会拿旧模块重跑 `apply`（会复现同一个错误，别被误导）。
- 排查插件是否挂上：`plugin_manager list_plugins` 看 `patchId: dsh-session-link` 的 `fiberPhase`
 （`active` 正常 / `failed` 说明 `apply` 抛错，关一次再开会把原始堆栈放进 `error.diagnostic`）。

## 改完怎么验

```bash
npm test                 # 117 个离线单测（改 lib/ 必跑）
npm run check:manifest   # 清单与兼容门
npm run smoke            # 用宿主自己的 defineTool/validateArgs 编译工具定义
npm run e2e              # 真机端到端（需要插件已装进 headless profile）
```

`npm run e2e` 会往 `~/.dsh/session-link/audit.ndjson` 与真实会话目录写东西：
跑完记得清理它创建的测试会话，并把产物 `e2e-out/e2e-live.json` 的要点补进 `docs/verification.md`。

## 提交与文档

- 提交信息用 `feat:/fix:/docs:/test:/chore:` 前缀，正文说清「为什么」；
- 改了行为就更新 `CHANGELOG.md`（Keep a Changelog 格式）；
- 涉及恢复语义、信封格式、拒绝码的改动，必须同步 `docs/protocol.md` 与 `README.md` 的对应表格。

<sub>powered by dsh</sub>
