import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BLIND_INDEX_KEY_MIN_BYTES, emailBlindIndex, normalizeEmail, reindexBlindIndex } from './blind-index.ts';

const KEY = Buffer.alloc(32, 0x0b);

describe('normalizeEmail (architecture §4.3)', () => {
  it.each([
    ['alice@example.test', 'alice@example.test'],
    ['  Alice@Example.TEST  ', 'alice@example.test'],
    ['ＡＬＩＣＥ＠ｅｘａｍｐｌｅ．ｔｅｓｔ', 'alice@example.test'],
    ['\u3000alice@example.test\t\n', 'alice@example.test'],
  ])('normalises %j to %j (NFKC, trimmed, lower-cased)', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });
});

describe('emailBlindIndex [R-ENC-02]', () => {
  it('is HMAC-SHA256 over the normalised address', () => {
    expect(emailBlindIndex(KEY, ' Alice@Example.TEST')).toEqual(
      createHmac('sha256', KEY).update('alice@example.test', 'utf8').digest(),
    );
  });

  it('keeps a pinned regression vector, so a change of algorithm or normalisation cannot go unnoticed', () => {
    expect(emailBlindIndex(KEY, 'alice@example.test').toString('hex')).toBe(
      '8aa56416a799939868e41ffd2d01ee92f8c6f026320297b482acb56973776de0',
    );
  });

  it('maps every spelling of one address to one index, and different addresses to different indexes', () => {
    const spellings = ['alice@example.test', 'ALICE@EXAMPLE.TEST', ' ＡＬＩＣＥ＠ｅｘａｍｐｌｅ．ｔｅｓｔ '];

    expect(new Set(spellings.map((email) => emailBlindIndex(KEY, email).toString('hex'))).size).toBe(1);
    expect(emailBlindIndex(KEY, 'alice@example.test')).not.toEqual(emailBlindIndex(KEY, 'bob@example.test'));
  });

  it('depends on the key, so a database dump alone does not reveal which address an index belongs to', () => {
    expect(emailBlindIndex(randomBytes(32), 'alice@example.test')).not.toEqual(
      emailBlindIndex(KEY, 'alice@example.test'),
    );
  });

  it('refuses keys shorter than 32 bytes', () => {
    expect(BLIND_INDEX_KEY_MIN_BYTES).toBe(32);
    expect(() => emailBlindIndex(Buffer.alloc(31, 1), 'alice@example.test')).toThrow(
      new RangeError('blind-index key must be at least 32 bytes'),
    );
  });
});

/** Rotating the blind-index key (ADR-0020, RR-3): each stored index ends up under the current key. */
describe('reindexBlindIndex (ADR-0020) [R-ENC-02, RR-3]', () => {
  const [previous, current] = [randomBytes(32), randomBytes(32)];
  const address = 'Alice@Example.test';

  it('keeps an index already under the current key', () => {
    expect(reindexBlindIndex(emailBlindIndex(current, address), address, current, previous)).toEqual({
      outcome: 'current',
    });
  });

  it('replaces an index under the previous key with the one under the current key', () => {
    expect(reindexBlindIndex(emailBlindIndex(previous, address), address, current, previous)).toEqual({
      outcome: 'reindexed',
      blindIndex: emailBlindIndex(current, address),
    });
  });

  it('reports an index under neither key, or of another address, and one when no previous key is given', () => {
    expect(reindexBlindIndex(emailBlindIndex(randomBytes(32), address), address, current, previous)).toEqual({
      outcome: 'unknown',
    });
    expect(reindexBlindIndex(emailBlindIndex(previous, 'bob@example.test'), address, current, previous)).toEqual({
      outcome: 'unknown',
    });
    expect(reindexBlindIndex(emailBlindIndex(previous, address), address, current, undefined)).toEqual({
      outcome: 'unknown',
    });
  });

  it('compares a stored index of another length as unknown, not as an error', () => {
    expect(reindexBlindIndex(Buffer.alloc(31), address, current, previous)).toEqual({ outcome: 'unknown' });
  });
});
