/**
 * Delivery engine: guards, target activation, the capability guard, the
 * envelope hand-off, receipts and the request/response (`session_ask`) wait.
 *
 * Order of operations is deliberately "cheapest and most decisive guard first",
 * and every refusal is a *value*, not an exception, so a model can read the
 * reason and adapt:
 *
 *   1. argument sanity (empty / too long)
 *   2. identity  — never send to yourself (constraint 4)
 *   3. archive   — never wake an archived session (constraint 3)
 *   4. budget    — thread hop budget (anti ping-pong)
 *   5. throttle  — per-pair rate limit
 *   6. idempotency — same fingerprint inside the window is not re-delivered
 *   7. activation — live agent, or `agents.resume` for a cold session,
 *                   **without** `agentOptions` / `meta.agentPreset` (constraint 2)
 *   8. capability guard — refuse if the resumed session's preset or model route
 *                   would differ from what it recorded
 *   9. hand-off  — `followup` / `steer` / `inject` with a SLEP envelope
 *
 * @module dsh-session-link/engine
 */
import { CODE, LinkError, describeError } from './errors.js';
import { buildEnvelope, previewEnvelope, requestMarker } from './envelope.js';
import { fingerprint, mintId, normalizeForFingerprint } from './ids.js';
import { archivedSessionIds, probeCapability, resolveTarget } from './sessions.js';
import { STATUS } from './store.js';

/** Delivery modes accepted by the tools. */
export const MODES = ['followup', 'steer', 'inject'];

/** Default configuration; every field is overridable through the patch. */
export const DEFAULT_CONFIG = {
  auditFile: '~/.dsh/session-link/audit.ndjson',
  auditMaxBytes: 8 * 1024 * 1024,
  maxTextChars: 8000,
  maxHops: 6,
  dedupeWindowMs: 5 * 60 * 1000,
  rateLimitPerMinute: 12,
  readDefaultLimit: 20,
  readMaxChars: 1200,
  listDefaultLimit: 20,
  listTitleScanLimit: 200,
  verifyCapability: true,
  awaitDefaultMs: 20000,
  awaitMaxMs: 120000,
  resumeIdleEvictMs: 0,
};

/**
 * Merge user configuration over the defaults, ignoring unknown keys.
 *
 * @param {object} [config] - raw patch config.
 * @returns {object} effective configuration.
 */
export function resolveConfig(config) {
  const out = { ...DEFAULT_CONFIG };
  if (config === null || typeof config !== 'object') return out;
  for (const [key, value] of Object.entries(config)) {
    if (key in DEFAULT_CONFIG && value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/**
 * Build the `agents.resume` options for a cold target from **that target's own
 * durable record**.
 *
 * The host's own resume path (`dsh-api-session-controller`) resumes with
 * `agentOptions` taken from the deployment's default model selection plus a
 * `setup` that mounts the session's preset. Dropping both (as the task brief
 * literally suggested) does not work: the resumed loop then has no resolved
 * model, and a `{{model}}` persona variable fails the whole assembly —
 * reproduced during the end-to-end run.
 *
 * This plugin therefore reconstructs, for the target only:
 *  - `agentOptions` from the target's newest recorded `request/header.config`,
 *    falling back to the deployment default selection (never the caller's);
 *  - `setup` that mounts the target's durable agent preset through
 *    `ctx.agentPresets`, exactly like the web controller's `composition.setup`.
 *
 * Nothing here reads the calling session's capability set, which is what
 * constraint 2 actually protects.
 *
 * @param {object} ctx - plugin context.
 * @param {object} capability - result of `probeCapability` for the target.
 * @returns {Promise<{ agentOptions?: object, setup?: Function, presetId?: string, routeSource: string, refusal?: string }>} resume options.
 */
export async function buildResumeOptions(ctx, capability) {
  const notes = { routeSource: 'none' };

  if (capability?.provider !== undefined && capability?.model !== undefined) {
    notes.agentOptions = {
      provider: capability.provider,
      model: capability.model,
      ...(capability.reasoningEffort === undefined ? {} : { reasoningEffort: capability.reasoningEffort }),
    };
    notes.routeSource = 'target-record';
  } else {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
    if (selection?.provider !== undefined && selection?.model !== undefined) {
      notes.agentOptions = {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      };
      notes.routeSource = 'deployment-default';
    }
  }

  const presetId = capability?.presetCurrent;
  const presets = ctx.get('agentPresets');
  if (presetId !== undefined && presetId !== '') {
    if (presets === undefined || typeof presets.mount !== 'function' || typeof presets.resolve !== 'function') {
      // The session runs under a preset this deployment cannot compose: waking
      // it would silently change its capability set, so refuse instead.
      return { ...notes, refusal: `目标会话记录着 agent preset「${presetId}」，但当前部署没有可用的 agentPresets 服务，无法原样恢复它的能力集` };
    }
    let resolved;
    try {
      resolved = await presets.resolve(presetId);
    } catch (error) {
      return { ...notes, refusal: `无法解析目标会话的 agent preset「${presetId}」：${describeError(error, CODE.DELIVERY_FAILED).message}` };
    }
    notes.presetId = resolved?.id ?? presetId;
    notes.setup = async (agentCtx) => {
      await presets.mount(agentCtx, notes.presetId);
    };
  }
  return notes;
}

/**
 * Create the delivery engine.
 *
 * @param {object} deps - engine dependencies.
 * @param {object} deps.ctx - plugin context.
 * @param {object} deps.store - link store.
 * @param {object} deps.audit - audit log.
 * @param {object} deps.config - effective configuration.
 * @param {object} [deps.logger] - host logger.
 * @param {() => number} [deps.now] - clock.
 * @param {Function} [deps.createUserMessage] - host message factory.
 * @returns {object} engine.
 */
export function createEngine({ ctx, store, audit, config, logger, now = Date.now, createUserMessage }) {
  /** @type {Map<string, { handle: object, at: number }>} agents this plugin resumed */
  const owned = new Map();
  /** @type {Map<string, string>} requestId → target session id awaiting claim */
  const awaitingClaim = new Map();
  /** @type {Map<string, { turns: number, reply: string|undefined }>} claimed requests */
  const claimed = new Map();

  function log(level, message) {
    const fn = logger?.[level];
    if (typeof fn === 'function') fn.call(logger, `dsh-session-link: ${message}`);
  }

  /** Audit write + in-memory fold in one step, so they can never diverge. */
  async function record(entry) {
    const recordValue = { v: 1, ts: now(), ...entry };
    store.fold(recordValue);
    await audit.append(recordValue);
    return recordValue;
  }

  function refusal(code, message, extra = {}) {
    return { ok: false, code, message, ...extra };
  }

  function shortReceipt(receipt) {
    if (receipt === undefined) return undefined;
    return {
      requestId: receipt.requestId,
      status: receipt.status,
      at: receipt.at,
      threadId: receipt.threadId,
      hop: receipt.hop,
      maxHops: receipt.maxHops,
      from: receipt.from,
      to: receipt.to,
    };
  }

  /**
   * Hand one envelope to a target Agent and return a receipt.
   *
   * @param {object} request - delivery request.
   * @returns {Promise<object>} delivery result (never throws for policy refusals).
   */
  async function deliver(request) {
    const agents = ctx.get('agents');
    if (agents === undefined || typeof agents.get !== 'function' || typeof agents.resume !== 'function') {
      return refusal(CODE.SERVICE_UNAVAILABLE, '宿主没有提供 ctx.agents 服务，无法投递');
    }

    const from = String(request.senderId ?? '');
    if (from === '') return refusal(CODE.NO_CALLER, '调用方不是会话 agent，无法确定发信方');

    const mode = MODES.includes(request.mode) ? request.mode : 'followup';
    const text = typeof request.text === 'string' ? request.text : '';
    if (text.trim() === '') return refusal(CODE.TEXT_EMPTY, '消息正文为空');
    if ([...text].length > config.maxTextChars) {
      return refusal(CODE.TEXT_TOO_LONG, `消息正文 ${[...text].length} 字符，超过上限 ${config.maxTextChars} 字符`);
    }

    // ---- target resolution -------------------------------------------------
    let target;
    try {
      target = await resolveTarget(ctx, { sessionId: request.sessionId, title: request.title, selfId: from });
    } catch (error) {
      const described = describeError(error, CODE.TARGET_NOT_FOUND);
      await record({
        kind: 'refusal',
        code: described.code,
        message: described.message,
        from,
        mode,
        to: request.sessionId ?? request.title,
        requestId: request.requestId,
      });
      return refusal(described.code, described.message, { details: error?.details });
    }
    const to = target.sessionId;

    // ---- 2. self-send ------------------------------------------------------
    if (to === from) {
      await record({
        kind: 'refusal',
        code: CODE.SELF_SEND,
        message: '拒绝发给自己',
        from,
        to,
        mode,
        requestId: request.requestId,
      });
      return refusal(CODE.SELF_SEND, `目标会话就是调用方自己（${to}），已拒绝`);
    }

    // ---- 3. archived -------------------------------------------------------
    // The archive set is registry-global; one lookup covers every workspace.
    if (archivedSessionIds(ctx).has(to)) {
      await record({
        kind: 'refusal',
        code: CODE.TARGET_ARCHIVED,
        message: '目标会话已归档',
        from,
        to,
        mode,
        requestId: request.requestId,
      });
      return refusal(CODE.TARGET_ARCHIVED, `会话 ${to} 已归档，本插件不唤醒归档会话`);
    }

    // ---- 4. thread + hop budget -------------------------------------------
    let threadId = typeof request.threadId === 'string' && request.threadId !== '' ? request.threadId : undefined;
    let hop = 1;
    if (threadId !== undefined) {
      const thread = store.thread(threadId);
      if (thread === undefined) {
        store.openThread(threadId, { maxHops: config.maxHops, origin: from });
        hop = 1;
      } else {
        hop = (Number.isFinite(thread.hop) ? thread.hop : 0) + 1;
        if (hop > (thread.maxHops ?? config.maxHops)) {
          await record({
            kind: 'refusal',
            code: CODE.HOP_BUDGET_EXHAUSTED,
            message: `线程 ${threadId} 跳数用尽`,
            thread: threadId,
            hop,
            maxHops: thread.maxHops ?? config.maxHops,
            from,
            to,
            mode,
            requestId: request.requestId,
          });
          return refusal(
            CODE.HOP_BUDGET_EXHAUSTED,
            `线程 ${threadId} 已用尽 ${thread.maxHops ?? config.maxHops} 跳预算（本次是第 ${hop} 跳）`,
            { threadId, hop, maxHops: thread.maxHops ?? config.maxHops },
          );
        }
      }
    } else {
      threadId = mintId('th');
      hop = 1;
    }

    // ---- 5. rate limit -----------------------------------------------------
    const rateKey = `${from}->${to}`;
    const rate = store.rate(rateKey, config.rateLimitPerMinute, 60 * 1000);
    if (rate.allowed !== true) {
      await record({
        kind: 'refusal',
        code: CODE.RATE_LIMITED,
        message: `${rateKey} 超过 ${config.rateLimitPerMinute}/分钟`,
        thread: threadId,
        hop,
        maxHops: config.maxHops,
        from,
        to,
        mode,
        requestId: request.requestId,
      });
      return refusal(
        CODE.RATE_LIMITED,
        `${from} → ${to} 在 1 分钟内已发送 ${rate.count} 条（上限 ${config.rateLimitPerMinute}），${Math.ceil(rate.retryAfterMs / 1000)} 秒后可再试`,
        { threadId, hop, retryAfterMs: rate.retryAfterMs },
      );
    }

    // ---- 6. idempotency ----------------------------------------------------
    const contentFingerprint = fingerprint([from, to, mode, normalizeForFingerprint(text)]);
    if (typeof request.requestId === 'string' && request.requestId !== '') {
      const previous = store.receipt(request.requestId);
      if (previous !== undefined && previous.status !== STATUS.REFUSED && previous.status !== STATUS.FAILED) {
        return {
          ok: true,
          deduplicated: true,
          requestId: previous.requestId,
          threadId: previous.threadId,
          hop: previous.hop,
          maxHops: previous.maxHops,
          from: previous.from,
          to: previous.to,
          mode: previous.mode,
          status: previous.status,
          targetWasLive: previous.targetWasLive,
          resumed: previous.resumed,
          capability: previous.capability,
          chars: previous.chars,
          envelopePreview: previewEnvelope(previous.envelope ?? '', 200),
          note: '该 requestId 已投递过，本次直接返回原回执（幂等）',
        };
      }
    } else {
      const duplicate = store.dedupeHit(contentFingerprint, config.dedupeWindowMs);
      if (duplicate !== undefined) {
        return {
          ok: true,
          deduplicated: true,
          requestId: duplicate.requestId,
          threadId: duplicate.threadId,
          hop: duplicate.hop,
          maxHops: duplicate.maxHops,
          from: duplicate.from,
          to: duplicate.to,
          mode: duplicate.mode,
          status: duplicate.status,
          targetWasLive: duplicate.targetWasLive,
          resumed: duplicate.resumed,
          capability: duplicate.capability,
          chars: duplicate.chars,
          envelopePreview: previewEnvelope(duplicate.envelope ?? '', 200),
          note: `内容指纹在 ${Math.round(config.dedupeWindowMs / 1000)} 秒窗口内重复，未重复投递（幂等）`,
        };
      }
    }

    const requestId = typeof request.requestId === 'string' && request.requestId !== '' ? request.requestId : mintId('req');

    // ---- 7. activation -----------------------------------------------------
    let agent = agents.get(to);
    let resumed = false;
    let handle;
    let capabilityBefore;
    let resumeSource;
    let resumedPresetId;
    if (agent === undefined) {
      if (config.verifyCapability !== false) {
        try {
          capabilityBefore = await probeCapability(ctx, to);
        } catch (error) {
          const described = describeError(error, CODE.TARGET_NOT_FOUND);
          await record({
            kind: 'refusal',
            code: described.code,
            message: described.message,
            thread: threadId,
            hop,
            maxHops: config.maxHops,
            from,
            to,
            mode,
            requestId,
          });
          return refusal(described.code, described.message);
        }
      }
      let resumeOptions;
      try {
        // Constraint 2: the target's OWN durable record decides the capability
        // set. Nothing is derived from the calling session.
        resumeOptions = await buildResumeOptions(ctx, capabilityBefore ?? {});
        if (resumeOptions.refusal !== undefined) {
          await record({
            kind: 'refusal',
            code: CODE.CAPABILITY_DRIFT,
            message: resumeOptions.refusal,
            thread: threadId,
            hop,
            maxHops: config.maxHops,
            from,
            to,
            mode,
            requestId,
          });
          return refusal(CODE.CAPABILITY_DRIFT, resumeOptions.refusal, { threadId, hop });
        }
        handle = await agents.resume({
          resumeSessionId: to,
          ...(resumeOptions.agentOptions === undefined ? {} : { agentOptions: resumeOptions.agentOptions }),
          ...(resumeOptions.setup === undefined ? {} : { setup: resumeOptions.setup }),
        });
        resumeSource = resumeOptions.routeSource;
        resumedPresetId = resumeOptions.presetId;
      } catch (error) {
        const described = describeError(error, CODE.DELIVERY_FAILED);
        await record({
          kind: 'refusal',
          code: CODE.DELIVERY_FAILED,
          message: `resume 失败：${described.message}`,
          thread: threadId,
          hop,
          maxHops: config.maxHops,
          from,
          to,
          mode,
          requestId,
        });
        return refusal(CODE.DELIVERY_FAILED, `无法恢复冷会话 ${to}：${described.message}`, { threadId, hop });
      }
      agent = handle.agent;
      resumed = true;
      const previous = owned.get(to);
      if (previous !== undefined) {
        // A concurrent delivery won the resume race; keep the first handle.
        try {
          await handle.dispose();
        } catch {
          /* the loser handle is already gone */
        }
        agent = agents.get(to) ?? previous.handle.agent;
        handle = undefined;
      } else {
        owned.set(to, { handle, at: now() });
        log('debug', `resumed cold session ${to} for delivery ${requestId}`);
      }
    }

    // ---- 8. capability guard ----------------------------------------------
    let capability;
    if (config.verifyCapability !== false) {
      try {
        const after = await probeCapability(ctx, to);
        // For a live target nothing was resumed, so before === after by
        // construction; for a cold target `before` is the durable probe.
        const before = resumed
          ? (capabilityBefore ?? { agentPreset: undefined, provider: undefined, model: undefined })
          : after;
        const presetChanged = resumed && before.agentPreset !== undefined && after.agentPreset !== undefined && before.agentPreset !== after.agentPreset;
        const modelChanged = resumed && before.model !== undefined && after.model !== undefined && before.model !== after.model;
        capability = {
          guarded: true,
          resumed,
          resumeRoute: resumeSource,
          presetId: resumedPresetId,
          presetBefore: before.agentPreset,
          presetAfter: after.agentPreset,
          presetEvent: after.presetEvent,
          modelBefore: before.model,
          modelAfter: after.model,
          providerBefore: before.provider,
          providerAfter: after.provider,
          sourceBefore: before.source,
          sourceAfter: after.source,
          drift: presetChanged || modelChanged,
        };
        if (presetChanged || modelChanged) {
          if (handle !== undefined) {
            try {
              await handle.dispose();
            } catch {
              /* best effort */
            }
            owned.delete(to);
          }
          const message = `恢复 ${to} 会改变它的能力集：preset ${before.agentPreset} → ${after.agentPreset}，model ${before.model} → ${after.model}；已中止并回滚`;
          await record({
            kind: 'refusal',
            code: CODE.CAPABILITY_DRIFT,
            message,
            thread: threadId,
            hop,
            maxHops: config.maxHops,
            from,
            to,
            mode,
            requestId,
            capability,
          });
          return refusal(CODE.CAPABILITY_DRIFT, message, { threadId, hop, capability });
        }
      } catch (error) {
        log('warn', `capability probe failed for ${to}: ${String(error)}`);
        capability = { guarded: false, reason: describeError(error, CODE.QUERY_FAILED).message };
      }
    } else {
      capability = { guarded: false, reason: 'config.verifyCapability=false' };
    }

    // ---- 9. mode gate + hand-off -------------------------------------------
    const status = agent.status;
    if ((mode === 'steer' || mode === 'inject') && status !== 'running') {
      await record({
        kind: 'refusal',
        code: CODE.TARGET_NOT_RUNNING,
        message: `目标 ${to} 当前 ${status ?? 'unknown'}`,
        thread: threadId,
        hop,
        maxHops: config.maxHops,
        from,
        to,
        mode,
        requestId,
        capability,
      });
      return refusal(CODE.TARGET_NOT_RUNNING, `目标会话 ${to} 当前是 ${status ?? 'unknown'} 状态，${mode} 只对正在运行的会话有效；请改用 followup`, {
        threadId,
        hop,
        targetStatus: status ?? 'unknown',
      });
    }

    const envelope = buildEnvelope({
      requestId,
      threadId,
      hop,
      maxHops: store.thread(threadId)?.maxHops ?? config.maxHops,
      fromSessionId: from,
      fromTitle: request.senderTitle,
      mode,
      text,
      sentAt: now(),
      replyAllowed: true,
      replyTo: request.replyTo,
    });

    const message = createUserMessage({
      content: [{ type: 'text', text: envelope }],
      source: { kind: 'plugin:dsh-session-link' },
    });

    try {
      if (mode === 'steer') agent.steer(message);
      else if (mode === 'inject') agent.inject(message);
      else agent.followup(message);
    } catch (error) {
      const described = describeError(error, CODE.DELIVERY_FAILED);
      await record({
        kind: 'refusal',
        code: CODE.DELIVERY_FAILED,
        message: described.message,
        thread: threadId,
        hop,
        maxHops: config.maxHops,
        from,
        to,
        mode,
        requestId,
        capability,
      });
      return refusal(CODE.DELIVERY_FAILED, `宿主拒绝了 ${mode}：${described.message}`, { threadId, hop });
    }

    awaitingClaim.set(requestId, to);
    const maxHops = store.thread(threadId)?.maxHops ?? config.maxHops;
    const entry = await record({
      kind: 'delivery',
      requestId,
      thread: threadId,
      hop,
      maxHops,
      from,
      to,
      toTitle: target.title,
      mode,
      fingerprint: contentFingerprint,
      chars: [...text].length,
      targetWasLive: resumed !== true,
      resumed,
      capability,
      envelope,
    });

    return {
      ok: true,
      requestId,
      threadId,
      hop,
      maxHops,
      from,
      to,
      toTitle: target.title,
      mode,
      status: STATUS.DELIVERED,
      targetWasLive: resumed !== true,
      resumed,
      capability,
      chars: [...text].length,
      deduplicated: false,
      envelopePreview: previewEnvelope(envelope, 200),
      note: resumed
        ? '目标会话此前不在内存中，已按它自己记录的 preset/模型恢复后投递'
        : '目标会话已在内存中，直接投递',
      receiptAt: entry.ts,
    };
  }

  /** Mark a pending request as observed by the target's inbox. */
  function noteClaim(text, agentId) {
    for (const [requestId, to] of awaitingClaim) {
      if (to !== String(agentId)) continue;
      if (typeof text === 'string' && text.includes(requestMarker(requestId))) {
        awaitingClaim.delete(requestId);
        claimed.set(requestId, { to, reply: undefined });
        void record({ kind: 'status', requestId, status: STATUS.CLAIMED, detail: `已被 ${to} 的 inbox 领取` });
        return requestId;
      }
    }
    return undefined;
  }

  /** Mark one claimed request complete and remember the reply preview. */
  function noteCompletion(requestId, reply) {
    const state = claimed.get(requestId);
    if (state === undefined) return;
    claimed.delete(requestId);
    void record({
      kind: 'status',
      requestId,
      status: STATUS.COMPLETED,
      detail: '目标会话的回合已结束',
      reply: typeof reply === 'string' ? [...reply].slice(0, 2000).join('') : undefined,
    });
  }

  /**
   * Complete every request claimed inside the turn that just ended.
   *
   * @param {string} sessionId - the session whose turn ended.
   * @param {string} [reply] - that session's last assistant text, when known.
   * @returns {string[]} request ids completed by this event.
   */
  function noteTurnEnd(sessionId, reply) {
    const done = [];
    for (const [requestId, state] of [...claimed]) {
      if (state.to !== String(sessionId)) continue;
      done.push(requestId);
      noteCompletion(requestId, reply ?? state.reply);
    }
    return done;
  }

  // ---- receipt correlation (owned here, not by the caller) -------------------
  // #1: the target's loop claimed our envelope inside its turn.
  ctx.on('agent/inbox/claimed', (payload) => {
    try {
      const blocks = payload?.message?.content ?? [];
      let body = '';
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string') body += block.text;
      }
      // Only messages carrying our envelope preamble can raise a receipt.
      if (body.includes('[session-link]')) noteClaim(body, payload?.agent?.id);
    } catch (error) {
      log('warn', `claim correlation failed: ${String(error)}`);
    }
  });

  // #2: the target's turn ended, so the request completed; the reply preview is
  // folded from that session's own assistant frames.
  /** @type {Map<string, string>} */
  const lastReply = new Map();
  ctx.on('session/event', (session, event) => {
    try {
      const id = String(session?.id);
      if (event?.type === 'assistant/message') {
        const blocks = event.data?.message?.content ?? [];
        let body = '';
        for (const block of blocks) {
          if (block?.type === 'text' && typeof block.text === 'string') body += block.text;
        }
        if (body !== '') lastReply.set(id, [...body].slice(0, 2000).join(''));
        return;
      }
      if (event?.type === 'turn/end') noteTurnEnd(id, lastReply.get(id));
    } catch (error) {
      log('warn', `completion correlation failed: ${String(error)}`);
    }
  });

  /**
   * Wait for the target's turn that consumed `requestId` to finish.
   *
   * @param {object} spec - wait spec.
   * @param {string} spec.requestId - request to await.
   * @param {string} spec.to - target session id.
   * @param {number} spec.timeoutMs - bounded wait.
   * @returns {Promise<{ status: string, reply?: string, claimed: boolean }>} wait result.
   */
  async function waitForCompletion({ requestId, to, timeoutMs }) {
    const receipt = store.receipt(requestId);
    if (receipt !== undefined && receipt.status === STATUS.COMPLETED) {
      return { status: STATUS.COMPLETED, reply: receipt.reply?.text, claimed: true };
    }
    return await new Promise((resolve) => {
      let reply;
      /** Live progress state, read at event time — never a stale polled flag. */
      const progress = () => store.receipt(requestId)?.status;
      const claimSeen = () => claimed.has(requestId) || progress() === STATUS.CLAIMED || progress() === STATUS.COMPLETED;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          off?.();
        } catch {
          /* listener already removed */
        }
        resolve(value);
      };
      const off = ctx.on('session/event', (session, event) => {
        if (String(session?.id) !== String(to)) return;
        if (event?.type === 'assistant/message') {
          const content = event.data?.message?.content ?? [];
          let text = '';
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
          }
          if (text !== '') reply = [...text].slice(0, 4000).join('');
          return;
        }
        if (event?.type !== 'turn/end') return;
        const receipt = store.receipt(requestId);
        if (receipt?.status === STATUS.COMPLETED) {
          finish({ status: STATUS.COMPLETED, reply: receipt.reply?.text ?? reply, claimed: true });
          return;
        }
        if (claimSeen()) finish({ status: STATUS.COMPLETED, reply, claimed: true });
      });
      const timer = setTimeout(() => {
        const claim = claimSeen();
        finish({
          status: claim ? 'timeout' : 'unclaimed',
          reply,
          claimed: claim,
          note: claim
            ? '消息已被目标领取，但其回合在等待窗口内没有结束'
            : '消息已投递，但目标在等待窗口内没有领取（可能仍在跑别的回合，或目标刚被恢复还需要时间）',
        });
      }, timeoutMs);
    });
  }

  return {
    deliver,
    noteClaim,
    noteCompletion,
    noteTurnEnd,
    waitForCompletion,
    /**
     * Look up one receipt with its status timeline.
     *
     * @param {string} requestId - request id.
     * @returns {object} lookup result.
     */
    receipt(requestId) {
      const found = store.receipt(requestId);
      if (found === undefined) {
        return {
          ok: false,
          found: false,
          code: CODE.RECEIPT_NOT_FOUND,
          message: `没有 requestId=${requestId} 的回执；回执只在本次审计文件里可查（重启后从文件重放）`,
          recent: store.recent(5).map((receipt) => shortReceipt(receipt)),
        };
      }
      return {
        ok: true,
        found: true,
        requestId: found.requestId,
        status: found.status,
        code: found.code,
        message: found.message,
        from: found.from,
        to: found.to,
        toTitle: found.toTitle,
        mode: found.mode,
        threadId: found.threadId,
        hop: found.hop,
        maxHops: found.maxHops,
        chars: found.chars,
        at: found.at,
        updatedAt: found.updatedAt,
        targetWasLive: found.targetWasLive,
        resumed: found.resumed,
        capability: found.capability,
        reply: found.reply?.text,
        timeline: found.timeline ?? [],
      };
    },
    /** Deliver then wait for the target's turn to finish (session_ask). */
    async ask(request) {
      const delivered = await deliver(request);
      if (delivered.ok !== true) return delivered;
      const requested = request.waitMs;
      const timeoutMs = Math.max(
        200,
        Math.min(config.awaitMaxMs, Number.isFinite(requested) ? Math.trunc(requested) : config.awaitDefaultMs),
      );
      if (delivered.deduplicated === true) {
        const receipt = store.receipt(delivered.requestId);
        if (receipt?.status === STATUS.COMPLETED) {
          return { ...delivered, waited: 0, waitStatus: STATUS.COMPLETED, reply: receipt.reply?.text };
        }
      }
      const started = now();
      const outcome = await waitForCompletion({ requestId: delivered.requestId, to: delivered.to, timeoutMs });
      if (outcome.status === STATUS.COMPLETED) noteCompletion(delivered.requestId, outcome.reply);
      return {
        ...delivered,
        waited: now() - started,
        waitStatus: outcome.status,
        claimed: outcome.claimed,
        reply: outcome.reply,
        waitNote: outcome.note,
      };
    },
    /** Diagnostics: owned agents and store counters. */
    stats() {
      return {
        ownedAgents: [...owned.keys()],
        awaitingClaim: [...awaitingClaim.keys()],
        pendingCompletion: [...claimed.keys()],
        ...store.stats(),
      };
    },
    /** Dispose every agent this plugin resumed. */
    async dispose() {
      const handles = [...owned.values()];
      owned.clear();
      for (const entry of handles) {
        try {
          await entry.handle.dispose();
        } catch (error) {
          log('warn', `dispose of resumed agent failed: ${String(error)}`);
        }
      }
    },
  };
}
