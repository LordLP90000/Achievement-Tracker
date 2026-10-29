import { describe, expect, it } from 'vitest';
import { BloomFilter, BloomFilterFormatError } from './bloom-filter.ts';

const SOURCE = Buffer.alloc(32, 0xab);

describe('BloomFilter (ADR-0012)', () => {
  const words = Array.from({ length: 5000 }, (_, index) => `breached-password-${String(index)}`);
  const filter = BloomFilter.create(words.length, 0.01);
  for (const word of words) filter.add(word);

  it('sizes itself for the expected entries and false-positive rate', () => {
    expect(filter.hashes).toBe(7);
    expect(filter.bits).toBe(47_926);
  });

  it('finds every added value', () => {
    expect(words.every((word) => filter.has(word))).toBe(true);
  });

  it('keeps the false-positive rate near the target', () => {
    const others = Array.from({ length: 20_000 }, (_, index) => `never-added-${String(index)}`);
    const rate = others.filter((word) => filter.has(word)).length / others.length;

    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(0.02);
  });

  it('is exact about bytes, so case and Unicode forms are distinct values', () => {
    const small = BloomFilter.create(1, 0.000_001);
    small.add('CaseSensitive');

    expect(small.has('CaseSensitive')).toBe(true);
    expect(small.has('casesensitive')).toBe(false);
  });

  it('round-trips through its file format with the metadata that proves where it came from', () => {
    const restored = BloomFilter.deserialize(
      filter.serialize({ entries: words.length, minLength: 12, source: SOURCE }),
    );

    expect(restored.filter.bits).toBe(filter.bits);
    expect(restored.filter.hashes).toBe(filter.hashes);
    expect(restored.meta).toEqual({ entries: words.length, minLength: 12, source: SOURCE });
    expect(words.every((word) => restored.filter.has(word))).toBe(true);
  });

  it.each([
    ['an empty file', () => Buffer.alloc(0)],
    ['a wrong magic number', (file: Buffer) => Buffer.concat([Buffer.from('NOPE'), file.subarray(4)])],
    ['an unknown version', (file: Buffer) => Buffer.concat([file.subarray(0, 4), Buffer.from([9]), file.subarray(5)])],
    ['a truncated bit array', (file: Buffer) => file.subarray(0, file.length - 1)],
    ['trailing bytes', (file: Buffer) => Buffer.concat([file, Buffer.from([0])])],
  ])('refuses %s', (_name, corrupt) => {
    const file = filter.serialize({ entries: words.length, minLength: 12, source: SOURCE });

    expect(() => BloomFilter.deserialize(corrupt(file))).toThrow(BloomFilterFormatError);
  });

  it.each([
    [0, 0.01],
    [10, 0],
    [10, 1],
    [Number.NaN, 0.01],
  ])('refuses to size a filter for %s entries at rate %s', (entries, rate) => {
    expect(() => BloomFilter.create(entries, rate)).toThrow(RangeError);
  });
});
