/**
 * In-memory projection of the audit log: receipts, threads, dedupe and rate
 * limiting.
 *
 * The store is *derived state*: every mutation is expressed as one audit
 * record, and `fold()` is the single place that interprets records. Boot
 * replays the audit file through the same `fold()`, so a restart cannot make
 * the in-memory picture disagree with the durable one (constraint 7 + 8:
 * receipts survive the process; duplicate `requestId`s stay duplicates).
 *
 * @module dsh-session-link/store
 */
import { mintId } from './ids.js';

/** Audit schema version written into every record. */
export const AUDIT_VERSION = 1;

/** Receipt statuses, in the order they can advance. */
export const STATUS = {
  DELIVERED: 'delivered',
  CLAIMED: 'claimed',
  COMPLETED: 'completed',
  REFUSED: 'refused',
  FAILED: 'failed',
};

/**
 * Create the store.
 *
 * @param {object} [options] - store options.
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @param {number} [options.maxReceipts] - hard cap on retained receipts.
 * @param {number} [options.receiptTtlMs] - receipts older than this are pruned.
 * @returns {object} store handle.
 */
export function createLinkStore({ now = Date.now, maxReceipts = 5000, receiptTtlMs = 24 * 60 * 60 * 1000 } = {}) {
  /** @type {Map<string, object>} requestId → receipt */
  const receipts = new Map();
  /** @type {Map<string, object>} threadId → thread */
  const threads = new Map();
  /** @type {Map<string, { requestId: string, at: number }>} fingerprint → last delivery */
  const fingerprints = new Map();
  /** @type {Map<string, { windowStart: number, count: number }>} pair key → window */
  const rates = new Map();

  function prune() {
    if (receipts.size <= maxReceipts) return;
    const cutoff = now() - receiptTtlMs;
    for (const [key, receipt] of receipts) {
      if (receipts.size <= maxReceipts) break;
      if (receipt.at < cutoff) receipts.delete(key);
    }
    // Still oversized (e.g. a burst of fresh receipts): drop oldest insertion order.
    while (receipts.size > maxReceipts) {
      const oldest = receipts.keys().next();
      if (oldest.done === true) break;
      receipts.delete(oldest.value);
    }
  }

  function foldThread(record) {
    const threadId = record.thread;
    if (typeof threadId !== 'string' || threadId === '') return;
    const existing = threads.get(threadId);
    const hop = Number.isFinite(record.hop) ? record.hop : 1;
    if (existing === undefined) {
      threads.set(threadId, {
        threadId,
        origin: record.from,
        createdAt: record.ts ?? now(),
        updatedAt: record.ts ?? now(),
        hop,
        maxHops: Number.isFinite(record.maxHops) ? record.maxHops : 1,
        deliveries: record.kind === 'delivery' ? 1 : 0,
      });
      return;
    }
    existing.hop = Math.max(existing.hop, hop);
    existing.updatedAt = record.ts ?? now();
    if (Number.isFinite(record.maxHops)) existing.maxHops = record.maxHops;
    if (record.kind === 'delivery') existing.deliveries += 1;
  }

  function foldStatus(record) {
    const receipt = receipts.get(record.requestId);
    if (receipt === undefined) return;
    receipt.status = record.status;
    receipt.updatedAt = record.ts ?? now();
    receipt.timeline.push({ at: record.ts ?? now(), status: record.status, detail: record.detail });
    if (typeof record.reply === 'string') receipt.reply = { text: record.reply, at: record.ts ?? now() };
  }

  /**
   * Apply one audit record. Idempotent for delivery/refusal records: replaying
   * the same `requestId` overwrites rather than duplicating.
   *
   * @param {object} record - audit record.
   * @returns {object|undefined} the affected receipt, when there is one.
   */
  function fold(record) {
    if (record === null || typeof record !== 'object') return undefined;
    const ts = Number.isFinite(record.ts) ? record.ts : now();

    if (record.kind === 'delivery' || record.kind === 'refusal') {
      const requestId = typeof record.requestId === 'string' ? record.requestId : mintId('req');
      const existing = receipts.get(requestId);
      const receipt =
        existing ??
        {
          requestId,
          threadId: record.thread,
          hop: record.hop,
          maxHops: record.maxHops,
          from: record.from,
          to: record.to,
          toTitle: record.toTitle,
          mode: record.mode,
          fingerprint: record.fingerprint,
          chars: record.chars,
          timeline: [],
        };
      receipt.status = record.kind === 'delivery' ? STATUS.DELIVERED : STATUS.REFUSED;
      receipt.code = record.code;
      receipt.message = record.message;
      receipt.at = ts;
      receipt.updatedAt = ts;
      receipt.targetWasLive = record.targetWasLive;
      receipt.resumed = record.resumed;
      receipt.capability = record.capability;
      receipt.timeline.push({ at: ts, status: receipt.status, detail: record.message });
      receipts.set(requestId, receipt);
      if (typeof record.fingerprint === 'string' && record.kind === 'delivery') {
        fingerprints.set(record.fingerprint, { requestId, at: ts });
      }
      foldThread({ ...record, ts });
      prune();
      return receipt;
    }

    if (record.kind === 'status') {
      foldStatus({ ...record, ts });
      return receipts.get(record.requestId);
    }

    return undefined;
  }

  return {
    /** Fold one record (live path and boot rehydration share this). */
    fold,
    /**
     * Replay a whole audit file.
     *
     * @param {Iterable<object>} records - parsed audit records.
     * @returns {number} number of records applied.
     */
    rehydrate(records) {
      let count = 0;
      for (const record of records) {
        if (record?.v !== AUDIT_VERSION && record?.kind === undefined) continue;
        fold(record);
        count += 1;
      }
      return count;
    },
    /** @returns {object|undefined} receipt by request id. */
    receipt(requestId) {
      return receipts.get(String(requestId ?? ''));
    },
    /**
     * Implicit-idempotency lookup.
     *
     * @param {string} fingerprint - content fingerprint.
     * @param {number} windowMs - dedupe window.
     * @returns {object|undefined} the receipt of a *delivered* duplicate.
     */
    dedupeHit(fingerprint, windowMs) {
      const hit = fingerprints.get(fingerprint);
      if (hit === undefined) return undefined;
      if (now() - hit.at > windowMs) return undefined;
      const receipt = receipts.get(hit.requestId);
      if (receipt === undefined) return undefined;
      if (receipt.status === STATUS.REFUSED || receipt.status === STATUS.FAILED) return undefined;
      return receipt;
    },
    /**
     * Fixed-window rate limiter.
     *
     * @param {string} key - limiter key, usually `from->to`.
     * @param {number} limit - allowed sends per window.
     * @param {number} windowMs - window length.
     * @returns {{ allowed: boolean, count: number, retryAfterMs: number }} decision.
     */
    rate(key, limit, windowMs) {
      if (!Number.isFinite(limit) || limit <= 0) return { allowed: true, count: 0, retryAfterMs: 0 };
      const at = now();
      const bucket = rates.get(key);
      if (bucket === undefined || at - bucket.windowStart >= windowMs) {
        rates.set(key, { windowStart: at, count: 1 });
        return { allowed: true, count: 1, retryAfterMs: 0 };
      }
      bucket.count += 1;
      if (bucket.count > limit) {
        return { allowed: false, count: bucket.count, retryAfterMs: windowMs - (at - bucket.windowStart) };
      }
      return { allowed: true, count: bucket.count, retryAfterMs: 0 };
    },
    /**
     * Open (or reopen) a thread with a hop budget.
     *
     * @param {string} threadId - thread id.
     * @param {object} spec - `{ maxHops, origin }`.
     * @returns {object} thread record.
     */
    openThread(threadId, spec) {
      const existing = threads.get(threadId);
      if (existing !== undefined) {
        if (Number.isFinite(spec.maxHops)) existing.maxHops = spec.maxHops;
        return existing;
      }
      const thread = {
        threadId,
        origin: spec.origin,
        createdAt: now(),
        updatedAt: now(),
        hop: 0,
        maxHops: Number.isFinite(spec.maxHops) ? spec.maxHops : 1,
        deliveries: 0,
      };
      threads.set(threadId, thread);
      return thread;
    },
    /** @returns {object|undefined} thread record. */
    thread(threadId) {
      return threads.get(String(threadId ?? ''));
    },
    /**
     * Receipts, newest first.
     *
     * @param {number} limit - maximum rows.
     * @returns {object[]} receipts.
     */
    recent(limit = 20) {
      return [...receipts.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, Math.max(0, limit));
    },
    /** Counters for diagnostics. */
    stats() {
      return { receipts: receipts.size, threads: threads.size, fingerprints: fingerprints.size, rateKeys: rates.size };
    },
  };
}
