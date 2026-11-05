import { createHmac } from 'node:crypto';
import { constantTimeEqual } from './compare.ts';

/** Deterministic, keyed lookup value for email addresses, which are stored only encrypted (R-ENC-02). */

export const BLIND_INDEX_KEY_MIN_BYTES = 32;

/** NFKC-normalised, trimmed and lower-cased, so every spelling of an address maps to one account. */
export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}

/** HMAC-SHA256(blind-index key, normalised email). The key lives outside the database (architecture §4.1). */
export function emailBlindIndex(key: Uint8Array, email: string): Buffer {
  if (key.length < BLIND_INDEX_KEY_MIN_BYTES) {
    throw new RangeError(`blind-index key must be at least ${String(BLIND_INDEX_KEY_MIN_BYTES)} bytes`);
  }
  // Node hashes a string as UTF-8.
  return createHmac('sha256', key).update(normalizeEmail(email)).digest();
}

/** What re-indexing did to one stored blind index (ADR-0020). */
export type Reindex =
  | { readonly outcome: 'current' }
  | { readonly outcome: 'reindexed'; readonly blindIndex: Buffer }
  | { readonly outcome: 'unknown' };

/**
 * The stored blind index of `email` under the current key (blind-index key rotation, ADR-0020, RR-3): kept when it is
 * already under it, replaced when it is under the previous key, and `unknown` under neither — another key, or another
 * address. Compared in constant time.
 */
export function reindexBlindIndex(
  stored: Uint8Array,
  email: string,
  current: Uint8Array,
  previous: Uint8Array | undefined,
): Reindex {
  const blindIndex = emailBlindIndex(current, email);
  if (constantTimeEqual(stored, blindIndex)) return { outcome: 'current' };
  if (previous !== undefined && constantTimeEqual(stored, emailBlindIndex(previous, email))) {
    return { outcome: 'reindexed', blindIndex };
  }
  return { outcome: 'unknown' };
}
