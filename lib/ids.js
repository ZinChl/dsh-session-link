/**
 * Identifier minting and stable fingerprints.
 *
 * @module dsh-session-link/ids
 */
import { createHash, randomBytes } from 'node:crypto';

/** Crockford-ish base32 without padding: 5 bits per char, URL- and log-safe. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Mint a short, collision-resistant, human-scannable id.
 *
 * 12 random base32 chars = 60 bits, which is far beyond what a single DSH
 * process lifetime needs while staying short enough to read in an audit line.
 *
 * @param {string} prefix - `req` / `th` / `dlv`.
 * @returns {string} e.g. `req_k3m9xq2p7wla`.
 */
export function mintId(prefix) {
  const bytes = randomBytes(12);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % 32];
  return `${prefix}_${out.slice(0, 12)}`;
}

/**
 * Stable content fingerprint used for implicit idempotency.
 *
 * Two `session_send` calls with the same sender, target, mode and text inside
 * the dedupe window must not deliver twice. The fingerprint is length-prefixed
 * so no join ambiguity can collide two different tuples.
 *
 * @param {readonly string[]} parts - ordered, already-normalized fields.
 * @returns {string} 32 hex chars (128 bits).
 */
export function fingerprint(parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    const value = String(part ?? '');
    hash.update(String(Buffer.byteLength(value, 'utf8')));
    hash.update(':');
    hash.update(value, 'utf8');
    hash.update('\u0000');
  }
  return hash.digest('hex').slice(0, 32);
}

/**
 * Normalize a message body for fingerprinting only (never for delivery):
 * trim, collapse whitespace runs.
 *
 * @param {string} text - raw body.
 * @returns {string} normalized body.
 */
export function normalizeForFingerprint(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}
