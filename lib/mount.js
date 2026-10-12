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
import { createToolOptions } from './tools.js';

/**
 * Mount the plugin onto a host context.
 *
 * @param {object} deps - mount dependencies.
 * @param {object} deps.ctx - Cordis plugin context (needs `tools`, `get`, `on`, `logger`).
 * @param {object} [deps.config] - patch config.
 * @param {Function} deps.defineTool - host `defineTool`.
 * @param {Function} deps.createUserMessage - host `createUserMessage`.
 * @returns {Promise<{ toolNames: string[], failed: string[], auditPath: string, engine: object, store: object, config: object }>} mount result.
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
  const options = createToolOptions({ ctx, engine, config: effective, logger });
  const toolNames = [];
  const failed = [];

  // Compile and register one tool at a time. A definition the host rejects must
  // cost that single tool, not the whole plugin: a `failed` loader entry would
  // otherwise take every tool down and only surface as a boot warning.
  for (const option of options) {
    let definition;
    try {
      definition = defineTool(option);
    } catch (error) {
      failed.push(option.name);
      logger?.error?.(`dsh-session-link: 工具 ${option.name} 的定义被宿主拒绝：${String(error)}`);
      continue;
    }
    try {
      ctx.tools.register(definition);
      toolNames.push(definition.name);
    } catch (error) {
      failed.push(option.name);
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

  if (failed.length > 0) {
    logger?.warn?.(`dsh-session-link: ${failed.length} 个工具未生效：${failed.join(', ')}`);
  }

  return { toolNames, failed, auditPath: audit.path, engine, store, config: effective };
}
