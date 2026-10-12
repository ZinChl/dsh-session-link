/**
 * In-memory stand-in for the host services dsh-session-link talks to.
 *
 * It is deliberately faithful on the two points the plugin must get right:
 *  - `agents.resume` records the **exact** options object it received, so a
 *    test can prove no `agentOptions` / `meta.agentPreset` was passed;
 *  - delivered messages land in a per-agent inbox in order, so a test can
 *    inspect the envelope text the target would actually see.
 *
 * @module tests/helpers/host
 */

/** Header stub shaped like `SessionHeader` (only the fields the plugin reads). */
function headerOf(session) {
  return {
    version: 1,
    id: session.id,
    createdAt: session.createdAt ?? Date.UTC(2026, 0, 1),
    cwd: session.cwd,
    isSeeded: false,
    agentPreset: session.agentPreset,
  };
}

/**
 * The header a *live* agent exposes. It differs from the persisted header only
 * when a fixture sets `livePreset`, which models a host whose resume composes a
 * different preset than the session recorded — exactly the drift this plugin
 * must refuse.
 */
function liveHeaderOf(session) {
  return { ...headerOf(session), agentPreset: session.livePreset ?? session.agentPreset };
}

/**
 * Create one fake host.
 *
 * @param {object} [options] - fixture options.
 * @param {object[]} [options.sessions] - persisted sessions.
 * @param {string[]} [options.archived] - archived session ids.
 * @param {object} [options.logger] - logger spy.
 * @returns {object} host handle.
 */
export function createHost({ sessions = [], archived = [], logger } = {}) {
  /** @type {Map<string, object>} */
  const records = new Map();
  /** @type {Map<string, object>} */
  const live = new Map();
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  /** @type {object[]} */
  const registeredTools = [];
  /** @type {object[]} */
  const resumeCalls = [];

  for (const session of sessions) {
    records.set(session.id, {
      ...session,
      id: session.id,
      cwd: session.cwd ?? '/tmp',
      createdAt: session.createdAt ?? Date.UTC(2026, 0, 1),
      events: session.events ?? [],
      updatedAt: session.updatedAt ?? session.createdAt ?? Date.UTC(2026, 0, 1),
      running: session.running === true,
    });
  }

  function makeAgent(id) {
    const record = records.get(id);
    const inbox = [];
    const agent = {
      id,
      status: 'idle',
      inbox,
      session: {
        id,
        header: liveHeaderOf(record),
        requestContext: () => record.requestContext,
        snapshotEvents: () => record.events,
      },
      followup(message) {
        inbox.push({ mode: 'followup', message });
        agent.status = 'running';
      },
      steer(message) {
        inbox.push({ mode: 'steer', message });
      },
      inject(message) {
        inbox.push({ mode: 'inject', message });
      },
      whenIdle: async () => {},
    };
    return agent;
  }

  /** Publish a live agent (as the host would after `agents.resume`). */
  function publish(id) {
    const agent = makeAgent(id);
    live.set(id, agent);
    return agent;
  }

  /** Preset composition calls the plugin made while resuming (mirrors the web controller). */
  const presetResolveCalls = [];
  const presetMounts = [];

  const services = {
    agentPresets: {
      resolve: async (id) => {
        presetResolveCalls.push(id);
        if (id === undefined || id === null || id === '') return { id: 'standard' };
        if (String(id).startsWith('ghost')) throw new Error(`unknown agent preset "${id}"`);
        return { id };
      },
      mount: async (agentCtx, id) => {
        presetMounts.push({ id, agentCtx });
        return { id };
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deployment-default-model' }),
    },
    agents: {
      get: (id) => live.get(id),
      list: () => [...live.values()],
      roots: () => [...live.values()],
      create: async () => {
        throw new Error('dsh-session-link must never call agents.create');
      },
      resume: async (options) => {
        resumeCalls.push(options);
        const record = records.get(String(options.resumeSessionId));
        if (record === undefined) throw new Error(`no persisted session ${options.resumeSessionId}`);
        const agent = publish(String(options.resumeSessionId));
        // The host runs `setup` during agent construction; a fake that skipped
        // it would hide a missing preset mount (the whole point of constraint 2).
        if (typeof options.setup === 'function') await options.setup({ id: options.resumeSessionId }, agent);
        return {
          agent,
          dispose: async () => {
            live.delete(String(options.resumeSessionId));
          },
        };
      },
    },
    sessions: {
      get: (id) => (live.has(id) ? live.get(id).session : undefined),
      list: () => [...records.values()].map((record) => ({ header: headerOf(record) })),
    },
    sessionQuery: {
      listSessions: async () =>
        [...records.values()]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((record) => ({ header: headerOf(record), live: live.has(record.id), persisted: true })),
      observeSession: async (id) => {
        const record = records.get(String(id));
        if (record === undefined) throw new Error(`unknown session ${id}`);
        return {
          header: headerOf(record),
          events: record.events,
          source: live.has(String(id)) ? 'live' : 'prepared',
          dispose: () => {},
        };
      },
      readSession: async (id) => {
        const record = records.get(String(id));
        if (record === undefined) throw new Error(`unknown session ${id}`);
        return { session: headerOf(record), events: record.events, inheritedEventCount: 0 };
      },
      readTitleSnapshots: async (ids) =>
        ids.map((id) => {
          const record = records.get(String(id));
          if (record === undefined) return { sessionId: id, status: 'rejected', error: new Error('unknown') };
          return {
            sessionId: id,
            status: 'fulfilled',
            header: headerOf(record),
            title:
              record.title === undefined
                ? undefined
                : { title: record.title, updatedAt: record.updatedAt, eventSeq: 1 },
          };
        }),
      readTitle: async (id) => {
        const record = records.get(String(id));
        return record?.title === undefined ? undefined : { title: record.title, updatedAt: record.updatedAt, eventSeq: 1 };
      },
    },
    sessionController: {
      list: async () => ({
        items: [...records.values()].map((record) => ({
          sessionId: record.id,
          cwd: record.cwd,
          updatedAt: record.updatedAt,
          running: record.running,
          agentAvailable: live.has(record.id),
          blank: false,
        })),
      }),
    },
    workspaceRegistry: {
      // Shape taken from @deepseek-ai/dsh-workspace: the archive set is
      // registry-global, not per-workspace.
      get archivedSessionIds() {
        return archived;
      },
      list: () => [
        {
          id: 'ws-1',
          path: '/workspace',
          title: 'workspace',
          sessionIds: [...records.keys()],
        },
      ],
    },
  };

  const ctx = {
    logger: logger ?? { info() {}, warn() {}, debug() {} },
    get: (name) => services[name],
    on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return () => listeners.get(event)?.delete(listener);
    },
    tools: {
      register: (definition) => {
        registeredTools.push(definition);
        return () => {};
      },
    },
  };

  return {
    ctx,
    services,
    records,
    live,
    registeredTools,
    resumeCalls,
    presetResolveCalls,
    presetMounts,
    /** Publish a live agent for one session id. */
    publish,
    /** Emit a host event to every listener. */
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    /** Deliver the message a live agent received and mark it claimed. */
    claim(agentId, requestId) {
      const agent = live.get(agentId);
      const entry = agent?.inbox.find((item) =>
        item.message.content.some((block) => typeof block.text === 'string' && block.text.includes(requestId)),
      );
      const message = entry?.message ?? { content: [{ type: 'text', text: `request_id="${requestId}"` }] };
      ctx.on; // no-op to keep the shape explicit
      return { agent: live.get(agentId), message, turn: 1 };
    },
  };
}

/** A `createUserMessage` stand-in that mirrors the host's role/id stamping. */
export function fakeCreateUserMessage(input) {
  return { ...input, id: `msg_${Math.random().toString(36).slice(2, 8)}`, role: 'user' };
}
