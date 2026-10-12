# dsh-session-link

**Cross-session messaging for DeepSeek Harness** — let sessions in one DSH process read each other and hand work over,
**without changing the target's agent preset or model**.

[中文说明 → README.md](README.md)

> ⚠️ An unrelated npm package named `dsh-session-link` exists (session deep links, by PwnKY). This project is **not**
> published to npm; install it from GitHub.

## Tools

| Tool | What it does |
|---|---|
| `session_list` | List **existing** sessions: id, title, cwd, live, running, archived, last activity, agent preset |
| `session_read` | Read a bounded read-only transcript tail (session-link envelopes are tagged) |
| `session_send` | Deliver a message to an existing session and wake it (`followup` / `steer` / `inject`) |
| `session_ask` | Deliver and **wait for that session's reply** (session-to-session RPC) |
| `check_delivery` | Receipt by `requestId`: delivered → claimed → completed, or why it was refused |

## Install

```bash
dsh plugin --profile web add github:ZinChl/dsh-session-link
# restart dsh so the profile change takes effect
dsh web
```

Every session in the profile gets the tools automatically (the bundle patch inserts at the profile root);
no agent preset is modified.

## What it guarantees

1. **Never creates a session** — read existing + write existing only.
2. **Never changes the target's capability set** — a cold target is resumed with `agentOptions`/`setup`
   reconstructed from *its own durable record*; a capability probe before/after refuses and rolls back on any drift,
   and an unresolvable preset is refused rather than downgraded.
3. **Archived sessions are refused and never woken**; self-send is refused.
4. **Same process only** — no network transport.
5. **Untrusted content stays untrusted** — every delivery is wrapped in a sanitized `<agent_message>` boundary
   (SLEP v1) with thread, hop budget and reply instructions.
6. **Idempotent, rate limited, audited** — one NDJSON line per decision, receipts replayed from the same file.

See [docs/protocol.md](docs/protocol.md) for the envelope protocol and [docs/verification.md](docs/verification.md)
for the end-to-end evidence (real process, real model, real sessions).

## Develop

```bash
npm test          # 109 offline unit tests (node --test, zero runtime dependencies)
npm run smoke     # compile the tool definitions with the host's own defineTool/validateArgs
npm run e2e       # real end-to-end run (needs the plugin installed in the headless profile)
```

## License

MIT © dw0x
