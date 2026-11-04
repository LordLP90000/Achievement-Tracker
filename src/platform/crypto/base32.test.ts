import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { base32, CROCKFORD, RFC4648 } from './base32.ts';

describe('base32 without padding characters', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('encodes %j as %j, the vector of RFC 4648 §10', (text, encoded) => {
    expect(base32(Buffer.from(text, 'ascii'))).toBe(encoded);
  });

  it('writes 160 bits as 32 characters and 80 bits as 16, from the given alphabet', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 20, maxLength: 20 }), (bytes) => {
        expect(base32(bytes)).toMatch(/^[A-Z2-7]{32}$/);
        expect(base32(bytes.subarray(0, 10), CROCKFORD)).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
      }),
    );
    expect(base32(Buffer.alloc(20, 0xff))).toBe('7'.repeat(32));
    expect(base32(Buffer.alloc(10, 0xff), CROCKFORD)).toBe('Z'.repeat(16));
    expect(base32(Buffer.from([0x00, 0x44, 0x32, 0x14, 0xdf]), CROCKFORD)).toBe('0123456Z');
  });

  it('uses the two alphabets of 32 distinct characters each', () => {
    expect(new Set(RFC4648).size).toBe(32);
    expect(new Set(CROCKFORD).size).toBe(32);
    expect(CROCKFORD).not.toMatch(/[ILOU]/u);
  });
});
