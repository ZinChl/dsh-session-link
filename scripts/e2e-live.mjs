#!/usr/bin/env node
/**
 * End-to-end proof for dsh-session-link against a REAL DSH process.
 *
 * What it does (each phase prints raw evidence, nothing is summarized away):
 *
 *   phase 1  create a real target session B in a separate DSH process
 *   phase 2  snapshot B's durable capability (preset + model route)
 *   phase 3  drive session A: session_list → session_ask (cold resume → wake)
 *   phase 4  wait for B's reply and assert it arrived, snapshot capability again
 *   phase 5  assert constraint 2 (preset + model unchanged across the resume)
 *   phase 6  print the audit lines for the delivery (delivered → claimed → completed)
 *   phase 7  negative cases: self-send, steer-on-idle, idempotent replay
 *
 * Requirements: a `dsh` executable on PATH, the plugin installed in ${PROFILE}
 * (default `headless`), and a configured model. Everything runs in this
 * workspace; the sessions it creates are removed at the end unless --keep.
 *
 * Usage:
 *   node scripts/e2e-live.mjs [--profile headless] [--dir .] [--keep] [--timeout 180]
 *
 * @module dsh-session-link/scripts/e2e-live
 */
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { capabilityEvidence, readSessionEvents } from './session-log.mjs';

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const PROFILE = flag('profile', process.env.DSH_E2E_PROFILE ?? 'headless');
const WORKDIR = resolve(flag('dir', process.cwd()));
const KEEP = args.includes('--keep');
const TIMEOUT_MS = Number(flag('timeout', '240')) * 1000;
const OUT = join(WORKDIR, 'e2e-out');
const TOKEN = `PONG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const evidence = { token: TOKEN, profile: PROFILE, workdir: WORKDIR, phases: [] };

/** Run one `dsh` task and return its raw stdout/stderr plus parsed NDJSON. */
async function dsh(task, { json = true, patch } = {}) {
  const argv = [`--profile`, PROFILE];
  if (patch !== undefined) argv.push('--patch', patch);
  argv.push('headless');
  if (json) argv.push('--json');
  argv.push(task);
  try {
    const { stdout, stderr } = await run('dsh', argv, { cwd: WORKDIR, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr, code: 0, events: parseNdjson(stdout) };
  } catch (error) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error),
      code: error.code ?? 1,
      events: parseNdjson(error.stdout ?? ''),
    };
  }
}

/** Parse newline-delimited JSON, ignoring non-JSON diagnostics. */
function parseNdjson(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{') !== true) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* mixed logging */
    }
  }
  return out;
}

/** Deep-search a JSON value for the first string that satisfies a predicate. */
function findString(value, predicate, seen = new Set()) {
  if (typeof value === 'string') return predicate(value) ? value : undefined;
  if (value === null || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findString(item, predicate, seen);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  for (const item of Object.values(value)) {
    const hit = findString(item, predicate, seen);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * First regex match found anywhere in a JSON value (ids live inside prose).
 *
 * @param {unknown} value - JSON value.
 * @param {RegExp} pattern - pattern to match.
 * @returns {string|undefined} the first match.
 */
function findMatch(value, pattern) {
  const hits = findAllStrings(value, (candidate) => pattern.test(candidate));
  for (const hit of hits) {
    const match = hit.match(pattern);
    if (match !== null) return match[0];
  }
  return undefined;
}

/** Every string in a JSON value that satisfies a predicate. */
function findAllStrings(value, predicate, out = [], seen = new Set()) {
  if (typeof value === 'string') {
    if (predicate(value)) out.push(value);
    return out;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) findAllStrings(item, predicate, out, seen);
  return out;
}

/**
 * The tool calls and their results of one run, in order — the raw evidence.
 *
 * @param {object[]} events - parsed NDJSON stream.
 * @returns {object[]} `{ tool, input, status, result }` rows.
 */
function toolTraffic(events) {
  const calls = new Map();
  for (const event of events) {
    if (event.type === 'tool_call') calls.set(event.callId, { tool: event.tool, input: event.input, status: undefined, result: undefined });
    if (event.type === 'tool_result') {
      const row = calls.get(event.callId) ?? { tool: '(unknown)', input: undefined };
      row.status = event.status;
      row.result = event.result;
      calls.set(event.callId, row);
    }
  }
  return [...calls.values()];
}

const phase = (title, payload) => {
  evidence.phases.push({ title, ...payload });
  console.log(`\n=== ${title} ===`);
  if (payload.note !== undefined) console.log(payload.note);
  if (payload.stdout !== undefined) console.log(payload.stdout.trim());
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`dsh-session-link end-to-end run — token ${TOKEN}, profile ${PROFILE}, dir ${WORKDIR}`);

  // ---------------------------------------------------------------- phase 1
  const created = await dsh('记住你的代号是 BETA。只回复一句：BETA ready。');
  const sessionB = created.events.find((event) => event.type === 'session')?.sessionId;
  phase('phase 1 · create target session B (separate DSH process)', {
    sessionB,
    exitCode: created.code,
    answer: created.events.find((event) => event.type === 'final')?.text ?? created.stdout.slice(0, 500),
    stderr: created.stderr.slice(0, 2000),
  });
  if (sessionB === undefined) throw new Error('could not determine session B id from the JSON stream');

  // ---------------------------------------------------------------- phase 2
  const before = capabilityEvidence(readSessionEvents(sessionB)?.events ?? []);
  phase('phase 2 · B capability BEFORE (durable record)', { capabilityBefore: before, note: JSON.stringify(before) });

  // ---------------------------------------------------------------- phase 3
  const askTask = [
    `按顺序做三件事，每一步都把工具的**原始返回**贴出来：`,
    `1. 调用 session_list，参数 query="${sessionB}"，确认能看到这个会话（记下它是 live 还是 cold）；`,
    `2. 调用 session_ask，参数 sessionId="${sessionB}"、text="请用一句话回复：${TOKEN}（代号 BETA）。然后用 session_send 把同一句话回给发信方（sessionId 见信封 from 属性，thread 与 replyTo 沿用信封里的值），再用 check_delivery 确认送达。"、waitMs=180000；`,
    `3. 把 session_ask 返回里的 requestId、capability、reply 原样贴出来。`,
    `不要做别的事。`,
  ].join('\n');
  const driver = await dsh(askTask);
  const traffic = toolTraffic(driver.events);
  const requestId = findMatch(traffic, /req_[a-z0-9]{6,}/);
  const threadId = findMatch(traffic, /th_[a-z0-9]{6,}/);
  phase('phase 3 · A drives session_list → session_ask (cold resume + wake)', {
    requestId,
    threadId,
    exitCode: driver.code,
    toolTraffic: traffic,
    stderr: driver.stderr.slice(0, 3000),
  });

  // ---------------------------------------------------------------- phase 4
  let after;
  let replySeen = false;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const log = readSessionEvents(sessionB);
    const events = log?.events ?? [];
    replySeen = events.some(
      (event) =>
        event.type === 'assistant/message' &&
        JSON.stringify(event.data).includes(TOKEN),
    );
    after = capabilityEvidence(events);
    if (replySeen) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
  }
  const log = readSessionEvents(sessionB);
  const envelopes = (log?.events ?? []).filter(
    (event) => event.type === 'user/message' && JSON.stringify(event.data).includes('<agent_message'),
  );
  phase('phase 4 · B was woken and answered', {
    replySeen,
    envelopeCount: envelopes.length,
    lastEnvelope: envelopes.at(-1)?.data?.content?.[0]?.text?.slice(0, 700),
    tail: (log?.events ?? []).slice(-12).map((event) => `#${event.seq} ${event.type}`),
    logout: log?.path,
  });

  // ---------------------------------------------------------------- phase 5
  const samePreset = JSON.stringify(before.headerPreset) === JSON.stringify(after.headerPreset);
  const samePresetEvents = JSON.stringify(before.presetEvents) === JSON.stringify(after.presetEvents);
  const sameModel = before.newestRequest?.model === after.newestRequest?.model;
  const sameProvider = before.newestRequest?.provider === after.newestRequest?.provider;
  phase('phase 5 · constraint 2 — capability unchanged by the resume', {
    capabilityBefore: before,
    capabilityAfter: after,
    verdict: { samePreset, samePresetEvents, sameModel, sameProvider },
    note: `preset ${before.headerPreset ?? '(none)'} → ${after.headerPreset ?? '(none)'}; model ${before.newestRequest?.model} → ${after.newestRequest?.model}`,
  });

  // ---------------------------------------------------------------- phase 6
  const auditFile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'session-link', 'audit.ndjson');
  const audit = await run('sh', ['-c', `grep -F "${requestId ?? '__none__'}" "${auditFile}" | tail -5`], { timeout: 30_000 })
    .then((result) => result.stdout)
    .catch((error) => error.stdout ?? String(error));
  phase('phase 6 · audit lines for this delivery', { requestId, auditFile, stdout: audit });

  // ---------------------------------------------------------------- phase 7
  const negative = await dsh(
    [
      '按顺序做三件事，每步都要贴工具原始返回：',
      '1. 调用 session_list，找到 isSelf=true 的那个会话 id；',
      '2. 调用 session_send，sessionId 用上一步的 id、text="自我测试"，把错误原文贴出来；',
      `3. 调用 session_send，sessionId="${sessionB}"、mode="steer"、text="空闲时你不该收到我"，把错误原文贴出来；`,
      '不要做别的事。',
    ].join('\n'),
  );
  phase('phase 7 · negative cases (self-send, steer-on-idle)', {
    exitCode: negative.code,
    toolTraffic: toolTraffic(negative.events),
    stderr: negative.stderr.slice(0, 2000),
  });

  // ---------------------------------------------------------------- phase 8
  const replay = await dsh(
    `调用 session_send，参数 sessionId="${sessionB}"、text="幂等测试 ${TOKEN}"、requestId="req_e2e_${TOKEN}"，然后把返回原样贴出来；再调用一次**完全相同**的 session_send，把第二次返回原样贴出来。不要做别的事。`,
  );
  phase('phase 8 · idempotent replay of one requestId', {
    exitCode: replay.code,
    toolTraffic: toolTraffic(replay.events),
  });

  evidence.verdict = {
    replySeen,
    constraint2: samePreset && samePresetEvents && sameModel && sameProvider,
    requestId,
    sessionB,
  };
  writeFileSync(join(OUT, 'e2e-live.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  writeFileSync(join(OUT, 'e2e-live.log'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`\n=== summary ===\n${JSON.stringify(evidence.verdict, null, 2)}`);
  console.log(`evidence written to ${join(OUT, 'e2e-live.json')}`);

  if (KEEP !== true && sessionB !== undefined) {
    console.log(`note: keeping session ${sessionB} for inspection; pass --keep to silence this line`);
  }
}

main().catch((error) => {
  console.error(`e2e failed: ${error.stack ?? error}`);
  process.exitCode = 1;
});

void rmSync;
