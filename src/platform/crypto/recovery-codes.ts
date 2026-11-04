import { createHash, randomBytes } from 'node:crypto';
import { base32, CROCKFORD } from './base32.ts';

/**
 * Recovery codes (ADR-0019): each works once instead of a TOTP code. 80 random bits as 16 Crockford base32 characters
 * in groups of four, stored only as SHA-256 hashes, which 80 bits keep out of reach of brute force.
 */

export const RECOVERY_CODES = Object.freeze({ count: 10, randomBytes: 10 });

export interface IssuedRecoveryCode {
  /** Shown to the user exactly once; never stored or logged. */
  readonly code: string;
  /** SHA-256 of the canonical code: the only form that is stored. */
  readonly hash: Buffer;
}

const CANONICAL = /^[0-9A-HJKMNP-TV-Z]{16}$/u;

const digest = (canonical: string): Buffer => createHash('sha256').update(`ql_rc_${canonical}`).digest();

export function issueRecoveryCodes(): IssuedRecoveryCode[] {
  return Array.from({ length: RECOVERY_CODES.count }, () => {
    const canonical = base32(randomBytes(RECOVERY_CODES.randomBytes), CROCKFORD);
    const code = [0, 4, 8, 12].map((start) => canonical.slice(start, start + 4)).join('-');
    return { code, hash: digest(canonical) };
  });
}

/**
 * The digest of a code as a person types it, for a lookup — any case, with or without hyphens and spaces, O for 0 and
 * I or L for 1, as Crockford base32 reads them — or `undefined` when it cannot be a code.
 */
export function recoveryCodeHash(typed: string): Buffer | undefined {
  const canonical = typed.toUpperCase().replaceAll(/[\s-]/gu, '').replaceAll('O', '0').replaceAll(/[IL]/gu, '1');
  return CANONICAL.test(canonical) ? digest(canonical) : undefined;
}
