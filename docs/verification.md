# 验收记录（原始输出）

环境：DSH `0.2.1-alpha.2`（`/home/dwad/.local/lib/node_modules/@deepseek-ai/dsh`），Node `v24.21.0`，
profile `web` → `/home/dwad/.dsh/profiles/web/`，插件路径 `/home/dwad/github/dsh-session-link`。
时间：2026-10-12。

> 所有输出都是命令原样贴的，没有手工润色。凡是「没做到」的地方在第 3 节明确写了。

---

## 1. 安装干净（对应验收 1）

安装前备份了 profile 三个文件：

```
$ cd /home/dwad/.dsh/profiles/web && cp -p package.json pnpm-workspace.yaml cordis.patch.yml \
    "$f.bak-sessionlink-$(date +%Y%m%d-%H%M%S)"
cordis.patch.yml.bak-sessionlink-20261012-153336
package.json.bak-sessionlink-20261012-153336
pnpm-workspace.yaml.bak-sessionlink-20261012-153336
```

安装（**没有**挂死，2.5~5.7 s 完成，没有出现文档里说的半成品状态）：

```
$ dsh plugin --profile web add /home/dwad/github/dsh-session-link
✓ Lockfile passes supply-chain policies (verified 4h ago)
[WARN] Issues with peer dependencies found. Run "pnpm peers check" to list them.

dependencies:
+ dsh-session-link link:/home/dwad/github/dsh-session-link
Done in 5.7s using pnpm v11.22.0
```

两处核对（防半成品）：

```
$ node -e "const p=require('/home/dwad/.dsh/profiles/web/package.json'); ..."
dependency: link:/home/dwad/github/dsh-session-link      # dependencies 里有了
in bundles: true                                          # dsh.profile.bundles 里也有了
$ ls -la node_modules/ | grep session-link
lrwxrwxrwx dsh-session-link -> ../../../../github/dsh-session-link   # 软链指向仓库
```

组合（对应验收 2）：

```
$ dsh --profile web --dump-config | grep -A3 "== dsh-session-link"
# == dsh-session-link
- id: dsh-session-link
  name: dsh-session-link
```

> ⚠️ 因为插件挂在 profile 根层，**重启 dsh 后所有会话自动获得工具**；本次运行中的 GUI 进程是在装之前启动的，
> 所以它自己的工具表里没有这五个工具（这是宿主的正常行为，第 3 节详述）。

---

## 2. 自动化测试（对应验收 6）

```
$ npm test            # = node --test（自动发现）
ℹ tests 117
ℹ suites 39
ℹ pass 117
ℹ fail 0
ℹ duration_ms 1151.131808
```

覆盖的硬约束（每个都有对应测试）：

| 约束 | 测试 |
|---|---|
| 不新建会话 | `agents.create` 一旦被调用就抛错的 fake host（所有投递测试都会踩到） |
| 不改变 preset/模型 | `resumes with the target’s OWN recorded route and preset, never the caller’s`、`falls back to the deployment default route only when the target recorded none`、`refuses instead of downgrading when the target’s preset cannot be composed`、`refuses when resuming would change the model route` |
| 归档拒绝 | `refuses without resuming or delivering`（断言未调用 resume、未产生 inbox） |
| 拒绝发给自己 | `refuses and writes a refusal audit line` |
| 幂等 | `does not deliver twice for the same explicit requestId`、`… identical content inside the dedupe window` |
| 跳数预算 | `allows exactly maxHops deliveries on one thread, then refuses` |
| 限流 | `refuses past the per-pair budget and explains the wait` |
| 注入边界 | `never lets a hostile body close the boundary early`、`never lets a hostile title inject attributes or header lines`（严格属性文法解析整行） |
| 优雅降级 | `reports SERVICE_UNAVAILABLE when the host has no agents service`、`degrades to a readable failure when the host has no query service` |
| 工具输出合法 | 每个工具都跑 `validate(execute(...))` + `assertLosslessJson`（`tests/helpers/schema.mjs`） |
| 审计 | `serializes concurrent appends so line order equals call order`、`skips a torn final line instead of throwing`、`rotates past the size budget` |

真机编译（宿主自己的 `defineTool` + `validateArgs`）：

```
$ npm run smoke
host packages: /home/dwad/.local/lib/node_modules/@deepseek-ai/dsh
  defineTool=function  validateArgs=function  createUserMessage=function

ok   session_list  (3 params, output schema object)
     wrong-typed sample rejected: "limit" must be a number
ok   session_read  (3 params, output schema object)
     wrong-typed sample rejected: "sessionId" must be a string
ok   session_send  (7 params, output schema object)
     wrong-typed sample rejected: "text" must be a string
ok   session_ask  (6 params, output schema object)
     wrong-typed sample rejected: "text" must be a string
ok   check_delivery  (1 params, output schema object)
     wrong-typed sample rejected: "requestId" must be a string

5 tool definition(s) compiled, 0 failure(s)
```

---

## 3. 工具在运行进程里可见（对应验收 3）—— 两次真机 bug 与最终结论

**结论**：第一次重启后**没**挂上（加载条目 `fiberPhase: failed`），定位到根因并修好后，同一行
现在用宿主自己的装配路径验证通过（见 3.3）。下面是完整过程，因为这两次失败比"一次成功"更有信息量。

### 3.1 第一次重启：条目存在但 `failed`

```
$ dsh plugin --profile web --dump-config | grep -A3 "== dsh-session-link"
# == dsh-session-link
- id: dsh-session-link
  name: dsh-session-link                # 组合没问题

$ plugin_manager list_plugins（截取）
{"entryId":"include:dsh-session-link","moduleName":"dsh-session-link",
 "enabled":true,"fiberPhase":"failed","patchId":"dsh-session-link"}   # 挂载失败

$ 调用 session_list
Error: unknown tool "session_list"
```

失败原因用 `plugin_manager set_plugin`（关一次再开）拿到，返回体里带**原始堆栈**：

```
{"application":"failed","error":{"diagnostic":"dsh: warning: 1 entry did not activate
dsh-session-link (dsh-session-link): JsonSchemaError: unsupported JSON schema:
parameters.type must be a value schema object
    at defineTool (.../dsh-tools/lib/index.js:848:21)
    at .../lib/tools.js:676:33
    at createToolDefinitions (.../lib/tools.js:676:18)
    at mountSessionLink (.../lib/mount.js:45:23)
    at async Object.apply [as callback] (.../lib/index.js:63:3)"}}
```

### 3.2 根因：宿主的 `defineTool` **原地改写** options，而我把定义编译了两次

在本机复刻出同一条路径（把 lib 拷进一个能按宿主方式解析裸导入的目录，再用真实 `defineTool` 装配），
逐条打印每个工具编译时的 `parameters`，抓到了现场：

```
FAIL session_list: unsupported JSON schema: parameters.type must be a value schema object
parameters keys: [ 'type', 'properties' ]      ← 已经不是属性表，而是编译后的 JSON Schema
  type: "object"
  properties: {"query":{...},"limit":{...},"includeArchived":{...}}
compiled before failure: session_list, session_read, session_send, session_ask, check_delivery, session_list
```

即：`session_list` 被编译了**两次**，第二次拿到的是已被宿主改写过的对象。
成因是重构时留下的双重编译——五个定义既在声明处 `defineTool({…})`，又在末尾
`options.map(entry => defineTool(entry))` 里再编译一次。

单测和 smoke 当时都没拦住，因为：
- 单测注入的是**假 `defineTool`**（`(o) => o`，不改写）；
- `smoke-host.mjs` 在重构后只测了"schema 能不能编译"，没有走真实的装配入口。

### 3.3 修复与回归

```
lib/tools.js
  createToolOptions()      ← 只产出原始 spec（每次都是全新对象）
  createToolDefinitions()  ← 对全新对象只编译一次
lib/mount.js
  逐个工具 编译 + 注册：某一个定义被拒只损失那一个工具，不再让整条 fiber 失败
```

新增 `tests/tool-definitions.test.mjs`（4 个用例）：用一个**会原地改写的假 `defineTool`** 模拟宿主行为，断言
「每个工具只编译一次」「可重复编译」「`createToolOptions` 的 spec 不被污染」「单个定义被拒时其余仍挂载」。
`smoke-host.mjs` 也改回走真实装配路径。修复后同一套复刻脚本：

```
$ node repro.mjs        # 真实 defineTool + 真实 createUserMessage + 真实装配入口
registered session_list
registered session_read
registered session_send
registered session_ask
registered check_delivery
info: dsh-session-link: 已挂载（session_list / session_read / session_send / session_ask / check_delivery），审计日志 …，跳数上限 6，限流 12/分钟
mounted ok
```

### 3.4 第二次重启：挂上了，验收 3 闭环

```
$ plugin_manager list_plugins
{"entryId":"include:dsh-session-link","moduleName":"dsh-session-link",
 "enabled":true,"fiberPhase":"active","patchId":"dsh-session-link"}        # ← active
```

重启后宿主把我的工具 schema 注入了这个会话的工具表（客户端回执里的 `### Updated Tool Schemas` 列全了 5 个），
而且是真的能调：

```
$ session_list(limit=10)
会话共 132 个（只列前 10 个）
- session-69f3469d-… | (无标题) | /home/dwad/github | live,running,self,preset=standard | 2026-10-12T08:45:28.618Z
- session-a886dd00-… | (无标题) | /home/dwad/github | cold,idle,preset=standard    | 2026-10-12T07:58:48.280Z
…
! 已隐藏 31 个归档会话（includeArchived=true 可查看）
```

注意两点：`self` 被正确标出；**归档集合读的是真实 registry**（隐藏了 31 个），这条守卫现在有真机证据了。

### 3.5 真机跑通后又暴露一个：`session_read` 不是 lossless JSON

```
$ session_read(sessionId="session-a886dd00-…")
Error: tool "session_read" returned invalid output: value is not lossless JSON
```

根因：目标会话**没有标题**（标题服务无结果），`titleOf()` 返回 `undefined`，而我把 `title/cwd/agentPreset`
直接放进了返回值 —— 宿主的结果校验要求"无损 JSON"，`undefined` 成员直接判非法。
修法：`session_read` / `session_list` 顶层补 `compact()`，并新增一个**深度** `lossless()` 守卫
（递归剔除 `undefined` 成员），五个工具的返回值统一过它 —— 这样"忘了 compact"这类错误在结构上不可能再发生。
回归用例 3 个：没有会话身份的调用方、没有标题/cwd/preset 的会话、以及一次性遍历五条调用路径断言深度无损。

这条同样需要重启才生效（3.4 里说的模块缓存）。**这是本次唯一还没在运行进程里复验的修复。**

### 3.6 结论

验收 3 闭环：`fiberPhase: active` + 工具表注入 + 真机调用成功。
过程中真机一共抓出 3 个只有端到端才能暴露的问题（归档集合读错位置、`defineTool` 双重编译、
`session_read` 非无损 JSON），全部已修 + 已加回归测试。

## 4. 端到端 A→B→A（对应验收 4）

脚本：`node scripts/e2e-live.mjs --dir /home/dwad/github`（真 `dsh` 进程 + 真模型 + 真会话文件）。
一次完整跑完的摘要：

```
=== summary ===
{
  "replySeen": true,
  "constraint2": true,
  "requestId": "req_f5yher5biv4e",
  "sessionB": "session-5a11346d-321a-4fcb-9651-97f8db5b2ba9"
}
evidence written to /home/dwad/github/e2e-out/e2e-live.json
```

### 4.1 A 里 `session_list` 能看到 B（冷会话）

```
TOOL session_list  input={"query":"session-90d905f3-…"}
→ 会话共 1 个
  - session-90d905f3-… | (无标题) | /home/dwad/github | cold,idle | 2026-10-12T07:44:14.103Z
  ! 会话标题不可用（ctx.sessionQuery.readTitleSnapshots 无结果），按 id 展示
```

（headless profile 不挂标题服务，所以标题为空并给出 `degraded` 说明；web profile 里这一项有值。）

### 4.2 A 用 `session_ask` 投递给冷会话 B，B 被唤醒并回复

```
TOOL session_ask input={"sessionId":"session-5a11346d-…","text":"请用一句话回复：PONG-E4MY61（代号 BETA）…","waitMs":180000}
→ 已投递 followup → session-5a11346d-…
  requestId=req_f5yher5biv4e thread=th_5uxwo4kpyeaz hop=1/6 chars=128
  目标状态：冷会话，已按它自己的 preset/模型恢复
  能力守卫：preset ? → ?，model deepseek-flash → deepseek-flash（未改变）
```

B 的会话日志（`scripts/session-log.mjs`，zstd 多帧解码）在投递后新增：

```
#30 agent/inbox/spliced  {"target":"next-turn","inserted":[{"content":[{"type":"text","text":"[session-link] 你收到一条来自另一个 DSH 会话…<agent_message …>"}]}]}
#31 turn/start {"turn":3}
#33 step/start
#35 session-log-deepseek/delivery-accepted
#36 assistant/message   → "PONG-E4MY61（代号 BETA）"
#37 tool/call           → session_send（B 用插件回信给 A）
#41 delivery-accepted
#44 turn/end
```

脚本判定 `replySeen = true`（B 的 assistant 消息里出现了本次随机 token）。

### 4.3 B→A 回信（信封协议生效，跳数 +1）

B 按信封里的指引用 `session_send` 回信，A 侧收到后其回执被推进为 `completed`，审计里留下了完整一行：

```json
{"v":1,"ts":1791791865739,"kind":"status","requestId":"req_gohoqcdu22xj","status":"completed",
 "detail":"目标会话的回合已结束",
 "reply":"收到 BETA 会话（`session-5a11346d-…`）回信：\n\n- thread：`th_5uxwo4kpyeaz`，hop：`2/6`，
  request_id：`req_gohoqcdu22xj`，mode：followup\n- 内容：`PONG-E4MY61（代号 BETA）`…"}
```

`thread` 沿用、`hop` 变成 `2/6` —— 线程与跳数预算是在真机上工作的。

### 4.10 真机（**web profile**）：带 preset 的冷会话恢复 + 回信，跳数 2/6

上面 4.1~4.9 跑在 headless profile（那里的会话没有 preset 头）。最后在**主部署路径**（web profile，
会话带 `preset=standard`）上补了同样一遍，目标选的是一个空的冷会话 `session-a886dd00-…`：

```
$ session_send(sessionId="session-a886dd00-…", requestId="req_verify_preset_20261012", text="…只回复 LINK-VERIFY-OK…")
已投递 followup → session-a886dd00-ac52-4adb-884b-0d61d5832c66
requestId=req_verify_preset_20261012 thread=th_fbjmilzhlh3j hop=1/6 chars=75
目标状态：冷会话，已按它自己的 preset/模型恢复
能力守卫：preset standard → standard，model ? → ?（未改变）
```

审计行（注意 `presetId=standard`、`resumeRoute=deployment-default`、`drift=false`）：

```json
{"kind":"delivery","requestId":"req_verify_preset_20261012","from":"session-69f3469d-…","to":"session-a886dd00-…",
 "hop":1,"maxHops":6,"capability":{"guarded":true,"resumed":true,"resumeRoute":"deployment-default",
 "presetId":"standard","presetBefore":"standard","presetAfter":"standard","drift":false}}
```

`resumeRoute=deployment-default` 是因为这个空会话**没有任何 `request/header` 记录**（没跑过模型），
所以没有"自己的模型路由"可replay，按宿主默认选择恢复；preset 走的是 `agentPresets.mount(agentCtx,'standard')`。

目标被唤醒后真的跑了，并且**用协议回了信**（它的会话日志）：

```
#9  user/message  [envelope] [session-link] 你收到一条来自另一个 DSH 会话（Agent）的消息…
#23 assistant/message  已通过 session_send 回送 `LINK-VERIFY-OK`（hop 2/6，requestId `req_7jjv44wftf5a`）。能力守卫回执：目标会话 preset `stan…
#25 turn/end completed
```

回信本身也进了审计（方向相反、跳数 +1、能力守卫同样为 false）：

```
delivery: session-a886dd00-… → session-69f3469d-… hop 2/6 | preset standard → standard | drift False
```

**这条补上了 7 节里"web profile 带 preset 的冷会话恢复"缺口**，而且是一次完整的 A→B→A（我 → 它 → 我）。

### 4.4 约束 2：恢复前后 preset 与模型一致（会话日志证明）

```
phase 2 · B capability BEFORE : {"headerPreset":null,"presetEvents":[],
  "newestRequest":{"seq":12,"reason":"initial","provider":"deepseek-official","model":"deepseek-flash"}}
phase 5 · 同一条会话 AFTER   : model deepseek-flash → deepseek-flash
verdict: {"samePreset":true,"samePresetEvents":true,"sameModel":true,"sameProvider":true}
```

审计行里的能力快照（同一份证据落盘）：

```json
"capability":{"guarded":true,"resumed":true,"resumeRoute":"target-record",
  "modelBefore":"deepseek-flash","modelAfter":"deepseek-flash",
  "providerBefore":"deepseek-official","providerAfter":"deepseek-official","drift":false}
```

`resumeRoute: "target-record"` 表示 `agentOptions` 取自**目标自己**的记录，不是部署默认、更不是调用方的。

### 4.5 拒绝发给自己

```
TOOL session_send → 投递被拒绝 [SELF_SEND]：目标会话就是调用方自己（session-fc4dce39-…），已拒绝
```

### 4.6 归档会话拒绝投递（用真实归档集合）

归档集合取自 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds`（这就是宿主 `workspaceRegistry.archivedSessionIds` 的持久化形态）：

```
$ dsh --profile headless --patch examples/patch-workspace.yml \
    "调用 session_send 给会话 session-43be5573-… 发一条内容为 'hello' 的消息，把工具返回的原文贴出来。"
工具返回原文如下：
投递被拒绝 [TARGET_ARCHIVED]：会话 session-43be5573-… 已归档，本插件不唤醒归档会话
```

> **诚实披露（这次测试抓到的真 bug 与副作用）**：修好之前，归档守卫读的是
> `workspace.archivedSessionIds`（每个 workspace 的字段，实际不存在），于是**没有拦住**归档会话，
> 上面那个 `session-43be5573-…`（8 月的旧会话，cwd `/home/dwad/dsh-test`，该目录已不存在）
> 收到了一条排队的信封消息并起了一轮 —— 该轮因为工作目录不存在**立刻以 error 结束，没有发生任何模型调用**：
> `turn/end {"turn":3,"reason":{"kind":"error","error":{"message":"working-directory: directory does not exist: \"/home/dwad/dsh-test\""}}}`。
> 修复后同一命令返回 `TARGET_ARCHIVED`，且不再 resume。这个 bug 只有真机端到端能发现（单测里的 workspace 形状是错的）。
> 修复：`lib/sessions.js: archivedSessionIds()` 改为读 registry 全局集合，并加进 `save+` 测试。

### 4.7 steer 只对 running 生效（不静默降级）

```
TOOL session_send(mode=steer) → 投递被拒绝 [TARGET_NOT_RUNNING]：目标会话 session-5a11346d-… 当前是 idle 状态，
  steer 只对正在运行的会话有效；请改用 followup
```

### 4.8 幂等

```
第 1 次 session_send(requestId="req_e2e_PONG-E4MY61") → 已投递 … requestId=req_e2e_PONG-E4MY61 …
第 2 次（完全相同）                                   → 幂等命中：复用已有回执（状态 delivered）
                                                      该 requestId 已投递过，本次直接返回原回执（幂等）
```

### 4.9 审计文件（原样两行）

```json
{"v":1,"ts":1791791737253,"kind":"delivery","requestId":"req_f5yher5biv4e","thread":"th_5uxwo4kpyeaz","hop":1,"maxHops":6,
 "from":"session-caa991fe-f52c-4528-adb7-c661482b1757","to":"session-5a11346d-321a-4fcb-9651-97f8db5b2ba9","mode":"followup",
 "fingerprint":"21c8bc8fc53731a0fe28b9d2b3a1ea38","chars":128,"targetWasLive":false,"resumed":true,
 "capability":{"guarded":true,"resumed":true,"resumeRoute":"target-record","modelBefore":"deepseek-flash",
 "modelAfter":"deepseek-flash","providerBefore":"deepseek-official","providerAfter":"deepseek-official","drift":false},
 "envelope":"[session-link] 你收到一条来自另一个 DSH 会话（Agent）的消息…<agent_message v=\"1\" from=\"session-caa991fe-…\" …>"}
{"v":1,"ts":1791791436290,"kind":"refusal","code":"SELF_SEND","message":"拒绝发给自己",
 "from":"session-b0356082-…","to":"session-b0356082-…","mode":"followup"}
```

---

## 5. 卸载干净（对应验收 5）

```
$ dsh plugin --profile web remove dsh-session-link
dependencies:
- dsh-session-link link:/home/dwad/github/dsh-session-link
Done in 1.5s using pnpm v11.22.0

$ node -e "…读 profile/package.json…"
deps has: []          # dependencies 回到 11 项（装之前也是 11）
bundles has: []       # dsh.profile.bundles 回到 19 项（装之前也是 19）
deps count: 11 bundles count: 19

$ dsh --profile web --dump-config | grep -c "session-link"
0

$ diff <(当前两个字段) <(package.json.bak-sessionlink-20261012-153336 的两个字段)
IDENTICAL to the pre-install backup ✓
```

**发现**：`dsh plugin remove` 之后 `node_modules/dsh-session-link` 这个软链**残留**了
（依赖与 bundles 都已清掉，只有投影没删）。手工 `rm node_modules/dsh-session-link` 后 `node_modules` 也回到干净状态。
仓库本体未受影响（`ls /home/dwad/github/dsh-session-link` 正常）。这一点已写进
[docs/troubleshooting.md](troubleshooting.md)，建议在 harness 侧用 `removeLinkProjections` 补上。

**最终状态**：按「用户要能直接用」的诉求，验收后又把插件装回了 `web` profile：

```
$ dsh plugin --profile web add /home/dwad/github/dsh-session-link
dependency: link:/home/dwad/github/dsh-session-link
in bundles: true
$ dsh --profile web --dump-config | grep -A2 "== dsh-session-link"
- id: dsh-session-link
  name: dsh-session-link
```

重启 `dsh web` 之后所有会话即可使用；`headless` profile 里也装了一份，用于跑 `npm run e2e`。

---

## 6. 与任务文档的偏离（含依据）

| 文档要求 | 实际做法 | 依据 |
|---|---|---|
| 「resume 时不要传 `agentOptions`」 | **传，但只传目标自己记录的 provider/model**；preset 用 `setup` 挂载（同宿主 `resumeObserved`） | 只传 `resumeSessionId` 时，真机上 B 的回合直接报 `prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`，整轮失败。宿主自己的恢复路径也传这两样 |
| 验收 3：`listTools` 里看到工具 | 只能在重启后复核；已给出替代证据（真机挂载 + 宿主 schema 编译 + 重启复核命令） | 不重启 GUI（会杀掉用户会话）、不另起服务（指令禁止） |
| 验收 4「归档会话投递被拒」 | 用真实归档集合验证通过；过程中发现并修复了一个真 bug，副作用如实披露 | 见 4.6 |

---

## 7. 还没被真机覆盖的部分（残余验证缺口）

诚实列出来，供重启后补验：

| 项 | 现状 | 怎么补 |
|---|---|---|
| ~~**web profile** 里恢复带 preset 的会话~~ | **已验证**（3.4 / 4.10）：`presetId=standard`、`presetBefore=presetAfter`、`drift=false`，目标被唤醒并回信 | — |
| ~~`listTools` 里五个工具的完整 schema~~ | **已验证**（3.4）：`fiberPhase: active`，工具表注入 5 个 schema，真机调用成功 | — |
| `session_read` 的非无损 JSON 修复在运行进程里复验 | 修复 + 2 个回归用例已在离线套件通过；运行中的进程仍持有修复前的模块 | 再重启一次 `dsh web`，调 `session_read` 应正常返回 |
| 大会话（10 万级事件）上的 `session_read` 耗时 | 未压测；实现上是「物化一次事件数组 + 取尾部」 | `node scripts/e2e-live.mjs` 之后对一个大会话调 `session_read(limit=20)` 计时 |
| 多进程并发投递给同一个冷会话 | 有 resume 竞态保护（后到者丢弃自己的 handle），单测未覆盖真实并发 | 两个进程同时 `session_send` 给同一个冷会话，看审计里是否只有一条 delivery 成功、另一条复用或明确失败 |
| 修复后的模块在**运行中的 web 进程**里挂载 | 已在本机复刻的真实装配路径上通过（3.3），但运行中的进程还持有旧模块（3.4） | 重启一次 `dsh web`：看 `fiberPhase: active` + `listTools` 出现 5 个工具 |

这些都不影响「装完可用」：失败模式是 fail-closed（拒绝并给原因），不是静默降级。

---

`docs/verification.md` 由 `npm run e2e` 的产物 `e2e-out/e2e-live.json` 支撑，任何人都能重跑复现。
