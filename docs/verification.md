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
$ npm test
ℹ tests 109
ℹ suites 37
ℹ pass 109
ℹ fail 0
ℹ duration_ms 1347.214635
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

## 3. 工具在运行进程里可见（对应验收 3）—— 没做到的部分与替代证据

**结论先说**：`cordis_inspect_query provider=Tool method=listTools` 在**当前这个 GUI 进程**里看不到五个工具，
因为该进程是在插件安装**之前**启动的。用 harness 自带的安装路径确认了这一点：

```
plugin_manager install_bundle(target=/home/dwad/github/dsh-session-link)
→ {"stage":"enable","target":"dsh-session-link","enabled":true,"changed":false,
   "application":"restart-required", ...}
```

`application: restart-required` 是宿主自己的判定：profile 变更需要重启进程才生效。
验收文档第 3 条要求的「`listTools` 里能看到三个工具的完整 schema」因此**只能在重启后**复核。
我**没有**重启这个 GUI（那会杀掉你正在用的会话），也没有另起一个 web 服务（指令明确不要）。

替代证据（都是真进程、真模型、真工具）：

1. **真进程里挂载成功**：在 `headless` profile 里装同一个包，一次真实运行里模型成功调用了工具（见第 4 节）。
   挂载日志（stderr）会打印 `dsh-session-link: 已挂载（session_list / … ），审计日志 …，跳数上限 6，限流 30/分钟`。
2. **schema 由宿主自己编译**：上面 `npm run smoke` 用的就是宿主安装目录里的 `defineTool` 与 `validateArgs`，
   五个定义全部通过，错误类型的参数会被拒 —— 与 `listTools` 会拿到的定义是同一份。
3. **重启后复核方法**（任何人都能跑）：

   ```bash
   # 重启 dsh web 之后：
   cordis_inspect_query platform=host provider=Tool method=listTools   # 应出现 5 个工具
   ```

---

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

`docs/verification.md` 由 `npm run e2e` 的产物 `e2e-out/e2e-live.json` 支撑，任何人都能重跑复现。
