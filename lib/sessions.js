/**
 * Read side of the plugin: enumerate existing sessions, read a bounded
 * transcript, resolve a target, and probe a session's *capability* (agent
 * preset + model route).
 *
 * Everything here is defensive: a missing service, a failed persistence read
 * or a corrupt log degrades into a structured note (`degraded`) or a
 * {@link LinkError}, never a bare exception (constraint 10).
 *
 * @module dsh-session-link/sessions
 */
import { CODE, LinkError, describeError } from './errors.js';
import { looksLikeLinkMessage } from './envelope.js';

/** Optional services this module can use, resolved per call so a late mount works. */
export function hostServices(ctx) {
  return {
    agents: ctx.get('agents'),
    sessions: ctx.get('sessions'),
    sessionQuery: ctx.get('sessionQuery'),
    sessionController: ctx.get('sessionController'),
    workspaceRegistry: ctx.get('workspaceRegistry'),
  };
}

/**
 * The registry-global archived session set.
 *
 * Archive state lives in the durable workspace registry (a single global set,
 * `WorkspaceRegistry.archivedSessionIds`), not in the session header — so this
 * is the only authoritative source for constraint 3.
 *
 * @param {object} ctx - plugin context.
 * @returns {Set<string>} archived session ids.
 */
export function archivedSessionIds(ctx) {
  const registry = ctx.get('workspaceRegistry');
  const ids = new Set();
  if (registry === undefined) return ids;
  try {
    for (const id of registry.archivedSessionIds ?? []) ids.add(String(id));
  } catch {
    // A registry that cannot answer must not block delivery; unrestricted is
    // the old behaviour, and the empty set is visibly reported by session_list.
  }
  return ids;
}

/**
 * Fold titles for a bounded set of sessions.
 *
 * @param {object} ctx - plugin context.
 * @param {string[]} ids - session ids.
 * @returns {Promise<Map<string, { title: string, updatedAt: number }>>} title map.
 */
async function titlesFor(ctx, ids) {
  const titles = new Map();
  const query = ctx.get('sessionQuery');
  if (query === undefined || ids.length === 0) return { titles };

  // Preferred path: one batched fold for every requested id.
  if (typeof query.readTitleSnapshots === 'function') {
    try {
      const results = await query.readTitleSnapshots(ids);
      for (const result of results ?? []) {
        if (result?.status !== 'fulfilled') continue;
        const title = result.title?.title;
        if (typeof title === 'string' && title !== '') {
          titles.set(String(result.sessionId), { title, updatedAt: result.title.updatedAt ?? 0 });
        }
      }
      if (titles.size > 0) return { titles };
    } catch (error) {
      // Fall through to the per-session path, and report why in `degraded`.
      return await titlesOneByOne(ctx, ids, describeError(error, CODE.QUERY_FAILED).message);
    }
  }
  // Batch unavailable or empty (some backends fail the whole batch when a
  // single id cannot be resolved): read titles one by one instead.
  return await titlesOneByOne(ctx, ids);
}

/**
 * Per-session title fallback.
 *
 * @param {object} ctx - plugin context.
 * @param {string[]} ids - session ids.
 * @param {string} [reason] - why the batch path was skipped (reported as degraded).
 * @returns {Promise<{ titles: Map<string, object>, error?: string }>} result.
 */
async function titlesOneByOne(ctx, ids, reason) {
  const titles = new Map();
  const query = ctx.get('sessionQuery');
  if (query === undefined || typeof query.readTitle !== 'function') return { titles, error: reason };
  let failures = 0;
  for (const id of ids) {
    try {
      const snapshot = await query.readTitle(id);
      if (typeof snapshot?.title === 'string' && snapshot.title !== '') {
        titles.set(String(id), { title: snapshot.title, updatedAt: snapshot.updatedAt ?? 0 });
      }
    } catch {
      failures += 1;
    }
  }
  // Always explain WHY the list had to fall back: a silently empty batch was a
  // real backend behaviour we hit live (single reads worked, the batch did not).
  const note =
    reason === undefined
      ? `批量标题无结果，已逐个读取${failures > 0 ? `，其中 ${failures} 个失败` : ''}`
      : `批量标题失败（${reason}），已逐个读取${failures > 0 ? `，其中 ${failures} 个失败` : ''}`;
  return { titles, error: note };
}

/**
 * List existing sessions.
 *
 * Preferred source is the Session controller's list projection (it owns
 * `updatedAt`, `running` and `agentAvailable` and is cold-safe); the query
 * service supplies the durable header (cwd/preset) and titles. When the
 * controller is absent the query corpus is used instead.
 *
 * @param {object} ctx - plugin context.
 * @param {object} options - query options.
 * @param {string} [options.query] - case-insensitive title substring filter.
 * @param {number} [options.limit] - rows to return.
 * @param {boolean} [options.includeArchived] - include archived sessions.
 * @param {string} [options.selfId] - caller session id (flagged, never hidden).
 * @param {number} [options.titleScanLimit] - how many newest sessions get titles.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @returns {Promise<{ rows: object[], total: number, truncated: boolean, degraded: string[] }>} list result.
 */
export async function listSessions(ctx, options = {}) {
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 20)));
  const titleScanLimit = Math.max(limit, Math.min(1000, Math.trunc(options.titleScanLimit ?? 200)));
  const degraded = [];
  const { sessionQuery, sessionController } = hostServices(ctx);
  const archived = archivedSessionIds(ctx);

  /** @type {Map<string, object>} */
  const rows = new Map();

  if (sessionController !== undefined && typeof sessionController.list === 'function') {
    try {
      const value = await sessionController.list({}, options.signal);
      for (const item of value?.items ?? []) {
        rows.set(String(item.sessionId), {
          sessionId: String(item.sessionId),
          cwd: item.cwd,
          updatedAt: item.updatedAt,
          createdAt: undefined,
          live: item.agentAvailable === true,
          running: item.running === true,
          available: item.agentAvailable === true,
          blank: item.blank === true,
          parentSessionId: item.parentSessionId === undefined ? undefined : String(item.parentSessionId),
        });
      }
    } catch (error) {
      degraded.push(`sessionController.list 失败：${describeError(error, CODE.QUERY_FAILED).message}`);
    }
  }

  if (sessionQuery !== undefined && typeof sessionQuery.listSessions === 'function') {
    try {
      const records = await sessionQuery.listSessions(options.signal);
      for (const record of records ?? []) {
        const id = String(record?.header?.id ?? '');
        if (id === '') continue;
        const existing = rows.get(id);
        const header = record.header ?? {};
        if (existing === undefined) {
          rows.set(id, {
            sessionId: id,
            cwd: header.cwd,
            createdAt: header.createdAt,
            updatedAt: header.createdAt,
            live: record.live === true,
            running: false,
            available: record.live === true,
            persisted: record.persisted === true,
          });
        } else {
          existing.createdAt = header.createdAt;
          existing.persisted = record.persisted === true;
          existing.cwd = existing.cwd ?? header.cwd;
        }
        const row = rows.get(id);
        row.agentPreset = header.agentPreset;
        row.persisted = row.persisted ?? record.persisted === true;
      }
    } catch (error) {
      degraded.push(`sessionQuery.listSessions 失败：${describeError(error, CODE.QUERY_FAILED).message}`);
      if (rows.size === 0) {
        throw new LinkError(
          CODE.QUERY_FAILED,
          `会话列表不可用：${describeError(error, CODE.QUERY_FAILED).message}`,
        );
      }
    }
  } else if (rows.size === 0) {
    degraded.push('ctx.sessionQuery 与 ctx.sessionController 都不可用，无法枚举已有会话');
    throw new LinkError(CODE.SERVICE_UNAVAILABLE, '宿主没有提供会话列表能力（sessionQuery/sessionController 均缺失）');
  }

  const agents = ctx.get('agents');
  for (const row of rows.values()) {
    const agent = agents?.get?.(row.sessionId);
    if (agent !== undefined) {
      row.live = true;
      row.available = true;
      row.running = agent.status === 'running';
      row.agentPreset = agent.session?.header?.agentPreset ?? row.agentPreset;
      row.cwd = agent.session?.header?.cwd ?? row.cwd;
    }
    row.archived = archived.has(row.sessionId);
    row.isSelf = options.selfId !== undefined && row.sessionId === String(options.selfId);
  }

  const all = [...rows.values()];
  const titleTargets = all
    .filter((row) => options.query === undefined || options.query === '')
    .slice(0, titleScanLimit)
    .map((row) => row.sessionId);
  const fallbackTargets = all
    .filter((row) => options.query !== undefined && options.query !== '')
    .slice(0, titleScanLimit)
    .map((row) => row.sessionId);
  const titleResult = await titlesFor(ctx, [...new Set([...titleTargets, ...fallbackTargets])]);
  const titles = titleResult.titles;
  for (const row of all) {
    const snapshot = titles.get(row.sessionId);
    if (snapshot !== undefined) {
      row.title = snapshot.title;
      if (Number.isFinite(snapshot.updatedAt) && snapshot.updatedAt > (row.updatedAt ?? 0)) {
        row.updatedAt = Math.max(row.updatedAt ?? 0, snapshot.updatedAt);
      }
    }
  }
  if (titles.size === 0 && all.length > 0) {
    degraded.push(
      titleResult.error === undefined
        ? '会话标题不可用（ctx.sessionQuery.readTitleSnapshots 与 readTitle 都无结果），按 id 展示'
        : `会话标题不可用：${titleResult.error}`,
    );
  } else if (titleResult.error !== undefined) {
    degraded.push(titleResult.error);
  }

  const needle = (options.query ?? '').trim().toLowerCase();
  let filtered = all;
  if (needle !== '') {
    filtered = all.filter((row) => {
      const title = String(row.title ?? '').toLowerCase();
      const cwd = String(row.cwd ?? '').toLowerCase();
      const id = row.sessionId.toLowerCase();
      return title.includes(needle) || cwd.includes(needle) || id.includes(needle);
    });
  }
  if (options.includeArchived !== true) {
    const kept = filtered.filter((row) => row.archived !== true);
    if (kept.length !== filtered.length) {
      degraded.push(`已隐藏 ${filtered.length - kept.length} 个归档会话（includeArchived=true 可查看）`);
    }
    filtered = kept;
  }
  filtered.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));

  return {
    rows: filtered.slice(0, limit),
    total: filtered.length,
    truncated: filtered.length > limit,
    degraded,
  };
}

/**
 * Open one observation lease and derive both header and latest request route.
 *
 * @param {object} ctx - plugin context.
 * @param {string} sessionId - session id.
 * @returns {Promise<{ header: object, events: readonly object[], live: boolean, dispose: Function }>} lease.
 */
async function observe(ctx, sessionId) {
  const sessionQuery = ctx.get('sessionQuery');
  if (sessionQuery !== undefined && typeof sessionQuery.observeSession === 'function') {
    let lease;
    try {
      lease = await sessionQuery.observeSession(sessionId, { projectionMode: 'none' });
    } catch (error) {
      throw new LinkError(
        CODE.TARGET_NOT_FOUND,
        `读取会话 ${sessionId} 失败（可能不存在或索引后端故障）：${describeError(error, CODE.QUERY_FAILED).message}`,
      );
    }
    return {
      header: lease.header,
      events: lease.events,
      live: lease.source === 'live',
      dispose: () => {
        try {
          lease.dispose();
        } catch {
          /* lease already released */
        }
      },
    };
  }
  if (sessionQuery !== undefined && typeof sessionQuery.readSession === 'function') {
    const snapshot = await sessionQuery.readSession(sessionId);
    return { header: snapshot.session, events: snapshot.events, live: false, dispose: () => {} };
  }
  const sessions = ctx.get('sessions');
  const session = sessions?.get?.(sessionId);
  if (session !== undefined) {
    return { header: session.header, events: session.snapshotEvents(), live: true, dispose: () => {} };
  }
  throw new LinkError(CODE.SERVICE_UNAVAILABLE, '宿主没有提供读取会话内容的服务（sessionQuery/sessions 均缺失）');
}

/**
 * Read one session's durable capability: agent preset plus the newest model route.
 *
 * "Capability" is exactly what must NOT change when this plugin wakes a cold
 * session: the durable `agentPreset` header field and the provider/model the
 * session last ran with.
 *
 * @param {object} ctx - plugin context.
 * @param {string} sessionId - session id.
 * @returns {Promise<object>} capability probe result.
 */
export async function probeCapability(ctx, sessionId) {
  const sessions = ctx.get('sessions');
  const live = sessions?.get?.(sessionId);
  if (live !== undefined) {
    const context = typeof live.requestContext === 'function' ? live.requestContext() : undefined;
    let newestPreset;
    for (const event of live.snapshotEvents()) {
      if (event.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
        newestPreset = event.data.agentPreset;
      }
    }
    return {
      source: 'live',
      live: true,
      agentPreset: live.header?.agentPreset,
      presetEvent: newestPreset,
      presetCurrent: newestPreset ?? live.header?.agentPreset,
      provider: context?.provider,
      model: context?.model,
      reasoningEffort: context?.reasoningEffort,
      eventSeq: undefined,
    };
  }

  const lease = await observe(ctx, sessionId);
  try {
    const events = lease.events ?? [];
    let requestHeader;
    let presetEvent;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (requestHeader === undefined && event.type === 'request/header') requestHeader = event;
      if (presetEvent === undefined && event.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
        presetEvent = event.data.agentPreset;
      }
      if (requestHeader !== undefined && presetEvent !== undefined) break;
    }
    const config = requestHeader?.data?.header?.config;
    return {
      source: 'persisted',
      live: false,
      agentPreset: lease.header?.agentPreset,
      presetEvent,
      presetCurrent: presetEvent ?? lease.header?.agentPreset,
      provider: config?.provider,
      model: config?.model,
      reasoningEffort: config?.reasoningEffort,
      headerReason: requestHeader?.data?.reason,
      eventSeq: requestHeader?.seq,
    };
  } finally {
    lease.dispose();
  }
}

/**
 * Resolve a delivery target from an exact id or a title.
 *
 * @param {object} ctx - plugin context.
 * @param {object} options - resolution options.
 * @param {string} [options.sessionId] - exact id.
 * @param {string} [options.title] - title substring.
 * @param {string} [options.selfId] - caller id.
 * @returns {Promise<{ sessionId: string, title?: string }>} resolved target.
 */
export async function resolveTarget(ctx, options) {
  const explicit = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
  if (explicit !== '') return { sessionId: explicit };

  const title = typeof options.title === 'string' ? options.title.trim() : '';
  if (title === '') throw new LinkError(CODE.TARGET_REQUIRED, '必须提供 sessionId 或 title');

  const result = await listSessions(ctx, {
    query: title,
    limit: 20,
    includeArchived: true,
    selfId: options.selfId,
    titleScanLimit: 500,
  });
  const exact = result.rows.filter((row) => String(row.title ?? '').toLowerCase() === title.toLowerCase());
  const candidates = exact.length > 0 ? exact : result.rows;
  if (candidates.length === 0) {
    throw new LinkError(CODE.TARGET_NOT_FOUND, `没有标题匹配「${title}」的会话`, { query: title });
  }
  if (candidates.length > 1) {
    throw new LinkError(CODE.TARGET_AMBIGUOUS, `标题「${title}」匹配到 ${candidates.length} 个会话，请改用 sessionId`, {
      candidates: candidates.slice(0, 5).map((row) => ({ sessionId: row.sessionId, title: row.title ?? null })),
    });
  }
  return { sessionId: candidates[0].sessionId, title: candidates[0].title };
}

/** Roles rendered by {@link readTranscript}. */
const RENDERED = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result']);

/**
 * Concatenate the text blocks of one message payload.
 *
 * @param {unknown} content - ContentBlock[] (or a single block).
 * @returns {string} joined text.
 */
function textOf(content) {
  const blocks = Array.isArray(content) ? content : [content];
  let out = '';
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += block.text;
    }
  }
  return out;
}

/** Truncate to `max` code points with an explicit marker. */
function clip(text, max) {
  const chars = [...String(text ?? '')];
  if (chars.length <= max) return { text: String(text ?? ''), clipped: false };
  return { text: `${chars.slice(0, max).join('')}…[+${chars.length - max}]`, clipped: true };
}

/**
 * Read a bounded transcript tail from an existing session.
 *
 * @param {object} ctx - plugin context.
 * @param {object} options - read options.
 * @param {string} options.sessionId - session id.
 * @param {number} [options.limit] - number of rendered entries (default 20).
 * @param {number} [options.maxChars] - per-entry character cap.
 * @returns {Promise<object>} transcript result.
 */
export async function readTranscript(ctx, options) {
  const limit = Math.max(1, Math.min(400, Math.trunc(options.limit ?? 20)));
  const maxChars = Math.max(80, Math.min(20000, Math.trunc(options.maxChars ?? 1200)));
  const sessionId = String(options.sessionId);
  const degraded = [];

  const lease = await observe(ctx, sessionId);
  try {
    const events = lease.events ?? [];
    /** @type {object[]} */
    const rendered = [];
    for (const event of events) {
      const type = event?.type;
      if (RENDERED.has(type) !== true) continue;
      const data = event.data ?? {};
      if (type === 'tool/call') {
        const args = clip(String(data.arguments ?? ''), Math.min(maxChars, 400));
        rendered.push({
          seq: Number(event.seq ?? 0),
          role: 'tool-call',
          time: event.time,
          name: String(data.name ?? ''),
          text: args.text,
        });
        continue;
      }
      const message = type === 'assistant/message' ? data.message : type === 'tool/result' ? data.message : data;
      const raw = textOf(message?.content);
      if (raw === '' && type === 'tool/result') {
        rendered.push({ seq: Number(event.seq ?? 0), role: 'tool-result', time: event.time, text: raw });
        continue;
      }
      if (raw === '') continue;
      const body = clip(raw, maxChars);
      const role = type === 'user/message' ? 'user' : type === 'assistant/message' ? 'assistant' : 'tool-result';
      const entry = { seq: Number(event.seq ?? 0), role, time: event.time, text: body.text };
      if (looksLikeLinkMessage(raw)) entry.kind = 'session-link';
      if (data.error !== undefined) entry.error = true;
      if (data.interrupted === true) entry.interrupted = true;
      rendered.push(entry);
    }

    const tail = rendered.slice(-limit);
    const self = hostServices(ctx).agents?.get?.(sessionId);
    return {
      sessionId,
      cwd: lease.header?.cwd,
      createdAt: lease.header?.createdAt,
      agentPreset: lease.header?.agentPreset ?? self?.session?.header?.agentPreset,
      live: lease.live,
      running: self?.status === 'running',
      archived: archivedSessionIds(ctx).has(sessionId),
      totalEvents: events.length,
      totalEntries: rendered.length,
      returned: tail.length,
      truncated: rendered.length > tail.length,
      messages: tail,
      degraded,
    };
  } finally {
    lease.dispose();
  }
}
