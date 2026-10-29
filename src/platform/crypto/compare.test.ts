import { describe, expect, it } from 'vitest';
import { constantTimeEqual } from './compare.ts';

describe('constantTimeEqual [R-TLS-04, I-10]', () => {
  const digest = Buffer.from('6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b', 'hex');

  it('accepts identical bytes', () => {
    expect(constantTimeEqual(digest, Buffer.from(digest))).toBe(true);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it('rejects a difference in any single byte', () => {
    for (let index = 0; index < digest.length; index += 1) {
      const other = Buffer.from(digest);
      other[index] = (other[index] ?? 0) ^ 0x80;
      expect(constantTimeEqual(digest, other)).toBe(false);
    }
  });

  it('rejects different lengths without throwing', () => {
    expect(constantTimeEqual(digest, digest.subarray(0, 31))).toBe(false);
    expect(constantTimeEqual(digest.subarray(0, 0), digest)).toBe(false);
  });
});
