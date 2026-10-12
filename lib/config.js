/**
 * The plugin's `Config` schema.
 *
 * Declaring a real schema is what makes the row **configurable in the Web UI**:
 * the sidebar's Plugins page renders a configuration page for a bundle whose
 * entry exposes editable Config fields, and writes go through the harness
 * settings service with `applies: 'live'` — the loader re-activates this entry,
 * so `apply()` runs again with the new values and no restart is needed.
 *
 * `schemastery` is loaded defensively: a host that cannot resolve it still
 * mounts the plugin (the patch config keeps working), it just loses the
 * schema-driven page and validation.
 *
 * @module dsh-session-link/config
 */
import { DEFAULT_CONFIG } from './engine.js';

/**
 * Build the schema, or return `undefined` when `schemastery` is unavailable.
 *
 * @returns {Promise<object|undefined>} schemastery schema.
 */
export async function createConfigSchema() {
  let Schema;
  try {
    ({ default: Schema } = await import('schemastery'));
  } catch {
    return undefined;
  }
  const z = Schema;

  return z.object({
    maxHops: z
      .natural()
      .min(1)
      .max(64)
      .default(DEFAULT_CONFIG.maxHops)
      .description('一条线程允许的最大跳数：A→B→A→B… 超过就拒绝继续转发，防止两个会话无限互相唤醒'),
    rateLimitPerMinute: z
      .natural()
      .min(0)
      .max(600)
      .default(DEFAULT_CONFIG.rateLimitPerMinute)
      .description('每对「发送方→接收方」每分钟最多投递几条，0 = 不限流'),
    dedupeWindowMs: z
      .natural()
      .min(0)
      .max(3_600_000)
      .default(DEFAULT_CONFIG.dedupeWindowMs)
      .description('正文指纹去重窗口（毫秒）：同样的内容在窗口内不会重复投递'),
    verifyCapability: z
      .boolean()
      .default(DEFAULT_CONFIG.verifyCapability)
      .description('投递前后各探测一次目标的能力集（preset / 模型路由），发现漂移就回滚并拒绝；关掉可省一次会话读取'),
    maxTextChars: z
      .natural()
      .min(100)
      .max(100_000)
      .default(DEFAULT_CONFIG.maxTextChars)
      .description('单条消息正文的字符上限'),
    auditFile: z
      .string()
      .default(DEFAULT_CONFIG.auditFile)
      .description('审计与回执的 NDJSON 文件（支持 ~），重启后由它重放回执'),
    readDefaultLimit: z
      .natural()
      .min(1)
      .max(400)
      .default(DEFAULT_CONFIG.readDefaultLimit)
      .description('session_read 默认读取条数'),
    listDefaultLimit: z
      .natural()
      .min(1)
      .max(200)
      .default(DEFAULT_CONFIG.listDefaultLimit)
      .description('session_list 默认返回条数'),
    awaitDefaultMs: z
      .natural()
      .min(200)
      .max(3_600_000)
      .default(DEFAULT_CONFIG.awaitDefaultMs)
      .description('session_ask 默认等待上限（毫秒）'),
    awaitMaxMs: z
      .natural()
      .min(1000)
      .max(3_600_000)
      .default(DEFAULT_CONFIG.awaitMaxMs)
      .description('session_ask 允许的最大等待上限（毫秒）'),
  });
}
