import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AUDIT_VERSION, createLinkStore, STATUS } from '../lib/store.js';

/** Deterministic clock for window tests. */
function clock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

describe('store folding', () => {
  it('folds a delivery into a receipt, a thread and a fingerprint', () => {
    const store = createLinkStore();
    const receipt = store.fold({
      v: AUDIT_VERSION,
      kind: 'delivery',
      ts: 10,
      requestId: 'req_1',
      thread: 'th_1',
      hop: 1,
      maxHops: 6,
      from: 'session-a',
      to: 'session-b',
      mode: 'followup',
      fingerprint: 'fp_1',
      chars: 12,
    });
    assert.equal(receipt.status, STATUS.DELIVERED);
    assert.equal(receipt.timeline.length, 1);
    assert.equal(store.thread('th_1').hop, 1);
    assert.equal(store.thread('th_1').deliveries, 1);
    assert.equal(store.stats().fingerprints, 1);
  });

  it('advances status in order through status records', () => {
    const store = createLinkStore();
    store.fold({ v: AUDIT_VERSION, kind: 'delivery', ts: 1, requestId: 'req_1', thread: 'th_1', hop: 1, from: 'a', to: 'b' });
    store.fold({ v: AUDIT_VERSION, kind: 'status', ts: 2, requestId: 'req_1', status: STATUS.CLAIMED });
    store.fold({ v: AUDIT_VERSION, kind: 'status', ts: 3, requestId: 'req_1', status: STATUS.COMPLETED, reply: 'done' });
    const receipt = store.receipt('req_1');
    assert.equal(receipt.status, STATUS.COMPLETED);
    assert.equal(receipt.reply.text, 'done');
    assert.deepEqual(receipt.timeline.map((step) => step.status), ['delivered', 'claimed', 'completed']);
  });

  it('records refusals as receipts with a code', () => {
    const store = createLinkStore();
    const receipt = store.fold({ v: AUDIT_VERSION, kind: 'refusal', ts: 5, requestId: 'req_x', code: 'SELF_SEND', message: '拒绝发给自己', from: 'a', to: 'a' });
    assert.equal(receipt.status, STATUS.REFUSED);
    assert.equal(receipt.code, 'SELF_SEND');
  });

  it('rehydrates a whole file and stays consistent', () => {
    const store = createLinkStore();
    const records = [
      { v: AUDIT_VERSION, kind: 'delivery', ts: 1, requestId: 'req_1', thread: 'th_1', hop: 1, maxHops: 4, from: 'a', to: 'b', fingerprint: 'fp' },
      { v: AUDIT_VERSION, kind: 'status', ts: 2, requestId: 'req_1', status: STATUS.CLAIMED },
      { v: AUDIT_VERSION, kind: 'status', ts: 3, requestId: 'req_1', status: STATUS.COMPLETED },
    ];
    assert.equal(store.rehydrate(records), 3);
    assert.equal(store.receipt('req_1').status, STATUS.COMPLETED);
    assert.equal(store.thread('th_1').hop, 1);
  });

  it('replays the same delivery idempotently', () => {
    const store = createLinkStore();
    const delivery = { v: AUDIT_VERSION, kind: 'delivery', ts: 1, requestId: 'req_1', thread: 'th_1', hop: 1, from: 'a', to: 'b' };
    store.fold(delivery);
    store.fold(delivery);
    assert.equal(store.receipt('req_1').timeline.length, 2);
    assert.equal(store.stats().receipts, 1);
  });
});

describe('dedupe window', () => {
  it('hits inside the window and misses after it', () => {
    const time = clock();
    const store = createLinkStore({ now: time.now });
    store.fold({ v: AUDIT_VERSION, kind: 'delivery', ts: time.now(), requestId: 'req_1', thread: 'th_1', hop: 1, from: 'a', to: 'b', fingerprint: 'fp' });
    assert.equal(store.dedupeHit('fp', 1000).requestId, 'req_1');
    time.advance(1001);
    assert.equal(store.dedupeHit('fp', 1000), undefined);
  });

  it('ignores refusals and failures as duplicates', () => {
    const store = createLinkStore();
    store.fold({ v: AUDIT_VERSION, kind: 'delivery', ts: 1, requestId: 'req_1', thread: 'th_1', hop: 1, from: 'a', to: 'b', fingerprint: 'fp' });
    store.fold({ v: AUDIT_VERSION, kind: 'status', ts: 2, requestId: 'req_1', status: STATUS.FAILED });
    assert.equal(store.dedupeHit('fp', 10_000), undefined);
  });
});

describe('rate limiter', () => {
  it('allows the limit then refuses with a retry hint, and resets next window', () => {
    const time = clock();
    const store = createLinkStore({ now: time.now });
    for (let index = 0; index < 3; index += 1) {
      assert.equal(store.rate('a->b', 3, 1000).allowed, true);
    }
    const refused = store.rate('a->b', 3, 1000);
    assert.equal(refused.allowed, false);
    assert.ok(refused.retryAfterMs > 0 && refused.retryAfterMs <= 1000);
    time.advance(1000);
    assert.equal(store.rate('a->b', 3, 1000).allowed, true);
  });

  it('is a no-op when the limit is disabled', () => {
    const store = createLinkStore();
    for (let index = 0; index < 100; index += 1) assert.equal(store.rate('a->b', 0, 1000).allowed, true);
  });
});

describe('receipt retention', () => {
  it('keeps at most maxReceipts entries', () => {
    const store = createLinkStore({ maxReceipts: 3 });
    for (let index = 0; index < 10; index += 1) {
      store.fold({ v: AUDIT_VERSION, kind: 'delivery', ts: index, requestId: `req_${index}`, thread: `th_${index}`, hop: 1, from: 'a', to: 'b' });
    }
    assert.equal(store.stats().receipts, 3);
    assert.equal(store.receipt('req_9').status, STATUS.DELIVERED);
    assert.equal(store.receipt('req_0'), undefined);
  });

  it('lists newest first', () => {
    const store = createLinkStore();
    store.fold({ v: AUDIT_VERSION, kind: 'delivery', ts: 1, requestId: 'req_old', thread: 'th_1', hop: 1, from: 'a', to: 'b' });
    store.fold({ v: AUDIT_VERSION, kind: 'delivery', ts: 2, requestId: 'req_new', thread: 'th_2', hop: 1, from: 'a', to: 'b' });
    assert.deepEqual(store.recent(2).map((receipt) => receipt.requestId), ['req_new', 'req_old']);
  });
});

describe('threads', () => {
  it('opens once and keeps the widest hop', () => {
    const store = createLinkStore();
    const thread = store.openThread('th_1', { maxHops: 4, origin: 'a' });
    assert.equal(thread.hop, 0);
    store.openThread('th_1', { maxHops: 9, origin: 'b' });
    assert.equal(store.thread('th_1').maxHops, 9);
    assert.equal(store.thread('th_1').origin, 'a');
  });
});
