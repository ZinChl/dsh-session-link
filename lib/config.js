/**
 * The plugin's `Config` schema.
 *
 * Declaring a real schema is what makes the row **configurable in the Web UI**:
 * the sidebar's Plugins page renders a configuration page for a bundle whose
 * entry exposes editable Config fields, and writes go through the harness
 * settings service with `applies: 'live'` — the loader re-activates this entry,
 * so `apply()` runs again with the new values and no restart is needed.
 *
 * Fields surfaced in the Web UI are marked `.volatile()`: the harness only
 * exposes a settings namespace for Config fields carrying `meta.volatile`, and
 * a namespace is what the Plugins page's configuration form reads and writes.
 * The schema library is loaded defensively: a host that can resolve neither
 * package still mounts the plugin (the patch config keeps working), it just
 * loses the schema-driven page and validation.
 *
 * @module dsh-session-link/config
 */
import { DEFAULT_CONFIG } from './engine.js';

/**
 * Mark one field as live-editable.
 *
 * The harness only exposes a settings namespace — and therefore a
 * configuration form in the Web UI — for Config fields carrying
 * `meta.volatile` (`dsh-settings`' `volatileForm()` projects exactly those).
 * `.volatile()` is a method of the harness's own schemastery fork
 * (`@deepseek-ai/schemastery`), so it is applied defensively: with the plain
 * npm package the schema still validates, it just yields no settings page.
 *
 * @param {object} field - schemastery field.
 * @returns {object} the field, marked volatile when the method exists.
 */
function live(field) {
  return typeof field?.volatile === 'function' ? field.volatile() : field;
}

/**
 * Build the schema, or return `undefined` when `schemastery` is unavailable.
 *
 * @returns {Promise<object|undefined>} schemastery schema.
 */
export async function createConfigSchema() {
  let Schema;
  // The harness fork first (it has `.volatile()`, which the settings page needs),
  // then the plain npm package as a validation-only fallback.
  for (const specifier of ['@deepseek-ai/schemastery', 'schemastery']) {
    try {
      ({ default: Schema } = await import(specifier));
      break;
    } catch {
      Schema = undefined;
    }
  }
  if (Schema === undefined) return undefined;
  const z = Schema;

  return z.object({
    maxHops: live(
      z
        .natural()
        .min(1)
        .max(64)
        .default(DEFAULT_CONFIG.maxHops)
        .description('一条线程允许的最大跳数：A→B→A→B… 超过就拒绝继续转发，防止两个会话无限互相唤醒'),
    ),
    rateLimitPerMinute: live(
      z
        .natural()
        .min(0)
        .max(600)
        .default(DEFAULT_CONFIG.rateLimitPerMinute)
        .description('每对「发送方→接收方」每分钟最多投递几条，0 = 不限流'),
    ),
    dedupeWindowMs: live(
      z
        .natural()
        .min(0)
        .max(3_600_000)
        .default(DEFAULT_CONFIG.dedupeWindowMs)
        .description('正文指纹去重窗口（毫秒）：同样的内容在窗口内不会重复投递'),
    ),
    verifyCapability: live(
      z
        .boolean()
        .default(DEFAULT_CONFIG.verifyCapability)
        .description('投递前后各探测一次目标的能力集（preset / 模型路由），发现漂移就回滚并拒绝；关掉可省一次会话读取'),
    ),
    maxTextChars: live(
      z
        .natural()
        .min(100)
        .max(100_000)
        .default(DEFAULT_CONFIG.maxTextChars)
        .description('单条消息正文的字符上限'),
    ),
    auditFile: live(
      z
        .string()
        .default(DEFAULT_CONFIG.auditFile)
        .description('审计与回执的 NDJSON 文件（支持 ~），重启后由它重放回执'),
    ),
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
