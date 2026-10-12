/**
 * Typed failure vocabulary for dsh-session-link.
 *
 * Every refusal carries a stable machine code plus a human sentence. Tools
 * return these as ordinary (successful) tool results with `ok: false`, so a
 * degraded host or a policy refusal never throws a bare exception into the
 * agent loop — constraint 10 of the task: readable degradation, not log spam.
 *
 * @module dsh-session-link/errors
 */

/** Stable refusal codes. Treat as a public contract; tests assert on them. */
export const CODE = {
  /** The caller is not a session-backed agent (e.g. a headless script). */
  NO_CALLER: 'NO_CALLER',
  /** Neither `sessionId` nor `title` was supplied. */
  TARGET_REQUIRED: 'TARGET_REQUIRED',
  /** No session matches the requested id. */
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  /** Title matching was ambiguous (or empty). */
  TARGET_AMBIGUOUS: 'TARGET_AMBIGUOUS',
  /** Refused: the target is the caller itself (anti self-loop). */
  SELF_SEND: 'SELF_SEND',
  /** Refused: the target session is archived and must not be woken. */
  TARGET_ARCHIVED: 'TARGET_ARCHIVED',
  /** Refused: the thread exhausted its hop budget (anti ping-pong). */
  HOP_BUDGET_EXHAUSTED: 'HOP_BUDGET_EXHAUSTED',
  /** Refused: per-pair rate limit. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Refused: the message body exceeds `maxTextChars`. */
  TEXT_TOO_LONG: 'TEXT_TOO_LONG',
  /** Refused: empty message body. */
  TEXT_EMPTY: 'TEXT_EMPTY',
  /** Refused: `steer`/`inject` need a *running* target. */
  TARGET_NOT_RUNNING: 'TARGET_NOT_RUNNING',
  /** Refused: the resumed target's preset or model would change. */
  CAPABILITY_DRIFT: 'CAPABILITY_DRIFT',
  /** Delivery was accepted but the host could not complete it. */
  DELIVERY_FAILED: 'DELIVERY_FAILED',
  /** A required host service is missing. */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** The host query service failed (persistence/backend problem). */
  QUERY_FAILED: 'QUERY_FAILED',
  /** Unknown requestId in check_delivery. */
  RECEIPT_NOT_FOUND: 'RECEIPT_NOT_FOUND',
  /** Bad tool arguments that the schema cannot express. */
  INVALID_ARGS: 'INVALID_ARGS',
};

/** Code → short Chinese explanation shown to the model. */
const HINTS = {
  [CODE.NO_CALLER]: '调用方不是会话 agent，无法确定发信方身份',
  [CODE.TARGET_REQUIRED]: '必须给 sessionId 或 title 之一',
  [CODE.TARGET_NOT_FOUND]: '找不到该会话，先用 session_list 查 id',
  [CODE.TARGET_AMBIGUOUS]: '标题匹配到多个会话，请改用精确的 sessionId',
  [CODE.SELF_SEND]: '不允许给自己发消息（会导致自激循环）',
  [CODE.TARGET_ARCHIVED]: '目标会话已归档，本插件不唤醒归档会话；请先在 Web UI 取消归档',
  [CODE.HOP_BUDGET_EXHAUSTED]: '该线程的转发跳数已用尽，停止继续转发以免两个会话无限互相唤醒',
  [CODE.RATE_LIMITED]: '发送过于频繁，稍后再试或改用手动方式',
  [CODE.TEXT_TOO_LONG]: '消息过长，请精简后重发',
  [CODE.TEXT_EMPTY]: '消息正文为空',
  [CODE.TARGET_NOT_RUNNING]: 'steer/inject 只对正在运行的会话有效；目标当前空闲，请改用 followup',
  [CODE.CAPABILITY_DRIFT]: '恢复目标会话会改变它的 agent preset 或模型，已拒绝投递',
  [CODE.DELIVERY_FAILED]: '宿主拒绝或中断了本次投递',
  [CODE.SERVICE_UNAVAILABLE]: '宿主服务不可用（本插件需要 ctx.agents / ctx.sessionQuery）',
  [CODE.QUERY_FAILED]: '宿主会话查询失败',
  [CODE.RECEIPT_NOT_FOUND]: '没有这个 requestId 的回执记录',
  [CODE.INVALID_ARGS]: '参数不合法',
};

/**
 * A refusal with a stable code.
 *
 * @extends Error
 */
export class LinkError extends Error {
  /**
   * @param {string} code - one of {@link CODE}.
   * @param {string} message - human sentence appended after the hint.
   * @param {object} [details] - extra machine-readable context.
   */
  constructor(code, message, details) {
    const hint = HINTS[code] ?? '';
    super(hint === '' ? message : `${message}（${hint}）`);
    this.name = 'LinkError';
    this.code = code;
    this.detail = message;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Turn any thrown value into `{ code, message }` without leaking a stack to
 * the model. Host errors keep their `code` property when it is a string.
 *
 * @param {unknown} error - thrown value.
 * @param {string} [fallback] - code to use when none can be recovered.
 * @returns {{ code: string, message: string }} normalized description.
 */
export function describeError(error, fallback = CODE.DELIVERY_FAILED) {
  if (error instanceof LinkError) return { code: error.code, message: error.message };
  if (error instanceof Error) {
    const code = typeof error.code === 'string' && error.code !== '' ? error.code : fallback;
    return { code, message: `${error.name}: ${error.message}` };
  }
  return { code: fallback, message: String(error) };
}
