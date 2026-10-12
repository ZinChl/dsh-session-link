import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { archivedSessionIds, listSessions, probeCapability, readTranscript, resolveTarget } from '../lib/sessions.js';
import { createHost } from './helpers/host.mjs';

function fixture(id, overrides = {}) {
  return {
    id,
    title: overrides.title ?? `会话 ${id}`,
    cwd: overrides.cwd ?? `/tmp/${id}`,
    agentPreset: overrides.agentPreset ?? 'standard',
    updatedAt: overrides.updatedAt ?? 1000,
    requestContext: { provider: 'deepseek-official', model: 'deepseek-flash' },
    events: overrides.events ?? [],
    ...overrides,
  };
}

describe('archivedSessionIds', () => {
  it('unions every workspace archive set', () => {
    const host = createHost({ archived: ['session-x', 'session-y'] });
    const ids = archivedSessionIds(host.ctx);
    assert.deepEqual([...ids].sort(), ['session-x', 'session-y']);
  });

  it('is empty when the registry is missing or throws', () => {
    const host = createHost();
    host.services.workspaceRegistry = undefined;
    assert.equal(archivedSessionIds(host.ctx).size, 0);
    host.services.workspaceRegistry = { list: () => { throw new Error('registry down'); } };
    assert.equal(archivedSessionIds(host.ctx).size, 0);
  });
});

describe('listSessions', () => {
  it('merges controller activity with query headers and titles, newest first', async () => {
    const host = createHost({
      sessions: [
        fixture('session-old', { title: '旧', updatedAt: 1000 }),
        fixture('session-new', { title: '新', updatedAt: 5000 }),
      ],
    });
    const result = await listSessions(host.ctx, { limit: 10 });
    assert.deepEqual(result.rows.map((row) => row.sessionId), ['session-new', 'session-old']);
    assert.equal(result.rows[0].title, '新');
    assert.equal(result.rows[0].agentPreset, 'standard');
    assert.equal(result.rows[0].live, false);
    assert.equal(result.total, 2);
    assert.equal(result.truncated, false);
  });

  it('hides archived rows by default and explains why', async () => {
    const host = createHost({ sessions: [fixture('session-a'), fixture('session-b')], archived: ['session-b'] });
    const hidden = await listSessions(host.ctx, {});
    assert.deepEqual(hidden.rows.map((row) => row.sessionId), ['session-a']);
    assert.match(hidden.degraded.join('\n'), /隐藏 1 个归档会话/);
    const shown = await listSessions(host.ctx, { includeArchived: true });
    assert.equal(shown.rows.length, 2);
    assert.equal(shown.rows.find((row) => row.sessionId === 'session-b').archived, true);
  });

  it('marks the caller and reports running/live from the live registry', async () => {
    const host = createHost({ sessions: [fixture('session-a'), fixture('session-b')] });
    host.publish('session-b').status = 'running';
    const result = await listSessions(host.ctx, { selfId: 'session-a' });
    const b = result.rows.find((row) => row.sessionId === 'session-b');
    assert.equal(b.live, true);
    assert.equal(b.running, true);
    assert.equal(result.rows.find((row) => row.sessionId === 'session-a').isSelf, true);
  });

  it('falls back to per-session titles when the batch call rejects', async () => {
    const host = createHost({ sessions: [fixture('session-a', { title: '甲' }), fixture('session-b', { title: '乙' })] });
    host.services.sessionQuery.readTitleSnapshots = async () => {
      throw new Error('SESSION_QUERY_PERSISTENCE_FAILED');
    };
    const result = await listSessions(host.ctx, {});
    assert.deepEqual(result.rows.map((row) => row.title).sort(), ['乙', '甲']);
    assert.match(result.degraded.join('\n'), /批量标题失败（.*PERSISTENCE_FAILED.*），已逐个读取/);
  });

  it('falls back when the batch returns nothing', async () => {
    const host = createHost({ sessions: [fixture('session-a', { title: '甲' })] });
    host.services.sessionQuery.readTitleSnapshots = async () => [];
    const result = await listSessions(host.ctx, {});
    assert.equal(result.rows[0].title, '甲');
    assert.match(result.degraded.join('\n'), /批量标题无结果，已逐个读取/);
  });

  it('reports a readable note when neither path yields a title', async () => {
    const host = createHost({ sessions: [fixture('session-a', { title: '甲' })] });
    host.services.sessionQuery.readTitleSnapshots = async () => {
      throw new Error('boom');
    };
    host.services.sessionQuery.readTitle = async () => {
      throw new Error('boom');
    };
    const result = await listSessions(host.ctx, {});
    assert.equal(result.rows[0].title, undefined);
    assert.match(result.degraded.join('\n'), /批量标题失败（.*boom.*），已逐个读取，其中 1 个失败/);
  });

  it('filters by title, cwd or id substring', async () => {
    const host = createHost({
      sessions: [fixture('session-b', { title: 'FPGA 时序' }), fixture('session-c', { title: '前端', cwd: '/srv/app' })],
    });
    assert.deepEqual((await listSessions(host.ctx, { query: 'fpga' })).rows.map((row) => row.sessionId), ['session-b']);
    assert.deepEqual((await listSessions(host.ctx, { query: '/srv' })).rows.map((row) => row.sessionId), ['session-c']);
    assert.deepEqual((await listSessions(host.ctx, { query: 'session-c' })).rows.map((row) => row.sessionId), ['session-c']);
  });

  it('truncates to the limit and reports it', async () => {
    const host = createHost({
      sessions: Array.from({ length: 5 }, (_, index) => fixture(`session-${index}`, { updatedAt: index })),
    });
    const result = await listSessions(host.ctx, { limit: 2 });
    assert.equal(result.rows.length, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.total, 5);
  });

  it('reports a structured failure when no listing source exists', async () => {
    const host = createHost({ sessions: [fixture('session-a')] });
    host.services.sessionQuery = undefined;
    host.services.sessionController = undefined;
    await assert.rejects(() => listSessions(host.ctx, {}), (error) => {
      assert.equal(error.code, 'SERVICE_UNAVAILABLE');
      return true;
    });
  });
});

describe('readTranscript', () => {
  it('renders the tail of user/assistant/tool traffic', async () => {
    const events = [
      { type: 'user/message', seq: 1, time: 10, data: { content: [{ type: 'text', text: '你好' }] } },
      { type: 'assistant/message', seq: 2, time: 11, data: { message: { content: [{ type: 'text', text: '在的' }] } } },
      { type: 'tool/call', seq: 3, time: 12, data: { name: 'read', arguments: '{"file_path":"/etc/hosts"}' } },
      { type: 'tool/result', seq: 4, time: 13, data: { message: { content: [{ type: 'text', text: '127.0.0.1 localhost' }] } } },
      { type: 'step/start', seq: 5, time: 14, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 6, time: 15, data: { message: { content: [{ type: 'text', text: '完成' }] }, interrupted: true } },
    ];
    const host = createHost({ sessions: [fixture('session-b', { events })] });
    const result = await readTranscript(host.ctx, { sessionId: 'session-b', limit: 10 });
    assert.deepEqual(result.messages.map((entry) => entry.role), ['user', 'assistant', 'tool-call', 'tool-result', 'assistant']);
    assert.equal(result.messages[2].name, 'read');
    assert.equal(result.messages[4].interrupted, true);
    assert.equal(result.totalEvents, 6);
    assert.equal(result.truncated, false);
    assert.equal(result.agentPreset, 'standard');
  });

  it('clips long entries and reports truncation', async () => {
    const events = [
      { type: 'assistant/message', seq: 1, time: 10, data: { message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } } },
      { type: 'user/message', seq: 2, time: 11, data: { content: [{ type: 'text', text: 'ok' }] } },
    ];
    const host = createHost({ sessions: [fixture('session-b', { events })] });
    const result = await readTranscript(host.ctx, { sessionId: 'session-b', limit: 2, maxChars: 100 });
    assert.equal(result.returned, 2);
    assert.equal(result.truncated, false);
    assert.match(result.messages[0].text, /\[\+4900\]/);
    const tailOnly = await readTranscript(host.ctx, { sessionId: 'session-b', limit: 1 });
    assert.equal(tailOnly.returned, 1);
    assert.equal(tailOnly.truncated, true);
    assert.equal(tailOnly.messages[0].text, 'ok');
  });

  it('fails with TARGET_NOT_FOUND for an unknown session', async () => {
    const host = createHost({ sessions: [] });
    await assert.rejects(() => readTranscript(host.ctx, { sessionId: 'session-ghost' }), (error) => {
      assert.equal(error.code, 'TARGET_NOT_FOUND');
      return true;
    });
  });
});

describe('probeCapability', () => {
  it('reads the durable preset and the newest request route for a cold session', async () => {
    const events = [
      { type: 'request/header', seq: 1, time: 10, data: { header: { config: { provider: 'p1', model: 'm1' } }, reason: 'initial' } },
      { type: 'request/header', seq: 2, time: 20, data: { header: { config: { provider: 'p2', model: 'm2' } }, reason: 'change' } },
      { type: 'agent-preset/selected', seq: 3, time: 30, data: { agentPreset: 'bot' } },
    ];
    const host = createHost({ sessions: [fixture('session-b', { agentPreset: 'standard', events })] });
    const probe = await probeCapability(host.ctx, 'session-b');
    assert.equal(probe.source, 'persisted');
    assert.equal(probe.agentPreset, 'standard');
    assert.equal(probe.presetEvent, 'bot');
    assert.equal(probe.provider, 'p2');
    assert.equal(probe.model, 'm2');
  });

  it('prefers the live session route when the agent is in memory', async () => {
    const host = createHost({ sessions: [fixture('session-b')] });
    host.publish('session-b');
    const probe = await probeCapability(host.ctx, 'session-b');
    assert.equal(probe.source, 'live');
    assert.equal(probe.model, 'deepseek-flash');
  });
});

describe('resolveTarget', () => {
  it('passes an explicit id straight through', async () => {
    const host = createHost({ sessions: [] });
    assert.deepEqual(await resolveTarget(host.ctx, { sessionId: 'session-zzz' }), { sessionId: 'session-zzz' });
  });

  it('requires an id or a title', async () => {
    const host = createHost({ sessions: [] });
    await assert.rejects(() => resolveTarget(host.ctx, {}), (error) => {
      assert.equal(error.code, 'TARGET_REQUIRED');
      return true;
    });
  });

  it('refuses a title that matches nothing or matches several', async () => {
    const host = createHost({
      sessions: [fixture('session-b', { title: 'Alpha' }), fixture('session-c', { title: 'Alpha 二号' })],
    });
    await assert.rejects(() => resolveTarget(host.ctx, { title: 'Beta' }), (error) => {
      assert.equal(error.code, 'TARGET_NOT_FOUND');
      return true;
    });
    // An exact title match wins over the other prefix match.
    assert.equal((await resolveTarget(host.ctx, { title: 'Alpha' })).sessionId, 'session-b');
    // With no exact match, several candidates are ambiguous.
    await assert.rejects(() => resolveTarget(host.ctx, { title: 'Alph' }), (error) => {
      assert.equal(error.code, 'TARGET_AMBIGUOUS');
      assert.equal(error.details.candidates.length, 2);
      return true;
    });
  });
});
