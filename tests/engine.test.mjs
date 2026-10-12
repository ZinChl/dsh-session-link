import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEngine, resolveConfig } from '../lib/engine.js';
import { STATUS, createLinkStore } from '../lib/store.js';
import { createHost, fakeCreateUserMessage } from './helpers/host.mjs';

/** Build a session fixture with a recorded model route. */
function sessionFixture(id, overrides = {}) {
  return {
    id,
    title: overrides.title ?? `会话 ${id}`,
    cwd: overrides.cwd ?? `/tmp/${id}`,
    agentPreset: overrides.agentPreset ?? 'bot',
    updatedAt: overrides.updatedAt ?? 1000,
    requestContext: { provider: 'deepseek-official', model: 'deepseek-flash' },
    events: [
      {
        type: 'request/header',
        seq: 1,
        time: 900,
        data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } }, reason: 'initial' },
      },
    ],
    ...overrides,
  };
}

/** Wire a fake host to a real engine + store, with an in-memory audit sink. */
function setup({ sessions = [], archived = [], config = {}, now } = {}) {
  const host = createHost({ sessions, archived });
  const store = createLinkStore({ now });
  const records = [];
  const audit = {
    path: 'memory',
    append: async (record) => {
      records.push(record);
    },
    load: async () => records,
    flush: async () => {},
  };
  const effective = resolveConfig(config);
  const engine = createEngine({
    ctx: host.ctx,
    store,
    audit,
    config: effective,
    createUserMessage: fakeCreateUserMessage,
    now,
  });
  return { host, store, records, engine, config: effective };
}

const BASE = { senderId: 'session-a', senderTitle: 'A 会话', sessionId: 'session-b', text: '请回复 pong', mode: 'followup' };

/** The single inbox entry a live agent received. */
function inbox(host, id = 'session-b') {
  return host.live.get(id)?.inbox ?? [];
}

describe('delivery to a live session', () => {
  it('delivers a followup envelope without resuming anything', async () => {
    const { host, engine, records } = setup({ sessions: [sessionFixture('session-b')] });
    host.publish('session-b');
    const result = await engine.deliver(BASE);
    assert.equal(result.ok, true);
    assert.equal(result.to, 'session-b');
    assert.equal(result.mode, 'followup');
    assert.equal(result.targetWasLive, true);
    assert.equal(result.resumed, false);
    assert.equal(host.resumeCalls.length, 0);
    const entries = inbox(host);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].mode, 'followup');
    const body = entries[0].message.content[0].text;
    assert.ok(body.includes('<agent_message '));
    assert.ok(body.includes('from="session-a"'));
    assert.ok(body.includes('请回复 pong'));
    assert.ok(entries[0].message.source.kind === 'plugin:dsh-session-link');
    assert.equal(records.filter((record) => record.kind === 'delivery').length, 1);
    assert.equal(records[0].to, 'session-b');
    assert.equal(records[0].mode, 'followup');
  });

  it('rejects an empty or oversized body', async () => {
    const { engine } = setup({ sessions: [sessionFixture('session-b')], config: { maxTextChars: 10 } });
    assert.equal((await engine.deliver({ ...BASE, text: '   ' })).code, 'TEXT_EMPTY');
    assert.equal((await engine.deliver({ ...BASE, text: 'x'.repeat(11) })).code, 'TEXT_TOO_LONG');
  });

  it('reports SERVICE_UNAVAILABLE when the host has no agents service', async () => {
    const host = createHost({ sessions: [sessionFixture('session-b')] });
    host.services.agents = undefined;
    const store = createLinkStore();
    const engine = createEngine({
      ctx: host.ctx,
      store,
      audit: { path: 'memory', append: async () => {}, load: async () => [], flush: async () => {} },
      config: resolveConfig({}),
      createUserMessage: fakeCreateUserMessage,
    });
    const result = await engine.deliver(BASE);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SERVICE_UNAVAILABLE');
  });
});

describe('constraint: never send to yourself', () => {
  it('refuses and writes a refusal audit line', async () => {
    const { host, engine, records } = setup({ sessions: [sessionFixture('session-a')] });
    host.publish('session-a');
    const result = await engine.deliver({ ...BASE, sessionId: 'session-a' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SELF_SEND');
    assert.equal(inbox(host, 'session-a').length, 0);
    assert.equal(records.at(-1).kind, 'refusal');
    assert.equal(records.at(-1).code, 'SELF_SEND');
  });
});

describe('constraint: archived sessions are refused and never woken', () => {
  it('refuses without resuming or delivering', async () => {
    const { host, engine, records } = setup({ sessions: [sessionFixture('session-b')], archived: ['session-b'] });
    const result = await engine.deliver(BASE);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TARGET_ARCHIVED');
    assert.equal(host.resumeCalls.length, 0);
    assert.equal(host.live.size, 0);
    assert.equal(records.at(-1).code, 'TARGET_ARCHIVED');
  });
});

describe('constraint: a cold session is resumed with its own capability set', () => {
  it('resumes with the target’s OWN recorded route and preset, never the caller’s', async () => {
    const session = sessionFixture('session-b');
    // The target last ran on a different route than the deployment default; the
    // resume must replay the target's own route.
    session.requestContext = { provider: 'target-provider', model: 'target-model' };
    session.events = [
      {
        type: 'request/header',
        seq: 1,
        time: 900,
        data: { header: { config: { provider: 'target-provider', model: 'target-model' } }, reason: 'initial' },
      },
    ];
    const { host, engine } = setup({ sessions: [session] });
    const result = await engine.deliver(BASE);
    assert.equal(result.ok, true);
    assert.equal(result.resumed, true);
    assert.equal(result.targetWasLive, false);
    assert.equal(host.resumeCalls.length, 1);
    const call = host.resumeCalls[0];
    assert.deepEqual(Object.keys(call).sort(), ['agentOptions', 'resumeSessionId', 'setup']);
    assert.equal(call.resumeSessionId, 'session-b');
    assert.deepEqual(call.agentOptions, { provider: 'target-provider', model: 'target-model' });
    assert.notEqual(call.agentOptions.model, 'deployment-default-model');
    // The preset is mounted through ctx.agentPresets, as the web controller does.
    assert.deepEqual(host.presetResolveCalls, ['bot']);
    assert.deepEqual(host.presetMounts.map((entry) => entry.id), ['bot']);
    assert.equal(result.capability.resumeRoute, 'target-record');
    assert.equal(result.capability.presetId, 'bot');
  });

  it('falls back to the deployment default route only when the target recorded none', async () => {
    const session = sessionFixture('session-b');
    session.events = [];
    delete session.requestContext;
    const { host, engine } = setup({ sessions: [session] });
    const result = await engine.deliver(BASE);
    assert.equal(result.ok, true);
    assert.deepEqual(host.resumeCalls[0].agentOptions, {
      provider: 'deepseek-official',
      model: 'deployment-default-model',
    });
    assert.equal(result.capability.resumeRoute, 'deployment-default');
  });

  it('resumes a preset-less target without a setup callback', async () => {
    const session = sessionFixture('session-b');
    session.agentPreset = undefined;
    const { host, engine } = setup({ sessions: [session] });
    const result = await engine.deliver(BASE);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(host.resumeCalls[0]).sort(), ['agentOptions', 'resumeSessionId']);
    assert.deepEqual(host.presetMounts, []);
    assert.equal(result.capability.presetId, undefined);
  });

  it('refuses instead of downgrading when the target’s preset cannot be composed', async () => {
    const session = sessionFixture('session-b', { agentPreset: 'ghost-preset' });
    const { host, engine, records } = setup({ sessions: [session] });
    const result = await engine.deliver(BASE);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CAPABILITY_DRIFT');
    assert.equal(host.resumeCalls.length, 0, 'no agent may be resumed under a different composition');
    assert.equal(host.live.size, 0);
    assert.match(records.at(-1).message, /ghost-preset/);
  });

  it('records the preset and model route before and after, and reports no drift', async () => {
    const { engine } = setup({ sessions: [sessionFixture('session-b')] });
    const result = await engine.deliver(BASE);
    assert.equal(result.capability.guarded, true);
    assert.equal(result.capability.drift, false);
    assert.equal(result.capability.presetBefore, 'bot');
    assert.equal(result.capability.presetAfter, 'bot');
    assert.equal(result.capability.modelBefore, 'deepseek-flash');
    assert.equal(result.capability.modelAfter, 'deepseek-flash');
  });

  it('refuses and rolls back when resuming would change the agent preset', async () => {
    const session = sessionFixture('session-b');
    const { host, engine, records } = setup({ sessions: [session] });
    // Simulate a host whose resume composes a different preset.
    host.records.get('session-b').livePreset = 'standard';
    const result = await engine.deliver(BASE);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CAPABILITY_DRIFT');
    assert.equal(host.live.size, 0, 'the drifted agent must be disposed');
    assert.equal(records.at(-1).code, 'CAPABILITY_DRIFT');
    assert.equal(records.at(-1).capability.presetAfter, 'standard');
  });

  it('refuses when resuming would change the model route', async () => {
    const session = sessionFixture('session-b');
    const { host, engine } = setup({ sessions: [session] });
    host.records.get('session-b').requestContext = { provider: 'deepseek-official', model: 'deepseek-v4-pro' };
    const result = await engine.deliver(BASE);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CAPABILITY_DRIFT');
    assert.equal(host.live.size, 0);
  });

  it('turns the guard off when verifyCapability=false', async () => {
    const { host, engine } = setup({ sessions: [sessionFixture('session-b')], config: { verifyCapability: false } });
    host.records.get('session-b').livePreset = 'standard';
    const result = await engine.deliver(BASE);
    assert.equal(result.ok, true);
    assert.equal(result.capability.guarded, false);
  });

  it('refuses an unknown session id', async () => {
    const { engine } = setup({ sessions: [] });
    const result = await engine.deliver({ ...BASE, sessionId: 'session-ghost' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TARGET_NOT_FOUND');
  });
});

describe('thread hop budget', () => {
  it('allows exactly maxHops deliveries on one thread, then refuses', async () => {
    const { engine } = setup({ sessions: [sessionFixture('session-b')], config: { maxHops: 2 } });
    const first = await engine.deliver({ ...BASE, requestId: 'req_1' });
    assert.equal(first.ok, true);
    assert.equal(first.hop, 1);
    const thread = first.threadId;
    const second = await engine.deliver({ ...BASE, requestId: 'req_2', threadId: thread, text: '第二次' });
    assert.equal(second.ok, true);
    assert.equal(second.hop, 2);
    const third = await engine.deliver({ ...BASE, requestId: 'req_3', threadId: thread, text: '第三次' });
    assert.equal(third.ok, false);
    assert.equal(third.code, 'HOP_BUDGET_EXHAUSTED');
    assert.equal(third.hop, 3);
  });
});

describe('idempotency', () => {
  it('does not deliver twice for the same explicit requestId', async () => {
    const { host, engine } = setup({ sessions: [sessionFixture('session-b')] });
    host.publish('session-b');
    const first = await engine.deliver({ ...BASE, requestId: 'req_fixed' });
    const second = await engine.deliver({ ...BASE, requestId: 'req_fixed' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.deduplicated, true);
    assert.equal(second.requestId, 'req_fixed');
    assert.equal(inbox(host).length, 1, 'the target must receive exactly one message');
  });

  it('does not deliver twice for identical content inside the dedupe window', async () => {
    let now = 1_000_000;
    const { host, engine } = setup({ sessions: [sessionFixture('session-b')], config: { dedupeWindowMs: 1000 }, now: () => now });
    host.publish('session-b');
    const first = await engine.deliver(BASE);
    const second = await engine.deliver(BASE);
    assert.equal(second.deduplicated, true);
    assert.equal(second.requestId, first.requestId);
    assert.equal(inbox(host).length, 1);
    // Outside the window the same content is delivered again.
    now += 5000;
    const third = await engine.deliver(BASE);
    assert.equal(third.deduplicated, false);
    assert.equal(inbox(host).length, 2);
  });
});

describe('rate limiting', () => {
  it('refuses past the per-pair budget and explains the wait', async () => {
    const { engine } = setup({
      sessions: [sessionFixture('session-b'), sessionFixture('session-c')],
      config: { rateLimitPerMinute: 2 },
    });
    assert.equal((await engine.deliver({ ...BASE, requestId: 'r1' })).ok, true);
    assert.equal((await engine.deliver({ ...BASE, requestId: 'r2', text: '不同内容 1' })).ok, true);
    const third = await engine.deliver({ ...BASE, requestId: 'r3', text: '不同内容 2' });
    assert.equal(third.ok, false);
    assert.equal(third.code, 'RATE_LIMITED');
    // A different receiver has its own budget.
    const other = await engine.deliver({ ...BASE, sessionId: 'session-c', text: '给 C' });
    assert.equal(other.ok, true);
  });
});

describe('delivery modes', () => {
  it('refuses steer on an idle target instead of silently degrading', async () => {
    const { host, engine } = setup({ sessions: [sessionFixture('session-b')] });
    host.publish('session-b');
    const result = await engine.deliver({ ...BASE, mode: 'steer' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TARGET_NOT_RUNNING');
    assert.equal(result.targetStatus, 'idle');
    assert.equal(inbox(host).length, 0);
  });

  it('steers a running target', async () => {
    const { host, engine } = setup({ sessions: [sessionFixture('session-b')] });
    const agent = host.publish('session-b');
    agent.status = 'running';
    const result = await engine.deliver({ ...BASE, mode: 'steer' });
    assert.equal(result.ok, true);
    assert.equal(inbox(host)[0].mode, 'steer');
  });

  it('injects context into a running target', async () => {
    const { host, engine } = setup({ sessions: [sessionFixture('session-b')] });
    host.publish('session-b').status = 'running';
    const result = await engine.deliver({ ...BASE, mode: 'inject' });
    assert.equal(result.ok, true);
    assert.equal(inbox(host)[0].mode, 'inject');
  });

  it('falls back to followup for an unknown mode string', async () => {
    const { host, engine } = setup({ sessions: [sessionFixture('session-b')] });
    host.publish('session-b');
    const result = await engine.deliver({ ...BASE, mode: 'telepathy' });
    assert.equal(result.ok, true);
    assert.equal(inbox(host)[0].mode, 'followup');
  });
});

describe('target resolution by title', () => {
  it('resolves a single match', async () => {
    const { host, engine } = setup({
      sessions: [sessionFixture('session-b', { title: 'FPGA 时序' }), sessionFixture('session-c', { title: '前端' })],
    });
    const result = await engine.deliver({ ...BASE, sessionId: undefined, title: 'FPGA 时序' });
    assert.equal(result.ok, true);
    assert.equal(result.to, 'session-b');
    assert.equal(result.toTitle, 'FPGA 时序');
    assert.equal(host.resumeCalls.length, 1);
  });

  it('refuses an ambiguous title', async () => {
    const { engine } = setup({
      sessions: [sessionFixture('session-b', { title: 'FPGA 时序' }), sessionFixture('session-c', { title: 'FPGA 时序 2' })],
    });
    const result = await engine.deliver({ ...BASE, sessionId: undefined, title: 'FPGA' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TARGET_AMBIGUOUS');
  });

  it('refuses when nothing matches and when neither argument is given', async () => {
    const { engine } = setup({ sessions: [sessionFixture('session-b')] });
    assert.equal((await engine.deliver({ ...BASE, sessionId: undefined, title: '不存在' })).code, 'TARGET_NOT_FOUND');
    assert.equal((await engine.deliver({ ...BASE, sessionId: undefined })).code, 'TARGET_REQUIRED');
  });
});

describe('receipts', () => {
  it('advances delivered → claimed → completed with the reply', async () => {
    const { host, engine } = setup({ sessions: [sessionFixture('session-b')] });
    host.publish('session-b');
    const result = await engine.deliver({ ...BASE, requestId: 'req_track' });
    assert.equal(engine.receipt('req_track').status, STATUS.DELIVERED);

    const entry = inbox(host)[0];
    host.emit('agent/inbox/claimed', { agent: host.live.get('session-b'), message: entry.message, turn: 1 });
    assert.equal(engine.receipt('req_track').status, STATUS.CLAIMED);

    host.emit('session/event', { id: 'session-b' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'pong' }] } } });
    host.emit('session/event', { id: 'session-b' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    const receipt = engine.receipt('req_track');
    assert.equal(receipt.status, STATUS.COMPLETED);
    assert.equal(receipt.reply, 'pong');
    assert.deepEqual(receipt.timeline.map((step) => step.status), ['delivered', 'claimed', 'completed']);
    assert.equal(result.requestId, 'req_track');
  });

  it('ignores claims for foreign messages', async () => {
    const { host, engine } = setup({ sessions: [sessionFixture('session-b')] });
    host.publish('session-b');
    await engine.deliver({ ...BASE, requestId: 'req_track' });
    host.emit('agent/inbox/claimed', {
      agent: host.live.get('session-b'),
      message: { content: [{ type: 'text', text: '普通消息，没有信封' }] },
      turn: 1,
    });
    assert.equal(engine.receipt('req_track').status, STATUS.DELIVERED);
  });

  it('answers RECEIPT_NOT_FOUND with recent receipts', async () => {
    const { host, engine } = setup({ sessions: [sessionFixture('session-b')] });
    host.publish('session-b');
    await engine.deliver({ ...BASE, requestId: 'req_known' });
    const missing = engine.receipt('req_unknown');
    assert.equal(missing.found, false);
    assert.equal(missing.code, 'RECEIPT_NOT_FOUND');
    assert.equal(missing.recent[0].requestId, 'req_known');
  });
});

describe('session_ask (request/response)', () => {
  it('returns the target reply once its turn ends', async () => {
    const { host, engine } = setup({ sessions: [sessionFixture('session-b')] });
    host.publish('session-b');
    const pending = engine.ask({ ...BASE, requestId: 'req_ask', waitMs: 2000 });
    // Give the delivery a tick, then play the target's side.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const entry = inbox(host)[0];
    host.emit('agent/inbox/claimed', { agent: host.live.get('session-b'), message: entry.message, turn: 1 });
    host.emit('session/event', { id: 'session-b' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '结果是 42' }] } } });
    host.emit('session/event', { id: 'session-b' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.waitStatus, STATUS.COMPLETED);
    assert.equal(result.claimed, true);
    assert.equal(result.reply, '结果是 42');
    assert.equal(engine.receipt('req_ask').status, STATUS.COMPLETED);
  });

  it('times out without losing the delivery', async () => {
    const { host, engine } = setup({ sessions: [sessionFixture('session-b')], config: { awaitMaxMs: 1000 } });
    host.publish('session-b');
    const result = await engine.ask({ ...BASE, requestId: 'req_slow', waitMs: 1000 });
    assert.equal(result.ok, true);
    assert.equal(result.waitStatus, 'unclaimed');
    assert.equal(inbox(host).length, 1, 'the message stays delivered');
    assert.equal(engine.receipt('req_slow').status, STATUS.DELIVERED);
  });
});

describe('lifecycle', () => {
  it('disposes the agents it resumed', async () => {
    const { host, engine } = setup({ sessions: [sessionFixture('session-b')] });
    await engine.deliver(BASE);
    assert.equal(host.live.size, 1);
    await engine.dispose();
    assert.equal(host.live.size, 0);
  });

  it('keeps delivery state consistent between memory and the audit file', async () => {
    const { host, engine, records, store } = setup({ sessions: [sessionFixture('session-b')] });
    host.publish('session-b');
    await engine.deliver({ ...BASE, requestId: 'req_audit' });
    const replay = createLinkStore();
    replay.rehydrate(records);
    assert.equal(replay.receipt('req_audit').status, STATUS.DELIVERED);
    assert.equal(replay.receipt('req_audit').to, 'session-b');
    assert.equal(store.receipt('req_audit').status, replay.receipt('req_audit').status);
  });
});
