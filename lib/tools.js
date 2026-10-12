/**
 * Model-facing tools.
 *
 * Five tools, all named `session_*`/`check_delivery`:
 *  - `session_list`    — enumerate *existing* sessions (never creates one),
 *  - `session_read`    — bounded read-only transcript snapshot,
 *  - `session_send`    — deliver one message to an existing session,
 *  - `session_ask`     — deliver and wait for that session's reply (RPC),
 *  - `check_delivery`  — receipt lookup by requestId.
 *
 * `defineTool` / `createUserMessage` are injected instead of imported so the
 * whole tool layer is unit-testable without a host installation.
 *
 * `createToolOptions` returns the raw option objects; `createToolDefinitions`
 * compiles them with the host's `defineTool` (exactly once per object, because
 * that call mutates its input).
 *
 * @module dsh-session-link/tools
 */
import { CODE } from './errors.js';
import { listSessions, readTranscript } from './sessions.js';

/** Drop `undefined`/`null` members so a strict output schema always validates. */
function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

/** ISO string for an epoch-ms value, when it is a usable number. */
function isoOf(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : undefined;
}

/** Render one content block. */
function text(value) {
  return [{ type: 'text', text: value }];
}

/**
 * Build the tool definitions.
 *
 * @param {object} deps - tool dependencies.
 * @param {Function} deps.defineTool - host `defineTool`.
 * @param {object} deps.ctx - plugin context.
 * @param {object} deps.engine - delivery engine.
 * @param {object} deps.config - effective configuration.
 * @param {object} [deps.logger] - host logger.
 * @returns {object[]} tool definitions, in registration order.
 */
export function createToolOptions({ ctx, engine, config, logger }) {
  /** @type {Map<string, { title: string, at: number }>} */
  const titleCache = new Map();

  /**
   * Sender title for the envelope, resolved through the title fold and cached
   * briefly (a title is cosmetic; it must never delay or fail a delivery).
   *
   * @param {string} sessionId - sender session id.
   * @returns {Promise<string|undefined>} title.
   */
  async function titleOf(sessionId) {
    if (sessionId === '') return undefined;
    const cached = titleCache.get(sessionId);
    if (cached !== undefined && Date.now() - cached.at < 60_000) return cached.title;
    const query = ctx.get('sessionQuery');
    if (query === undefined || typeof query.readTitle !== 'function') return undefined;
    try {
      const snapshot = await query.readTitle(sessionId);
      const title = typeof snapshot?.title === 'string' ? snapshot.title : undefined;
      if (title !== undefined) titleCache.set(sessionId, { title, at: Date.now() });
      return title;
    } catch {
      return undefined;
    }
  }

  /** Resolve the calling session id, or `undefined` for a non-agent caller. */
  function callerOf(exec) {
    const id = exec?.agent?.session?.id ?? exec?.agent?.id;
    return id === undefined ? undefined : String(id);
  }

  /** Shared output shape for refusals: never throw, always explain. */
  function failure(code, message, extra = {}) {
    return compact({ ok: false, code, message, ...extra });
  }

  const sessionList = {
    name: 'session_list',
    description:
      '列出这个 DSH 进程里**已存在**的会话（不新建会话）：会话 id、标题、工作目录、是否在内存中(live)、是否正在跑(running)、是否已归档(archived)、最近活动时间、agent preset。' +
      '用于：给别的会话投递消息前先找到它的 id；回答「有哪些会话/哪个会话在干什么」。' +
      '不要用于：新建会话（本插件只管读已有 + 写已有）；读某个会话的内容请用 session_read。' +
      '默认隐藏归档会话（archived），需要看时传 includeArchived=true。',
    parameters: {
      query: { type: 'string', description: '按标题/工作目录/id 子串过滤（大小写不敏感，可选）' },
      limit: { type: 'number', description: `返回条数上限，默认 ${config.listDefaultLimit}，最大 200` },
      includeArchived: { type: 'boolean', description: '是否包含已归档会话，默认 false' },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 120_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'string' },
          message: { type: 'string' },
          self: { type: 'string' },
          total: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
          degraded: { type: 'array', required: true, items: { type: 'string' } },
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { type: 'string', required: true },
                title: { type: 'string' },
                cwd: { type: 'string' },
                live: { type: 'boolean', required: true },
                running: { type: 'boolean', required: true },
                archived: { type: 'boolean', required: true },
                isSelf: { type: 'boolean', required: true },
                agentPreset: { type: 'string' },
                createdAt: { type: 'string' },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) return text(`session_list 不可用：${value.message}`);
        const lines = [`会话共 ${value.total} 个${value.truncated ? `（只列前 ${value.sessions.length} 个）` : ''}`];
        for (const row of value.sessions) {
          const flags = [
            row.live ? 'live' : 'cold',
            row.running ? 'running' : 'idle',
            row.archived ? 'ARCHIVED' : undefined,
            row.isSelf ? 'self' : undefined,
            row.agentPreset === undefined ? undefined : `preset=${row.agentPreset}`,
          ]
            .filter(Boolean)
            .join(',');
          lines.push(
            `- ${row.sessionId} | ${row.title ?? '(无标题)'} | ${row.cwd ?? '(未知目录)'} | ${flags} | ${row.updatedAt ?? row.createdAt ?? '?'}`,
          );
        }
        for (const note of value.degraded ?? []) lines.push(`! ${note}`);
        lines.push('提示：投递用 session_send(sessionId=…, text=…)；读内容用 session_read(sessionId=…)');
        return text(lines.join('\n'));
      },
    },
    async execute(args, exec) {
      const self = callerOf(exec);
      try {
        const result = await listSessions(ctx, {
          query: typeof args.query === 'string' ? args.query : undefined,
          limit: Number.isFinite(args.limit) ? args.limit : config.listDefaultLimit,
          includeArchived: args.includeArchived === true,
          selfId: self,
          titleScanLimit: config.listTitleScanLimit,
        });
        return {
          ok: true,
          self,
          total: result.total,
          truncated: result.truncated,
          degraded: result.degraded,
          sessions: result.rows.map((row) =>
            compact({
              sessionId: row.sessionId,
              title: row.title,
              cwd: row.cwd,
              live: row.live === true,
              running: row.running === true,
              archived: row.archived === true,
              isSelf: row.isSelf === true,
              agentPreset: row.agentPreset,
              createdAt: isoOf(row.createdAt),
              updatedAt: isoOf(row.updatedAt),
            }),
          ),
        };
      } catch (error) {
        logger?.warn?.(`dsh-session-link: session_list failed: ${String(error)}`);
        return failure(error?.code ?? CODE.QUERY_FAILED, error?.message ?? String(error), { self, total: 0, truncated: false, degraded: [], sessions: [] });
      }
    },
  };

  const sessionRead = {
    name: 'session_read',
    description:
      '读取某个**已存在**会话的近期内容快照（只读）：会话头（cwd、agent preset）加最近若干条 user/assistant/tool 记录。' +
      '用于：投递前了解对方在做什么；确认自己发的消息是否被对方读到（kind=session-link 的记录就是本插件投递的信封）。' +
      '不要用于：修改对方会话；全文检索（宿主检索后端当前可能不可用，本工具只做有界读取）。' +
      '内容是**有界尾部**：默认 20 条、单条上限 1200 字符，超出会以 …[+N] 标注。',
    parameters: {
      sessionId: { type: 'string', required: true, description: '精确会话 id（来自 session_list）' },
      limit: { type: 'number', description: `读取条数，默认 ${config.readDefaultLimit}，最大 400` },
      maxChars: { type: 'number', description: `单条最大字符数，默认 ${config.readMaxChars}` },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 120_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'string' },
          message: { type: 'string' },
          sessionId: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          agentPreset: { type: 'string' },
          live: { type: 'boolean' },
          running: { type: 'boolean' },
          archived: { type: 'boolean' },
          totalEvents: { type: 'number' },
          totalEntries: { type: 'number' },
          returned: { type: 'number' },
          truncated: { type: 'boolean' },
          degraded: { type: 'array', items: { type: 'string' } },
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'number', required: true },
                role: { type: 'string', required: true },
                time: { type: 'string' },
                name: { type: 'string' },
                kind: { type: 'string' },
                text: { type: 'string', required: true },
                error: { type: 'boolean' },
                interrupted: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) return text(`session_read 失败：${value.message}`);
        const lines = [
          `会话 ${value.sessionId}${value.title === undefined ? '' : ` 「${value.title}」`}`,
          `cwd=${value.cwd ?? '?'} preset=${value.agentPreset ?? '?'} ${value.live ? 'live' : 'cold'}${value.running ? '/running' : ''}${value.archived ? '/ARCHIVED' : ''}`,
          `事件 ${value.totalEvents ?? '?'} 条，可渲染 ${value.totalEntries ?? '?'} 条，本次返回最后 ${value.returned ?? 0} 条`,
        ];
        for (const entry of value.messages ?? []) {
          const tag = entry.kind === 'session-link' ? '[link]' : '';
          const head = `#${entry.seq} ${entry.role}${entry.name === undefined ? '' : ` ${entry.name}`}${tag}${entry.error === true ? ' (error)' : ''}`;
          lines.push(`${head}: ${entry.text}`);
        }
        for (const note of value.degraded ?? []) lines.push(`! ${note}`);
        return text(lines.join('\n'));
      },
    },
    async execute(args, exec) {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
      if (sessionId === '') return failure(CODE.INVALID_ARGS, 'sessionId 必填', { messages: [] });
      try {
        const result = await readTranscript(ctx, {
          sessionId,
          limit: Number.isFinite(args.limit) ? args.limit : config.readDefaultLimit,
          maxChars: Number.isFinite(args.maxChars) ? args.maxChars : config.readMaxChars,
        });
        const title = await titleOf(sessionId);
        return {
          ok: true,
          sessionId: result.sessionId,
          title,
          cwd: result.cwd,
          agentPreset: result.agentPreset,
          live: result.live,
          running: result.running,
          archived: result.archived,
          totalEvents: result.totalEvents,
          totalEntries: result.totalEntries,
          returned: result.returned,
          truncated: result.truncated,
          degraded: result.degraded,
          messages: result.messages.map((entry) =>
            compact({
              seq: entry.seq,
              role: entry.role,
              time: isoOf(entry.time),
              name: entry.name,
              kind: entry.kind,
              text: entry.text,
              error: entry.error,
              interrupted: entry.interrupted,
            }),
          ),
        };
      } catch (error) {
        logger?.warn?.(`dsh-session-link: session_read failed: ${String(error)}`);
        return failure(error?.code ?? CODE.QUERY_FAILED, error?.message ?? String(error), { sessionId, messages: [] });
      }
    },
  };

  const sendParameters = {
    sessionId: { type: 'string', description: '目标会话 id（与 title 二选一，优先用它）' },
    title: { type: 'string', description: '按标题匹配目标会话（与 sessionId 二选一；匹配到多个会报错）' },
    text: { type: 'string', required: true, description: `消息正文（≤${config.maxTextChars} 字符）。写清背景、目标、验收标准与期望产出` },
    mode: {
      type: 'string',
      enum: ['followup', 'steer', 'inject'],
      description:
        'followup（默认）：排成对方的下一个独立回合，对方离线时先按它自己的 preset/模型恢复再排队；steer：立即介入对方**正在跑**的工作；inject：不打断、只给对方的下一步补上下文（仅 running）',
    },
    requestId: { type: 'string', description: '幂等键：同一个 requestId 重复调用不会重复投递，可选' },
    thread: { type: 'string', description: '线程 id（回复别人时把对方信封里的 thread 原样传回，用于跳数预算与串联）' },
    replyTo: { type: 'string', description: '回复的 requestId（对方信封里的 request_id），可选' },
  };

  const capabilitySchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      guarded: { type: 'boolean' },
      resumed: { type: 'boolean' },
      presetBefore: { type: 'string' },
      presetAfter: { type: 'string' },
      modelBefore: { type: 'string' },
      modelAfter: { type: 'string' },
      providerBefore: { type: 'string' },
      providerAfter: { type: 'string' },
      sourceBefore: { type: 'string' },
      sourceAfter: { type: 'string' },
      presetEvent: { type: 'string' },
      presetId: { type: 'string' },
      resumeRoute: { type: 'string' },
      drift: { type: 'boolean' },
      reason: { type: 'string' },
    },
  };

  const sendOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      code: { type: 'string' },
      message: { type: 'string' },
      requestId: { type: 'string' },
      threadId: { type: 'string' },
      hop: { type: 'number' },
      maxHops: { type: 'number' },
      from: { type: 'string' },
      to: { type: 'string' },
      toTitle: { type: 'string' },
      mode: { type: 'string' },
      status: { type: 'string' },
      targetWasLive: { type: 'boolean' },
      resumed: { type: 'boolean' },
      deduplicated: { type: 'boolean' },
      chars: { type: 'number' },
      envelopePreview: { type: 'string' },
      note: { type: 'string' },
      receiptAt: { type: 'number' },
      retryAfterMs: { type: 'number' },
      targetStatus: { type: 'string' },
      details: { type: 'json' },
      capability: capabilitySchema,
    },
  };

  /** Normalize a capability probe for the output schema (drops undefined members). */
  function pickCapability(capability) {
    if (capability === undefined || capability === null) return undefined;
    return compact({
      guarded: capability.guarded,
      resumed: capability.resumed,
      presetBefore: capability.presetBefore,
      presetAfter: capability.presetAfter,
      modelBefore: capability.modelBefore,
      modelAfter: capability.modelAfter,
      providerBefore: capability.providerBefore,
      providerAfter: capability.providerAfter,
      sourceBefore: capability.sourceBefore,
      sourceAfter: capability.sourceAfter,
      presetEvent: capability.presetEvent,
      presetId: capability.presetId,
      resumeRoute: capability.resumeRoute,
      drift: capability.drift,
      reason: capability.reason,
    });
  }

  /** Exactly the keys {@link sendOutputSchema} declares, in one place. */
  const DELIVERY_KEYS = [
    'ok',
    'code',
    'message',
    'requestId',
    'threadId',
    'hop',
    'maxHops',
    'from',
    'to',
    'toTitle',
    'mode',
    'status',
    'targetWasLive',
    'resumed',
    'deduplicated',
    'chars',
    'envelopePreview',
    'note',
    'receiptAt',
    'retryAfterMs',
    'targetStatus',
    'details',
    'capability',
    'waited',
    'waitStatus',
    'claimed',
    'reply',
    'waitNote',
  ];

  /**
   * Project one engine result onto the declared output schema. Future engine
   * fields are dropped here instead of failing host-side schema validation.
   */
  function pickDelivery(value) {
    const out = {};
    for (const key of DELIVERY_KEYS) {
      if (value?.[key] !== undefined && value[key] !== null) out[key] = value[key];
    }
    if (out.capability !== undefined) out.capability = pickCapability(out.capability);
    return out;
  }

  /** Shared rendering of one delivery/ask result. */
  function renderDelivery(value, extraLines = []) {
    if (value.ok !== true) return text(`投递被拒绝 [${value.code}]：${value.message}`);
    const lines = [
      `已投递 ${value.mode} → ${value.to}${value.toTitle === undefined ? '' : ` 「${value.toTitle}」`}`,
      `requestId=${value.requestId} thread=${value.threadId} hop=${value.hop}/${value.maxHops} chars=${value.chars}`,
      value.deduplicated === true
        ? `幂等命中：复用已有回执（状态 ${value.status}）`
        : `目标状态：${value.targetWasLive === true ? '会话已在内存中' : `冷会话，已按它自己的 preset/模型恢复${value.resumed === true ? '' : '（未恢复）'}`}`,
      value.capability?.guarded === true
        ? `能力守卫：preset ${value.capability.presetBefore ?? '?'} → ${value.capability.presetAfter ?? '?'}，model ${value.capability.modelBefore ?? '?'} → ${value.capability.modelAfter ?? '?'}（未改变）`
        : undefined,
      ...extraLines,
      value.note,
      `回执查询：check_delivery(requestId="${value.requestId}")`,
    ].filter((line) => typeof line === 'string' && line !== '');
    return text(lines.join('\n'));
  }

  const sessionSend = {
    name: 'session_send',
    description:
      '把一条消息投递给这个 DSH 进程里**已存在的**另一个会话，让它被唤醒并开始工作（不新建会话，也不改变对方的 agent preset 与模型）。' +
      '用于：把任务派给已经在某个工作区里的会话；通知另一个会话有新情况；回复对方用 session_send 发给你的消息。' +
      '不要用于：给自己发（会被拒绝）；给已归档会话发（会被拒绝）；创建新会话（用 dsh headless 或 subagents）。' +
      '默认 mode=followup（排队为对方新的独立回合）。消息会被包进带来源标记的 <agent_message> 边界，对方的回复同样通过本工具回到你这里，并用 thread/replyTo 串联。',
    parameters: sendParameters,
    isConcurrencySafe: () => false,
    timeoutMs: 120_000,
    output: {
      schema: sendOutputSchema,
      render: (args, value) => renderDelivery(value),
    },
    async execute(args, exec) {
      const from = callerOf(exec);
      if (from === undefined) return failure(CODE.NO_CALLER, '当前调用没有会话身份，无法作为发信方', { });
      const result = await engine.deliver({
        senderId: from,
        senderTitle: await titleOf(from),
        sessionId: typeof args.sessionId === 'string' ? args.sessionId.trim() : undefined,
        title: typeof args.title === 'string' ? args.title.trim() : undefined,
        text: typeof args.text === 'string' ? args.text : '',
        mode: typeof args.mode === 'string' ? args.mode : 'followup',
        requestId: typeof args.requestId === 'string' ? args.requestId.trim() : undefined,
        threadId: typeof args.thread === 'string' ? args.thread.trim() : undefined,
        replyTo: typeof args.replyTo === 'string' ? args.replyTo.trim() : undefined,
      });
      return pickDelivery(result);
    },
  };

  const sessionAsk = {
    name: 'session_ask',
    description:
      '给一个**已存在**的会话投递一条消息，并**等它这一轮结束**，把对方的最终回复文本带回来（会话间 RPC）。' +
      '用于：需要立刻拿到另一个会话结论的派活（例如「让 FPGA 那个会话跑一次时序检查，把结果告诉我」）。' +
      '不要用于：长任务（等不到就超时，改用 session_send + check_delivery）；给多个会话广播（逐个调用）。' +
      '默认最多等 20 秒（waitMs 可调，上限 120 秒）；超时不代表失败——消息已经投递，对方仍在继续，之后可用 check_delivery 或 session_read 查看。',
    parameters: {
      sessionId: sendParameters.sessionId,
      title: sendParameters.title,
      text: sendParameters.text,
      waitMs: { type: 'number', description: `等待上限（毫秒），默认 ${config.awaitDefaultMs}，最大 ${config.awaitMaxMs}` },
      requestId: sendParameters.requestId,
      thread: sendParameters.thread,
    },
    isConcurrencySafe: () => false,
    timeoutMs: 180_000,
    output: {
      schema: {
        ...sendOutputSchema,
        properties: {
          ...sendOutputSchema.properties,
          waited: { type: 'number' },
          waitStatus: { type: 'string' },
          claimed: { type: 'boolean' },
          reply: { type: 'string' },
          waitNote: { type: 'string' },
        },
      },
      render: (args, value) => {
        if (value.ok !== true) return text(`session_ask 被拒绝 [${value.code}]：${value.message}`);
        const lines = [
          `等待 ${value.waited ?? 0} ms 后：${value.waitStatus === 'completed' ? '对方本轮已结束' : value.waitStatus}`,
          value.claimed === true ? '对方已领取该消息' : '对方尚未领取（可能还在跑上一轮）',
          value.reply === undefined ? '（没有拿到文本回复）' : `对方回复：\n${value.reply}`,
        ];
        return renderDelivery(value, lines);
      },
    },
    async execute(args, exec) {
      const from = callerOf(exec);
      if (from === undefined) return failure(CODE.NO_CALLER, '当前调用没有会话身份，无法作为发信方');
      const result = await engine.ask({
        senderId: from,
        senderTitle: await titleOf(from),
        sessionId: typeof args.sessionId === 'string' ? args.sessionId.trim() : undefined,
        title: typeof args.title === 'string' ? args.title.trim() : undefined,
        text: typeof args.text === 'string' ? args.text : '',
        mode: 'followup',
        requestId: typeof args.requestId === 'string' ? args.requestId.trim() : undefined,
        threadId: typeof args.thread === 'string' ? args.thread.trim() : undefined,
        waitMs: Number.isFinite(args.waitMs) ? args.waitMs : undefined,
      });
      return pickDelivery(result);
    },
  };

  const checkDelivery = {
    name: 'check_delivery',
    description:
      '按 requestId 查询一条投递的回执：是否送达、是否被目标领取(claimed)、对方那一轮是否结束(completed)、中途是否被拒绝(含原因)，以及能力守卫记录的 preset/模型前后值。' +
      '用于：投递后确认对方是否真的拿到了消息；追溯某条消息为什么没生效。' +
      '不要用于：列会话（session_list）、读内容（session_read）。回执落盘在审计文件里，进程重启后仍可查。',
    parameters: {
      requestId: { type: 'string', required: true, description: 'session_send/session_ask 返回的 requestId' },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          found: { type: 'boolean', required: true },
          code: { type: 'string' },
          message: { type: 'string' },
          requestId: { type: 'string' },
          status: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          toTitle: { type: 'string' },
          mode: { type: 'string' },
          threadId: { type: 'string' },
          hop: { type: 'number' },
          maxHops: { type: 'number' },
          chars: { type: 'number' },
          at: { type: 'string' },
          updatedAt: { type: 'string' },
          targetWasLive: { type: 'boolean' },
          resumed: { type: 'boolean' },
          capability: capabilitySchema,
          reply: { type: 'string' },
          timeline: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                at: { type: 'string' },
                status: { type: 'string', required: true },
                detail: { type: 'string' },
              },
            },
          },
          recent: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                requestId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                from: { type: 'string' },
                to: { type: 'string' },
                at: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.found !== true) {
          const lines = [`未找到回执：${value.message}`];
          for (const row of value.recent ?? []) lines.push(`- 最近：${row.requestId} ${row.status} ${row.from} → ${row.to}`);
          return text(lines.join('\n'));
        }
        const lines = [
          `${value.requestId}: ${value.status}`,
          `${value.from} → ${value.to}${value.toTitle === undefined ? '' : ` 「${value.toTitle}」`} mode=${value.mode} thread=${value.threadId} hop=${value.hop}/${value.maxHops}`,
          value.message === undefined ? undefined : `说明：${value.message}`,
          value.reply === undefined ? undefined : `对方回复：${value.reply}`,
        ];
        for (const step of value.timeline ?? []) lines.push(`- ${step.at} ${step.status}${step.detail === undefined ? '' : ` ${step.detail}`}`);
        return text(lines.filter(Boolean).join('\n'));
      },
    },
    async execute(args) {
      const requestId = typeof args.requestId === 'string' ? args.requestId.trim() : '';
      if (requestId === '') return compact({ ok: false, found: false, code: CODE.INVALID_ARGS, message: 'requestId 必填' });
      const result = engine.receipt(requestId);
      if (result.found !== true) {
        return compact({
          ok: false,
          found: false,
          code: result.code,
          message: result.message,
          recent: (result.recent ?? []).map((row) =>
            compact({ requestId: row.requestId, status: row.status, from: row.from, to: row.to, at: isoOf(row.at) }),
          ),
        });
      }
      return compact({
        ok: true,
        found: true,
        requestId: result.requestId,
        status: result.status,
        code: result.code,
        message: result.message,
        from: result.from,
        to: result.to,
        toTitle: result.toTitle,
        mode: result.mode,
        threadId: result.threadId,
        hop: result.hop,
        maxHops: result.maxHops,
        chars: result.chars,
        at: isoOf(result.at),
        updatedAt: isoOf(result.updatedAt),
        targetWasLive: result.targetWasLive,
        resumed: result.resumed,
        capability: pickCapability(result.capability),
        reply: result.reply,
        timeline: (result.timeline ?? []).map((step) =>
          compact({ at: isoOf(step.at), status: step.status, detail: step.detail }),
        ),
      });
    },
  };

  return [sessionList, sessionRead, sessionSend, sessionAsk, checkDelivery];
}

/**
 * Compile the tool options into registry-ready definitions.
 *
 * Each call builds **fresh** option objects and compiles them exactly once.
 * That matters because the host's `defineTool` MUTATES the options it is given
 * (it replaces `parameters` with the compiled JSON Schema), so a second compile
 * of the same object throws
 * `JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object`.
 *
 * @param {object} deps - tool dependencies.
 * @param {Function} deps.defineTool - host `defineTool`.
 * @param {object} deps.ctx - plugin context.
 * @param {object} deps.engine - delivery engine.
 * @param {object} deps.config - effective configuration.
 * @param {object} [deps.logger] - host logger.
 * @returns {object[]} tool definitions, in registration order.
 */
export function createToolDefinitions(deps) {
  return createToolOptions(deps).map((entry) => deps.defineTool(entry));
}
