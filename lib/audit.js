/**
 * Append-only NDJSON audit log (constraint 7 of the task).
 *
 * One JSON object per line, one line per decision:
 *  - `delivery` — a message was accepted and handed to a target Agent,
 *  - `refusal`  — a request was rejected (self / archived / hop / rate / …),
 *  - `status`   — a receipt moved (`claimed`, `completed`, `failed`).
 *
 * Appends are serialized through an internal promise chain, so line order
 * equals decision order even when several tools run concurrently, and a failed
 * append is reported through `logger.warn` instead of failing the tool: audit
 * durability must never take the delivery path down with it.
 *
 * @module dsh-session-link/audit
 */
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Expand a leading `~` using the current user's home directory. */
export function expandHome(path) {
  const value = String(path ?? '');
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Create the audit log.
 *
 * @param {object} options - audit options.
 * @param {string} options.file - absolute or `~`-rooted NDJSON path.
 * @param {number} [options.maxBytes] - rotate once the file exceeds this size.
 * @param {{warn: Function, debug?: Function}} [options.logger] - host logger.
 * @returns {object} audit log handle.
 */
export function createAuditLog({ file, maxBytes = 8 * 1024 * 1024, logger }) {
  const path = expandHome(file);
  /** @type {Promise<void>} */
  let chain = Promise.resolve();

  async function rotateIfNeeded() {
    try {
      const info = await stat(path);
      if (info.size < maxBytes) return;
      await rename(path, `${path}.1`);
      logger?.debug?.(`dsh-session-link: rotated audit log at ${info.size} bytes`);
    } catch {
      // Missing file or a lost rotation race: appending still works.
    }
  }

  return {
    /** Effective absolute path. */
    path,
    /**
     * Append one record. Never rejects.
     *
     * @param {object} record - JSON-serializable record.
     * @returns {Promise<void>} resolves after the write is queued and flushed.
     */
    append(record) {
      const line = `${JSON.stringify(record)}\n`;
      chain = chain.then(async () => {
        try {
          await mkdir(dirname(path), { recursive: true });
          await rotateIfNeeded();
          await appendFile(path, line, 'utf8');
        } catch (error) {
          logger?.warn?.(`dsh-session-link: audit append failed: ${String(error)}`);
        }
      });
      return chain;
    },
    /**
     * Read and parse every record, tolerating a torn final line.
     *
     * @returns {Promise<object[]>} parsed records in file order.
     */
    async load() {
      let raw;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        return [];
      }
      const records = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed !== null && typeof parsed === 'object') records.push(parsed);
        } catch {
          // A torn tail line (crash mid-append) is expected; skip it.
        }
      }
      return records;
    },
    /** Wait for every queued append to settle. */
    async flush() {
      await chain;
    },
  };
}
