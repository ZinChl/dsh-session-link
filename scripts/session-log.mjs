#!/usr/bin/env node
/**
 * Read one persisted DSH session log (zstd-compressed, one JSON event per line)
 * without activating the session. Used by the end-to-end scripts and by anyone
 * auditing what a delivery actually did.
 *
 * Usage:
 *   node scripts/session-log.mjs <sessionId> [--json] [--tail N] [--grep TEXT]
 *                               [--capability]
 *
 * Default output is a one-line summary per event. `--capability` prints only
 * the durable capability evidence for constraint 2: the session header's
 * `agentPreset`, every `agent-preset/selected` event, and the newest
 * `request/header` config (provider/model) with its reason.
 *
 * @module dsh-session-link/scripts/session-log
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** zstd frame magic (little-endian 0xFD2FB528). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** $DSH_HOME/sessions, honouring DSH_HOME like the host does. */
function sessionsRoot() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'sessions');
}

/**
 * Locate one session log by id across every workspace-encoded directory.
 *
 * @param {string} sessionId - session id.
 * @returns {string|undefined} absolute log path.
 */
export function findSessionLog(sessionId) {
  const root = sessionsRoot();
  let buckets = [];
  try {
    buckets = readdirSync(root);
  } catch {
    return undefined;
  }
  for (const bucket of buckets) {
    const dir = join(root, bucket, sessionId);
    try {
      if (statSync(dir).isDirectory() !== true) continue;
    } catch {
      continue;
    }
    const candidates = readdirSync(dir).filter((name) => name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl'));
    if (candidates.length === 0) continue;
    candidates.sort();
    return join(dir, candidates[candidates.length - 1]);
  }
  return undefined;
}

/**
 * Decompress a **multi-frame** zstd log.
 *
 * The session log appends one zstd frame per flush, so a single
 * `zstdDecompressSync(file)` silently returns only the first frame's events.
 * Frames are located by their magic number and decoded individually.
 *
 * @param {Buffer} raw - file bytes.
 * @returns {{ text: string, frames: number, failures: number }} decoded text.
 */
export function decompressAllFrames(raw) {
  if (raw.indexOf(ZSTD_MAGIC) !== 0) {
    return { text: raw.toString('utf8'), frames: 0, failures: 0 };
  }
  const offsets = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const at = raw.indexOf(ZSTD_MAGIC, cursor);
    if (at === -1) break;
    offsets.push(at);
    cursor = at + ZSTD_MAGIC.length;
  }
  let text = '';
  let failures = 0;
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index];
    const end = index + 1 < offsets.length ? offsets[index + 1] : raw.length;
    try {
      text += zstdDecompressSync(raw.subarray(start, end)).toString('utf8');
    } catch {
      failures += 1;
    }
  }
  return { text, frames: offsets.length, failures };
}

/**
 * Decode every event of one session log.
 *
 * @param {string} sessionId - session id.
 * @returns {{ path: string, events: object[], frames: number, failures: number }|undefined} decoded log.
 */
export function readSessionEvents(sessionId) {
  const path = findSessionLog(sessionId);
  if (path === undefined) return undefined;
  const raw = readFileSync(path);
  const decoded = path.endsWith('.zstd')
    ? decompressAllFrames(raw)
    : { text: raw.toString('utf8'), frames: 0, failures: 0 };
  const events = [];
  for (const line of decoded.text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      /* torn line */
    }
  }
  return { path, events, frames: decoded.frames, failures: decoded.failures };
}

/** Short human description of one event. */
function summarize(event) {
  const data = event.data ?? {};
  switch (event.type) {
    case 'session':
    case 'session/header':
      return `header v${data.version ?? '?'} cwd=${data.cwd ?? '?'} agentPreset=${data.agentPreset ?? '(none)'}`;
    case 'agent-preset/selected':
      return `agentPreset=${data.agentPreset}`;
    case 'request/header':
      return `reason=${data.reason} provider=${data.header?.config?.provider} model=${data.header?.config?.model}`;
    case 'user/message': {
      const text = (data.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('');
      return `user ${text.length} chars${text.includes('<agent_message') ? ' [session-link envelope]' : ''}: ${text.replace(/\s+/g, ' ').slice(0, 90)}`;
    }
    case 'assistant/message': {
      const text = (data.message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('');
      return `assistant ${text.length} chars: ${text.replace(/\s+/g, ' ').slice(0, 90)}`;
    }
    case 'tool/call':
      return `tool/call ${data.name} ${String(data.arguments ?? '').slice(0, 70)}`;
    case 'tool/result':
      return `tool/result ${data.error === undefined ? 'ok' : `error=${data.error?.code ?? data.error?.name}`}`;
    case 'turn/end':
      return `turn/end reason=${data.reason?.kind ?? JSON.stringify(data.reason)}`;
    default:
      return event.type;
  }
}

/**
 * The capability evidence for one session (constraint 2).
 *
 * @param {object[]} events - decoded events.
 * @returns {object} capability evidence.
 */
export function capabilityEvidence(events) {
  const header = events.find((event) => event.type === 'session' || event.type === 'session/header')?.data;
  const presets = events.filter((event) => event.type === 'agent-preset/selected').map((event) => event.data.agentPreset);
  const headers = events.filter((event) => event.type === 'request/header');
  const newest = headers[headers.length - 1];
  return {
    headerPreset: header?.agentPreset ?? null,
    presetEvents: presets,
    newestRequest: newest === undefined
      ? null
      : {
          seq: newest.seq,
          reason: newest.data?.reason,
          provider: newest.data?.header?.config?.provider,
          model: newest.data?.header?.config?.model,
        },
    requestHeaderCount: headers.length,
  };
}

function main() {
  const [sessionId, ...rest] = process.argv.slice(2);
  if (sessionId === undefined) {
    console.error('usage: node scripts/session-log.mjs <sessionId> [--json] [--tail N] [--grep TEXT] [--capability]');
    process.exitCode = 2;
    return;
  }
  const log = readSessionEvents(sessionId);
  if (log === undefined) {
    console.error(`no persisted log found for ${sessionId} under ${sessionsRoot()}`);
    process.exitCode = 1;
    return;
  }
  const json = rest.includes('--json');
  const capability = rest.includes('--capability');
  const tailIndex = rest.indexOf('--tail');
  const tail = tailIndex === -1 ? Number.POSITIVE_INFINITY : Number(rest[tailIndex + 1] ?? 20);
  const grepIndex = rest.indexOf('--grep');
  const grep = grepIndex === -1 ? undefined : rest[grepIndex + 1];

  if (capability) {
    console.log(JSON.stringify(capabilityEvidence(log.events), null, 2));
    console.log(`log: ${log.path}`);
    return;
  }
  const selected = grep === undefined ? log.events : log.events.filter((event) => JSON.stringify(event).includes(grep));
  const window = Number.isFinite(tail) ? selected.slice(-tail) : selected;
  for (const event of window) {
    if (json) console.log(JSON.stringify(event));
    else {
      const at = Number.isFinite(event.time) ? new Date(event.time).toISOString() : '-';
      console.log(`#${event.seq ?? '-'} ${at} ${summarize(event)}`);
    }
  }
  console.error(
    `${selected.length} event(s) matched, showing ${window.length}; ${log.frames} zstd frame(s), ${log.failures} undecodable; log: ${log.path}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
