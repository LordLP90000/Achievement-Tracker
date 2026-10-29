import { readFileSync } from 'node:fs';
import { BloomFilter, type BloomFilterMeta } from './bloom-filter.ts';

/** Password policy per NIST SP 800-63B (R-AUTH-02, ADR-0012): length only, no composition rules, block list. */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Context-specific words (NIST SP 800-63B): passwords containing the service name are rejected like breached ones. */
const CONTEXT_WORDS = ['questline'];

const DEFAULT_FILTER = new URL('./breached-passwords.bloom', import.meta.url);

export type PasswordCheck = 'ok' | 'too_short' | 'too_long' | 'breached';

export interface BreachedPasswordFilter {
  readonly filter: BloomFilter;
  readonly meta: BloomFilterMeta;
}

/** Loads the committed filter once at startup; a missing or corrupt file stops the process. */
export function loadBreachedPasswordFilter(location: URL = DEFAULT_FILTER): BreachedPasswordFilter {
  return BloomFilter.deserialize(readFileSync(location));
}

export function checkPassword(breached: BreachedPasswordFilter, password: string): PasswordCheck {
  // Unicode code points, as JSON Schema's minLength/maxLength count them (`Password` in the contract).
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (length > PASSWORD_MAX_LENGTH) return 'too_long';
  const normalized = password.normalize('NFKC');
  const lowered = normalized.toLowerCase();
  if (CONTEXT_WORDS.some((word) => lowered.includes(word)) || breached.filter.has(normalized)) return 'breached';
  return 'ok';
}
