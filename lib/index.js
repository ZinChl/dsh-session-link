/**
 * dsh-session-link — cross-session messaging for DeepSeek Harness.
 *
 * This file is the host adapter: it imports the two host packages and hands
 * everything else to {@link mountSessionLink}. Mounted from a bundle patch at
 * the profile root, so **every** session gets the tools without touching any
 * agent preset:
 *
 *   - `session_list`    enumerate existing sessions,
 *   - `session_read`    bounded read-only transcript snapshot,
 *   - `session_send`    deliver one message to an existing session,
 *   - `session_ask`     deliver and wait for that session's reply,
 *   - `check_delivery`  receipt lookup by requestId.
 *
 * Hard rules (see README and docs/protocol.md):
 *   1. never create a session — read existing + write existing only;
 *   2. a cold target is woken with `agents.resume({ resumeSessionId })` and
 *      **no** `agentOptions` / `meta.agentPreset`, so the capability set comes
 *      from its own durable record; a capability guard refuses the delivery if
 *      the preset or model route would change;
 *   3. archived sessions are refused and never woken;
 *   4. self-send is refused;
 *   5. same-process only — no network transport;
 *   6. `sessionQuery`/`agents` missing degrades into readable tool output;
 *   7. every decision is one line in a configurable NDJSON audit log;
 *   8. deliveries are idempotent by `requestId` and by content fingerprint;
 *   9. delivered content is untrusted: it is wrapped in a sanitized
 *      `<agent_message>` boundary (SLEP v1);
 *  10. host failures never throw bare exceptions at the agent loop.
 *
 * @module dsh-session-link
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { mountSessionLink } from './mount.js';

/** Plugin name (also the loader row id in the bundle patch). */
export const name = 'dsh-session-link';

/**
 * Hard dependency: the tool registry. Every other service (`agents`,
 * `sessionQuery`, `sessions`, `workspaceRegistry`, `sessionController`) is
 * resolved lazily per call, so a deployment that lacks one still mounts the
 * plugin and answers with an actionable message instead of vanishing.
 */
export const inject = ['tools'];

/** The tools this plugin owns; also used by tests and the README. */
export const TOOL_NAMES = ['session_list', 'session_read', 'session_send', 'session_ask', 'check_delivery'];

/**
 * Mount the plugin.
 *
 * Cordis collects every value this function returns as a plugin *effect*, so
 * the mount result is deliberately dropped here (`mountSessionLink` still
 * returns it for tests and scripts).
 *
 * @param {object} ctx - Cordis plugin context.
 * @param {object} [config] - patch config (see `resolveConfig` in lib/engine.js).
 * @returns {Promise<void>} resolves once the tools are registered.
 */
export async function apply(ctx, config) {
  await mountSessionLink({ ctx, config, defineTool, createUserMessage });
}
