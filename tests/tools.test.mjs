import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { mountSessionLink } from '../lib/mount.js';
import { createHost, fakeCreateUserMessage } from './helpers/host.mjs';
import { assertLosslessJson, validate } from './helpers/schema.mjs';

/** `defineTool` stand-in: keeps the options object, which is all the host adds. */
function fakeDefineTool(options) {
  return options;
}

function sessionFixture(id, overrides = {}) {
  return {
    id,
    title: overrides.title ?? `会话 ${id}`,
    cwd: `/tmp/${id}`,
    agentPreset: 'bot',
    updatedAt: 1000,
    requestContext: { provider: 'deepseek-official', model: 'deepseek-flash' },
    events: [],
    ...overrides,
  };
}

async function mount({ sessions = [], archived = [], config = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsl-mount-'));
  const host = createHost({ sessions, archived });
  const result = await mountSessionLink({
    ctx: host.ctx,
    config: { auditFile: join(dir, 'audit.ndjson'), ...config },
    defineTool: fakeDefineTool,
    createUserMessage: fakeCreateUserMessage,
  });
  const byName = new Map(host.registeredTools.map((tool) => [tool.name, tool]));
  return { host, dir, ...result, byName };
}

/** Build the `exec` object a tool receives from the agent loop. */
function exec(sessionId = 'session-a') {
  return {
    callId: 'call_1',
    agent: { id: sessionId, session: { id: sessionId } },
    signal: new AbortController().signal,
  };
}

describe('mount wiring', () => {
  it('registers exactly the five documented tools, in order', async () => {
    const { toolNames, host } = await mount();
    assert.deepEqual(toolNames, ['session_list', 'session_read', 'session_send', 'session_ask', 'check_delivery']);
    assert.equal(host.registeredTools.length, 5);
  });

  it('gives every tool a model-facing description, a parameter schema and a render function', async () => {
    const { host } = await mount();
    const registeredTools = host.registeredTools;
    for (const tool of registeredTools) {
      assert.equal(typeof tool.name, 'string');
      assert.ok(tool.description.length > 80, `${tool.name} description too short`);
      assert.equal(typeof tool.parameters, 'object');
      assert.equal(typeof tool.output.schema, 'object');
      assert.equal(typeof tool.output.render, 'function');
      assert.equal(typeof tool.execute, 'function');
    }
  });

  it('survives a definition the host rejects, keeping the other tools', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsl-baddef-'));
    const host = createHost({ sessions: [sessionFixture('session-b')] });
    const warnings = [];
    const errors = [];
    const ctx = { ...host.ctx, logger: { info() {}, debug() {}, warn: (m) => warnings.push(m), error: (m) => errors.push(m) } };
    const result = await mountSessionLink({
      ctx,
      config: { auditFile: join(dir, 'a.ndjson') },
      // Reject exactly one definition, the way a schema the host cannot compile would.
      defineTool: (options) => {
        if (options.name === 'session_send') throw new Error('unsupported JSON schema: parameters.type');
        return options;
      },
      createUserMessage: fakeCreateUserMessage,
    });
    assert.deepEqual(result.failed, ['session_send']);
    assert.deepEqual(result.toolNames, ['session_list', 'session_read', 'session_ask', 'check_delivery']);
    assert.equal(host.registeredTools.length, 4);
    assert.match(errors.join('\n'), /session_send 的定义被宿主拒绝/);
    void warnings;
  });

  it('survives a duplicate registration and still mounts the rest', async () => {
    const host = createHost({ sessions: [] });
    const warnings = [];
    const ctx = {
      ...host.ctx,
      logger: { info() {}, debug() {}, warn: (message) => warnings.push(message) },
      tools: {
        register: (definition) => {
          if (definition.name === 'session_list') throw new Error('duplicate tool name');
          host.registeredTools.push(definition);
        },
      },
    };
    const result = await mountSessionLink({
      ctx,
      config: { auditFile: join(await mkdtemp(join(tmpdir(), 'dsl-dup-')), 'a.ndjson') },
      defineTool: fakeDefineTool,
      createUserMessage: fakeCreateUserMessage,
    });
    assert.deepEqual(result.toolNames, ['session_read', 'session_send', 'session_ask', 'check_delivery']);
    assert.deepEqual(result.failed, ['session_list']);
    assert.ok(warnings.some((message) => /注册工具 session_list 失败/.test(message)));
    assert.ok(warnings.some((message) => /1 个工具未生效：session_list/.test(message)));
  });

  it('logs the mount with the audit path and limits', async () => {
    const messages = [];
    const host = createHost();
    const ctx = { ...host.ctx, logger: { info: (message) => messages.push(message), warn() {}, debug() {} } };
    const dir = await mkdtemp(join(tmpdir(), 'dsl-log-'));
    await mountSessionLink({
      ctx,
      config: { auditFile: join(dir, 'audit.ndjson'), maxHops: 4, rateLimitPerMinute: 7 },
      defineTool: fakeDefineTool,
      createUserMessage: fakeCreateUserMessage,
    });
    assert.equal(messages.length, 1);
    assert.match(messages[0], /dsh-session-link: 已挂载/);
    assert.match(messages[0], /跳数上限 4/);
    assert.match(messages[0], /限流 7\/分钟/);
  });

  it('replays the audit file at mount so receipts survive a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsl-replay-'));
    const file = join(dir, 'audit.ndjson');
    const first = await mountSessionLink({
      ctx: createHost().ctx,
      config: { auditFile: file },
      defineTool: fakeDefineTool,
      createUserMessage: fakeCreateUserMessage,
    });
    void first;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      file,
      `${JSON.stringify({ v: 1, kind: 'delivery', ts: 1, requestId: 'req_old', thread: 'th_1', hop: 1, from: 'session-a', to: 'session-b', mode: 'followup' })}\n`,
      'utf8',
    );
    const second = await mountSessionLink({
      ctx: createHost().ctx,
      config: { auditFile: file },
      defineTool: fakeDefineTool,
      createUserMessage: fakeCreateUserMessage,
    });
    assert.equal(second.store.receipt('req_old').status, 'delivered');
    assert.equal(second.engine.receipt('req_old').found, true);
  });

  it('does not let a broken audit path block the mount', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsl-broken-'));
    const warnings = [];
    const host = createHost();
    const ctx = { ...host.ctx, logger: { info() {}, debug() {}, warn: (message) => warnings.push(message) } };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'blocked'), 'file', 'utf8');
    const result = await mountSessionLink({
      ctx,
      config: { auditFile: join(dir, 'blocked', 'audit.ndjson') },
      defineTool: fakeDefineTool,
      createUserMessage: fakeCreateUserMessage,
    });
    assert.equal(result.toolNames.length, 5);
  });
});

describe('session_list tool', () => {
  it('lists live and cold sessions, hides archived by default, and flags the caller', async () => {
    const { byName, host, engine } = await mount({
      sessions: [sessionFixture('session-a', { title: '我自己' }), sessionFixture('session-b', { title: 'B' }), sessionFixture('session-c', { title: 'C 归档了' })],
      archived: ['session-c'],
    });
    host.publish('session-b').status = 'running';
    const tool = byName.get('session_list');
    const value = await tool.execute({}, exec('session-a'));
    assert.deepEqual(validate(value, tool.output.schema), []);
    assert.deepEqual(assertLosslessJson(value), []);
    assert.equal(value.ok, true);
    assert.deepEqual(
      value.sessions.map((row) => row.sessionId).sort(),
      ['session-a', 'session-b'],
    );
    const b = value.sessions.find((row) => row.sessionId === 'session-b');
    assert.equal(b.live, true);
    assert.equal(b.running, true);
    assert.equal(b.agentPreset, 'bot');
    assert.equal(b.title, 'B');
    assert.equal(value.sessions.find((row) => row.sessionId === 'session-a').isSelf, true);
    assert.match(value.degraded.join('\n'), /归档/);

    const withArchived = await tool.execute({ includeArchived: true }, exec('session-a'));
    assert.equal(withArchived.sessions.length, 3);
    assert.equal(withArchived.sessions.find((row) => row.sessionId === 'session-c').archived, true);
    const text = tool.output.render({ nothing: true }, value)[0].text;
    assert.match(text, /会话共 2 个/);
    assert.match(text, /session-b/);
    void engine;
  });

  it('filters by query', async () => {
    const { byName } = await mount({
      sessions: [sessionFixture('session-b', { title: 'FPGA 时序' }), sessionFixture('session-c', { title: '前端' })],
    });
    const tool = byName.get('session_list');
    const value = await tool.execute({ query: 'fpga' }, exec('session-a'));
    assert.deepEqual(value.sessions.map((row) => row.sessionId), ['session-b']);
  });

  it('degrades to a readable failure when the host has no query service', async () => {
    const host = createHost({ sessions: [sessionFixture('session-b')] });
    host.services.sessionQuery = undefined;
    host.services.sessionController = undefined;
    const dir = await mkdtemp(join(tmpdir(), 'dsl-degrade-'));
    const result = await mountSessionLink({
      ctx: host.ctx,
      config: { auditFile: join(dir, 'a.ndjson') },
      defineTool: fakeDefineTool,
      createUserMessage: fakeCreateUserMessage,
    });
    const tool = result === undefined ? undefined : host.registeredTools.find((entry) => entry.name === 'session_list');
    const value = await tool.execute({}, exec('session-a'));
    assert.deepEqual(validate(value, tool.output.schema), []);
    assert.equal(value.ok, false);
    assert.equal(value.code, 'SERVICE_UNAVAILABLE');
    assert.match(tool.output.render({}, value)[0].text, /session_list 不可用/);
  });
});

describe('session_read tool', () => {
  it('returns a bounded transcript and marks session-link envelopes', async () => {
    const events = [];
    for (let index = 0; index < 30; index += 1) {
      events.push({
        type: 'user/message',
        seq: index + 1,
        time: 1000 + index,
        data: { role: 'user', content: [{ type: 'text', text: `用户第 ${index} 条` }] },
      });
      events.push({
        type: 'assistant/message',
        seq: index + 31,
        time: 2000 + index,
        data: { message: { role: 'assistant', content: [{ type: 'text', text: `回答第 ${index} 条` }] } },
      });
    }
    events.push({ type: 'tool/call', seq: 99, time: 3000, data: { name: 'bash', arguments: '{"command":"ls"}' } });
    events.push({
      type: 'user/message',
      seq: 100,
      time: 3001,
      data: { content: [{ type: 'text', text: '[session-link] …\n<agent_message from="session-x">你好</agent_message>' }] },
    });
    const { byName } = await mount({ sessions: [sessionFixture('session-b', { title: 'B', events })] });
    const tool = byName.get('session_read');
    const value = await tool.execute({ sessionId: 'session-b', limit: 5 }, exec('session-a'));
    assert.deepEqual(validate(value, tool.output.schema), []);
    assert.deepEqual(assertLosslessJson(value), []);
    assert.equal(value.ok, true);
    assert.equal(value.returned, 5);
    assert.equal(value.truncated, true);
    assert.equal(value.messages.at(-1).kind, 'session-link');
    assert.equal(value.messages.at(-2).role, 'tool-call');
    assert.equal(value.messages.at(-2).name, 'bash');
    assert.match(tool.output.render({ sessionId: 'session-b' }, value)[0].text, /会话 session-b/);
  });

  it('reports an unknown session as a structured failure', async () => {
    const { byName } = await mount({ sessions: [sessionFixture('session-b')] });
    const tool = byName.get('session_read');
    const value = await tool.execute({ sessionId: 'session-ghost' }, exec('session-a'));
    assert.deepEqual(validate(value, tool.output.schema), []);
    assert.equal(value.ok, false);
    assert.equal(value.code, 'TARGET_NOT_FOUND');
    assert.match(tool.output.render({}, value)[0].text, /session_read 失败/);
  });

  it('requires a sessionId', async () => {
    const { byName } = await mount();
    const tool = byName.get('session_read');
    const value = await tool.execute({}, exec('session-a'));
    assert.equal(value.ok, false);
    assert.equal(value.code, 'INVALID_ARGS');
  });
});

describe('session_send tool', () => {
  it('delivers from the calling session and renders the receipt', async () => {
    const { byName, host } = await mount({ sessions: [sessionFixture('session-b')] });
    const tool = byName.get('session_send');
    const value = await tool.execute({ sessionId: 'session-b', text: '干活' }, exec('session-a'));
    assert.deepEqual(validate(value, tool.output.schema), []);
    assert.deepEqual(assertLosslessJson(value), []);
    assert.equal(value.ok, true);
    assert.equal(value.from, 'session-a');
    assert.equal(value.to, 'session-b');
    assert.equal(value.capability.presetBefore, 'bot');
    assert.equal(value.capability.presetAfter, 'bot');
    const body = host.live.get('session-b').inbox[0].message.content[0].text;
    assert.ok(body.includes('from="session-a"'));
    const rendered = tool.output.render({}, value)[0].text;
    assert.match(rendered, /已投递 followup → session-b/);
    assert.match(rendered, /能力守卫/);
  });

  it('refuses a send from a caller without a session identity', async () => {
    const { byName } = await mount({ sessions: [sessionFixture('session-b')] });
    const tool = byName.get('session_send');
    const value = await tool.execute({ sessionId: 'session-b', text: 'x' }, { callId: 'call_1', signal: new AbortController().signal });
    assert.equal(value.ok, false);
    assert.equal(value.code, 'NO_CALLER');
    assert.match(tool.output.render({}, value)[0].text, /投递被拒绝/);
  });

  it('refuses self-send with a machine code and a readable sentence', async () => {
    const { byName, host } = await mount({ sessions: [sessionFixture('session-a')] });
    host.publish('session-a');
    const tool = byName.get('session_send');
    const value = await tool.execute({ sessionId: 'session-a', text: '自己' }, exec('session-a'));
    assert.equal(value.ok, false);
    assert.equal(value.code, 'SELF_SEND');
    assert.match(tool.output.render({}, value)[0].text, /SELF_SEND/);
  });

  it('passes the mode through and validates the enum', () => {
    const { byName } = mount({});
    void byName;
  });

  it('exposes mode as a model-visible enum', async () => {
    const { byName } = await mount();
    const tool = byName.get('session_send');
    assert.deepEqual(tool.parameters.mode.enum, ['followup', 'steer', 'inject']);
    assert.equal(tool.parameters.text.required, true);
  });
});

describe('session_ask tool', () => {
  it('returns the reply when the target answers in time', async () => {
    const { byName, host } = await mount({ sessions: [sessionFixture('session-b')] });
    host.publish('session-b');
    const tool = byName.get('session_ask');
    const pending = tool.execute({ sessionId: 'session-b', text: '报个数', waitMs: 1000 }, exec('session-a'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const entry = host.live.get('session-b').inbox[0];
    host.emit('agent/inbox/claimed', { agent: host.live.get('session-b'), message: entry.message, turn: 1 });
    host.emit('session/event', { id: 'session-b' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '42' }] } } });
    host.emit('session/event', { id: 'session-b' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    const value = await pending;
    assert.deepEqual(validate(value, tool.output.schema), []);
    assert.deepEqual(assertLosslessJson(value), []);
    assert.equal(value.ok, true);
    assert.equal(value.waitStatus, 'completed');
    assert.equal(value.reply, '42');
    assert.match(tool.output.render({}, value)[0].text, /对方回复：/);
  });

  it('reports an unanswered wait without losing the delivery', async () => {
    const { byName, host } = await mount({ sessions: [sessionFixture('session-b')], config: { awaitMaxMs: 500 } });
    host.publish('session-b');
    const tool = byName.get('session_ask');
    const value = await tool.execute({ sessionId: 'session-b', text: '在吗', waitMs: 300 }, exec('session-a'));
    assert.deepEqual(validate(value, tool.output.schema), []);
    assert.equal(value.ok, true);
    assert.equal(value.waitStatus, 'unclaimed');
    assert.equal(host.live.get('session-b').inbox.length, 1);
    assert.match(tool.output.render({}, value)[0].text, /尚未领取/);
  });
});

describe('check_delivery tool', () => {
  it('finds a receipt by requestId with its timeline', async () => {
    const { byName, host } = await mount({ sessions: [sessionFixture('session-b')] });
    host.publish('session-b');
    const send = byName.get('session_send');
    const delivered = await send.execute({ sessionId: 'session-b', text: '可追踪', requestId: 'req_trace' }, exec('session-a'));
    const entry = host.live.get('session-b').inbox[0];
    host.emit('agent/inbox/claimed', { agent: host.live.get('session-b'), message: entry.message, turn: 1 });
    const tool = byName.get('check_delivery');
    const value = await tool.execute({ requestId: delivered.requestId }, exec('session-a'));
    assert.deepEqual(validate(value, tool.output.schema), []);
    assert.deepEqual(assertLosslessJson(value), []);
    assert.equal(value.found, true);
    assert.equal(value.status, 'claimed');
    assert.equal(value.from, 'session-a');
    assert.equal(value.to, 'session-b');
    assert.equal(value.threadId, delivered.threadId);
    assert.deepEqual(value.timeline.map((step) => step.status), ['delivered', 'claimed']);
    assert.match(tool.output.render({}, value)[0].text, /req_trace: claimed/);
  });

  it('reports an unknown requestId with recent receipts', async () => {
    const { byName, host } = await mount({ sessions: [sessionFixture('session-b')] });
    host.publish('session-b');
    await byName.get('session_send').execute({ sessionId: 'session-b', text: 'x', requestId: 'req_known' }, exec('session-a'));
    const tool = byName.get('check_delivery');
    const value = await tool.execute({ requestId: 'req_missing' }, exec('session-a'));
    assert.deepEqual(validate(value, tool.output.schema), []);
    assert.equal(value.found, false);
    assert.equal(value.code, 'RECEIPT_NOT_FOUND');
    assert.equal(value.recent[0].requestId, 'req_known');
    assert.match(tool.output.render({}, value)[0].text, /未找到回执/);
  });

  it('requires a requestId', async () => {
    const { byName } = await mount();
    const value = await byName.get('check_delivery').execute({}, exec('session-a'));
    assert.equal(value.ok, false);
    assert.equal(value.code, 'INVALID_ARGS');
  });
});

describe('plugin disposal', () => {
  it('disposes agents it resumed when the host unloads the plugin', async () => {
    const { byName, host } = await mount({ sessions: [sessionFixture('session-b')] });
    await byName.get('session_send').execute({ sessionId: 'session-b', text: 'x' }, exec('session-a'));
    assert.equal(host.live.size, 1);
    host.emit('dispose');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(host.live.size, 0);
  });
});
