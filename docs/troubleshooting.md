# 排错

## 工具根本不在我的工具表里

1. 确认包进了 profile 的**两处**（`dsh plugin add` 偶发只写一处）：
   ```bash
   node -e "const p=require(process.env.HOME+'/.dsh/profiles/web/package.json');
   console.log(p.dependencies['dsh-session-link'], p.dsh.profile.bundles.includes('dsh-session-link'))"
   ```
   两处都对了还看不到 → 重启 `dsh web`。profile 变更对**已启动**的进程不生效；
   `plugin_manager install_bundle` 在这种情况下会明确返回 `application: "restart-required"`。
2. 看启动日志里有没有 `dsh-session-link: 已挂载（…）`。没有这行说明插件本身没能挂载：
   - `dsh: warning: N entry did not activate` + 具体条目名 → 该行加载失败，通常是同名 row 冲突或路径不对；
   - 用 `--patch` 叠加时 `name` 必须是可解析的**包名**（装进 profile）或**绝对路径**（但绝对路径下
     `@deepseek-ai/dsh-tools` 这类裸导入可能解析不到，见下一条）。

## 重启后工具还是没出现：看 fiberPhase

`plugin_manager list_plugins` 里找到那一行（`patchId: dsh-session-link`）：

| fiberPhase | 含义 | 处理 |
|---|---|---|
| `active` | 已挂载 | 工具没出现就是作用域/重名问题，看下面两条 |
| `failed` | `apply` 抛错了 | 用 `plugin_manager set_plugin` 关一次再开，返回的 `error.diagnostic` 就是原始堆栈 |

2026-10-12 真实撞到过一次 `failed`：宿主 `defineTool` **原地改写** options，
定义被编译两次 → `JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object`。
教训：任何"编译一次"的宿主 API，都要按"入参会被吃掉"来写（`createToolOptions` / `createToolDefinitions` 现在就是这个分工）。

**注意**：改完代码不代表运行中的进程会换新代码。Cordis 会缓存已 import 的模块，
且 HMR 不监听 `link:` 依赖（本插件的安装形态就是 link）。所以修完必须**重启 dsh**；
`plugin_manager` 的关/开只会用缓存里的旧模块重跑 `apply`。

## 设置页（Plugins → dsh-session-link）里没有可编辑项

宿主**只为带 `meta.volatile` 的 Config 字段**建设置命名空间（`dsh-settings` 的
`volatileForm()` 只投影这类字段；一个都没有的条目**根本不进**命名空间列表）。排查顺序：

1. **进程比代码旧**（最常见）：Cordis 缓存已 import 的模块，改完 `lib/` 必须重启 `dsh`，
   刷新页面不够。先比时间：
   ```bash
   ps -o lstart=,args= -p "$(pgrep -f 'dsh web' | head -1)"   # 进程启动时间
   stat -c '%y %n' lib/config.js                              # 代码改动时间
   ```
2. **字段没被标记**：`Config` 的字段必须经 `markEditable()`（内部走 fork 的 `.volatile()`，
   npm `schemastery` 没有这个方法时直接写 `meta.volatile`）。自检：
   ```bash
   node -e "const s=await import('./lib/config.js');const c=await s.createConfigSchema();
   console.log(Object.entries(c.dict).filter(([,f])=>f.meta.volatile).map(([k])=>k))" --input-type=module
   ```
3. **条目不在/被禁用**：`~/.dsh/profiles/<profile>/cordis.patch.yml` 里要有
   `- id: dsh-session-link` 且 `disabled` 不为 `true`（`plugin_manager list_plugins` 会给出 `fiberPhase`）。
4. **宿主那句话到底看到了什么**：用巡检工具看宿主投影出来的 JSON Schema，
   volatile 字段会带 `x-cordis: { volatile: true }`（`session-log-deepseek` 的 `enabled` 就是这样）：

   `cordis_inspect_query(platform="host", provider="Config", method="listConfigs", input={entry:"include:dsh-session-link"})`

   > `entry` 要用**加载器条目 id**（`include:<patchId>`），而设置命名空间用的是 `patchId`，两者不同。

### 一条命令验证「新进程会不会给设置页」

不用浏览器、也不用先重启你正在用的进程 —— 起一个**临时新进程**，让宿主自己的 settings 服务回答：

```bash
npm run probe:settings              # 只读：命名空间在不在、可编辑字段是哪些、当前值
npm run probe:settings -- --write   # 再走一次真实写入 + 回滚（验证保存路径）
```

它把一个一次性 overlay 插件塞进 `dsh --profile headless --patch <临时文件>`（不写 prompt、不调模型），
让那个进程里的 `ctx.settings.describe()` 汇报本插件条目，然后删掉临时文件。2026-10-12 的真机输出：

```text
probe: namespaces        …, agent-loop, llm-deepseek, dsh-session-link
probe: dsh-session-link   PRESENT
probe: editable fields   maxHops, rateLimitPerMinute, dedupeWindowMs, verifyCapability, maxTextChars, auditFile
probe: write test        maxHops → 7 (revision 1)      # --write
probe: reverted to       6
probe: non-editable field refused: Config field "readDefaultLimit" is not volatile
```

写测试会在探查用的 profile 里留下这个条目的 `config:` 块（Web UI 保存也是同样写法，那是**宿主**在写，
不是插件）。所以 `--write` 默认关闭，且只用一次性 profile 跑。

## 用 `--patch` 指向绝对路径时 `failed to import`

插件的裸导入（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`）由**宿主**在 profile 安装位置解析。
从任意目录 `--patch` 一个绝对路径的入口时，Node 会按那个文件的位置向上找 `node_modules`，找不到就报错。

正解：把包装进 profile（`dsh plugin --profile X add <路径或 github:…>`），
`examples/patch-abs.yml` 只在**已经装过**的 profile 里可用（那时软链已存在）。

## 故意制造的错误：`pnpm` 卡住 / 半成品

`dsh plugin add` 底层是 pnpm。若中断，可能出现「依赖写了、bundles 没写」或反过来的半成品：

```bash
# 1) 看两处是否一致（上面第一条命令）
# 2) 不一致时先移除
dsh plugin --profile web remove dsh-session-link
# 3) 清掉残留投影
rm -f ~/.dsh/profiles/web/node_modules/dsh-session-link
# 4) 重装
dsh plugin --profile web add /path/to/dsh-session-link
```

**已知残留**：`dsh plugin remove` 不会删除 `node_modules/<包名>` 这个软链（依赖与 bundles 已清干净）。
手工删即可，不影响仓库本体。

## 投递被拒：怎么快速定位

`check_delivery(requestId="req_…")` 会给状态与时间线；拒绝码含义见 [protocol.md](protocol.md#5-拒绝码对外契约)。
也可以直接看审计：

```bash
grep -F "req_xxx" ~/.dsh/session-link/audit.ndjson
```

| 现象 | 原因 / 处理 |
|---|---|
| `TARGET_ARCHIVED` | 目标已归档。先在 Web UI 取消归档，或在别的会话里 `unarchiveSession` |
| `TARGET_NOT_RUNNING` | `steer`/`inject` 需要目标正在跑；改用 `mode="followup"` |
| `CAPABILITY_DRIFT` | 恢复会改变目标的 preset/模型，或目标的 preset 在当前部署里解析不了 —— 这是**保护**，不是故障。检查目标会话是不是在别的 profile/插件集下创建的 |
| `HOP_BUDGET_EXHAUSTED` | 两个会话互相回信到了上限（默认 6 跳）。确认不是自激循环；必要时提高 `maxHops` |
| `RATE_LIMITED` | 每对会话 12 条/分钟。等一分钟或调 `rateLimitPerMinute` |
| `SERVICE_UNAVAILABLE` / `QUERY_FAILED` | 宿主缺 `sessionQuery`/`agents`（例如裁剪过的 profile），或索引后端故障 |

## 目标被唤醒了但看起来「没干活」

1. 用 `session_read(sessionId=目标)` 看信封是否真的进去了（会标 `[link]`）；
2. 用 `node scripts/session-log.mjs <sessionId> --tail 30` 看它的原始事件，特别是 `turn/end` 的 `reason`：
   - `error` + `working-directory: directory does not exist` → 目标会话的 cwd 已不存在（老会话常见）；
   - `blocked` → 该会话被归档门挡住（UI 里已归档）；
   - `completed` 但没有 assistant 文本 → 模型只调了工具或直接结束。
3. 冷会话恢复失败时审计里有 `kind:"refusal"` + `DELIVERY_FAILED` 行，message 就是宿主的原因。

## 回执查不到 / 状态停在 delivered

- 回执**只在审计文件里**：`~/.dsh/session-link/audit.ndjson`。删了文件（或轮转走了）就查不到；
- `claimed` 需要目标真的把信领取进模型上下文（宿主发 `agent/inbox/claimed`）。目标没领取时停在 `delivered` 是正确的；
- `completed` 依赖目标回合结束；进程重启后 `claimed` 之后的状态可能只剩落盘的那部分；
- 想知道「对方有没有回」用 `session_read(目标)` 看 `[link]` 信封和 assistant 消息，比回执更直接。

## 读会话日志（zstd 多帧）

DSH 的会话日志是 **zstd 多帧**（每次 flush 追加一帧）。用 `zlib.zstdDecompressSync(整个文件)` 只能解出**第一帧**，
看起来就是「日志里只有一行 header」。本仓库提供了解多帧的读取器：

```bash
node scripts/session-log.mjs <sessionId> --tail 30
node scripts/session-log.mjs <sessionId> --grep agent_message --json
node scripts/session-log.mjs <sessionId> --capability     # preset / 模型路由取证
```

## 我怀疑是被插件改坏了 profile

每次安装前都会留备份（带时间戳）：

```bash
ls ~/.dsh/profiles/web/*.bak-*
# 回滚
cp ~/.dsh/profiles/web/package.json.bak-sessionlink-<ts> ~/.dsh/profiles/web/package.json
cp ~/.dsh/profiles/web/cordis.patch.yml.bak-sessionlink-<ts> ~/.dsh/profiles/web/cordis.patch.yml
```

本插件**不会**写 profile 的任何文件：它只在 `dsh plugin add/remove` 触发的 pnpm 流程里被写进依赖与 bundles，
其余状态都在 `~/.dsh/session-link/` 与你配置的 `auditFile` 里。
