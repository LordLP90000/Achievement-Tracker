import { describe, expect, it } from 'vitest';
import { etagOf, parseIfMatch } from './concurrency.ts';

describe('optimistic concurrency headers [ADR-0008]', () => {
  it('quotes the version as an entity tag', () => {
    expect(etagOf(1)).toBe('"1"');
    expect(etagOf(123_456_789)).toBe('"123456789"');
  });

  it.each([
    ['"1"', 1],
    ['"42"', 42],
    ['"999999999"', 999_999_999],
  ])('reads If-Match %s as version %i', (header, version) => {
    expect(parseIfMatch(header)).toEqual({ kind: 'version', version });
  });

  it('reports a missing header (428)', () => {
    expect(parseIfMatch(undefined)).toEqual({ kind: 'missing' });
  });

  it.each(['', '1', '"0"', '"-1"', '"1.5"', '"1234567890"', 'W/"1"', '*', '"1", "2"', ' "1"'])(
    'refuses %j: not one quoted version of at most 9 digits (400)',
    (header) => {
      expect(parseIfMatch(header)).toEqual({ kind: 'invalid' });
    },
  );
});
