/**
 * Host-free plugin wiring.
 *
 * `lib/index.js` is the thin adapter that imports the two host packages
 * (`@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`) and calls this module.
 * Keeping the wiring here means the entire plugin can be unit-tested offline,
 * with a fake tool registry and a fake message factory, while the adapter stays
 * a five-line file that the live end-to-end run covers.
 *
 * @module dsh-session-link/mount
 */
import { createAuditLog } from './audit.js';
import { createEngine, resolveConfig } from './engine.js';
import { createLinkStore } from './store.js';
import { createToolDefinitions } from './tools.js';

/**
 * Mount the plugin onto a host context.
 *
 * @param {object} deps - mount dependencies.
 * @param {object} deps.ctx - Cordis plugin context (needs `tools`, `get`, `on`, `logger`).
 * @param {object} [deps.config] - patch config.
 * @param {Function} deps.defineTool - host `defineTool`.
 * @param {Function} deps.createUserMessage - host `createUserMessage`.
 * @returns {Promise<{ toolNames: string[], auditPath: string, engine: object, store: object, config: object }>} mount result.
 */
export async function mountSessionLink({ ctx, config, defineTool, createUserMessage }) {
  const effective = resolveConfig(config);
  const logger = ctx.logger;
  const audit = createAuditLog({
    file: effective.auditFile,
    maxBytes: effective.auditMaxBytes,
    logger,
  });
  const store = createLinkStore();
  try {
    const records = await audit.load();
    const folded = store.rehydrate(records);
    logger?.debug?.(`dsh-session-link: replayed ${folded} audit records from ${audit.path}`);
  } catch (error) {
    logger?.warn?.(`dsh-session-link: audit replay failed: ${String(error)}`);
  }

  const engine = createEngine({ ctx, store, audit, config: effective, logger, createUserMessage });
  const definitions = createToolDefinitions({ defineTool, ctx, engine, config: effective, logger });
  const toolNames = [];

  for (const definition of definitions) {
    try {
      ctx.tools.register(definition);
      toolNames.push(definition.name);
    } catch (error) {
      logger?.warn?.(`dsh-session-link: 注册工具 ${definition.name} 失败（可能重名）：${String(error)}`);
    }
  }

  // Receipt correlation (`agent/inbox/claimed` → claimed, `session/event`
  // `turn/end` → completed) is owned by the engine, so tests exercise exactly
  // the wiring the host sees. Disposal releases every agent this plugin resumed.
  ctx.on('dispose', () => {
    void engine.dispose();
  });

  logger?.info?.(
    `dsh-session-link: 已挂载（${toolNames.join(' / ')}），审计日志 ${audit.path}，跳数上限 ${effective.maxHops}，限流 ${effective.rateLimitPerMinute}/分钟`,
  );

  return { toolNames, auditPath: audit.path, engine, store, config: effective };
}
