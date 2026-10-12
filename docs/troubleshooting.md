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
