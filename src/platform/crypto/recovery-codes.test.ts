import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { issueRecoveryCodes, RECOVERY_CODES, recoveryCodeHash } from './recovery-codes.ts';

const FORMAT = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest();

describe('recovery codes (ADR-0019)', () => {
  it('issues 10 codes of 80 bits each, in groups of four Crockford base32 characters', () => {
    const codes = issueRecoveryCodes();

    expect(RECOVERY_CODES).toEqual({ count: 10, randomBytes: 10 });
    expect(codes).toHaveLength(10);
    for (const { code } of codes) expect(code).toMatch(FORMAT);
    expect(new Set(codes.map(({ code }) => code)).size).toBe(10);
  });

  it('hands out the SHA-256 digest of each code for storage, never the code itself', () => {
    for (const { code, hash } of issueRecoveryCodes()) {
      expect(hash).toEqual(sha256(`ql_rc_${code.replaceAll('-', '')}`));
      expect(recoveryCodeHash(code)).toEqual(hash);
    }
  });

  it('uses every character of the alphabet over many codes, so no bits are lost', () => {
    const characters = new Set(
      Array.from({ length: 40 }, () => issueRecoveryCodes())
        .flat()
        .flatMap(({ code }) => code.replaceAll('-', '').match(/./gu) ?? []),
    );

    expect([...characters].sort().join('')).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  });

  it('reads a code as people type it: any case, with or without hyphens and spaces, O for 0 and I or L for 1', () => {
    const hash = recoveryCodeHash('0123-4567-89AB-CDEF');

    expect(hash).toEqual(sha256('ql_rc_0123456789ABCDEF'));
    for (const typed of ['0123456789abcdef', '0123 4567 89ab cdef', ' 0123-4567-89AB-CDEF ', 'o123-4567-89AB-CDEF']) {
      expect(recoveryCodeHash(typed)).toEqual(hash);
    }
    expect(recoveryCodeHash('0I23-4567-89AB-CDEF')).toEqual(sha256('ql_rc_0123456789ABCDEF'));
    expect(recoveryCodeHash('0l23-4567-89AB-CDEF')).toEqual(sha256('ql_rc_0123456789ABCDEF'));
  });

  it.each([
    ['too short', '0123-4567-89AB-CDE'],
    ['too long', '0123-4567-89AB-CDEF0'],
    ['a U, which Crockford base32 leaves out', '0123-4567-89AB-CDEU'],
    ['another sign', '0123-4567-89AB-CDE!'],
    ['nothing', ''],
  ])('refuses a code that is %s', (_case, typed) => {
    expect(recoveryCodeHash(typed)).toBeUndefined();
  });

  it('maps every well-formed code to the hash of its canonical form, and only those', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (typed) => {
        const hash = recoveryCodeHash(typed);
        const canonical = typed.toUpperCase().replaceAll(/[\s-]/gu, '').replaceAll('O', '0').replaceAll(/[IL]/gu, '1');

        expect(hash).toEqual(/^[0-9A-HJKMNP-TV-Z]{16}$/u.test(canonical) ? sha256(`ql_rc_${canonical}`) : undefined);
      }),
    );
  });
});
