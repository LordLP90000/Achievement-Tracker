import { createHmac } from 'node:crypto';

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
  return createHmac('sha256', key).update(normalizeEmail(email), 'utf8').digest();
}
