import { describe, expect, it } from 'vitest';
import { IDS_PER_QUERY, inBatches } from './batches.ts';

describe('inBatches', () => {
  it('splits the items in order into batches of the size, the last one shorter', () => {
    expect(inBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(inBatches([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('gives no batch for no items and one batch up to the size', () => {
    expect(inBatches([], 3)).toEqual([]);
    expect(inBatches(['a'], 3)).toEqual([['a']]);
    expect(inBatches(['a', 'b', 'c'], 3)).toEqual([['a', 'b', 'c']]);
  });

  it('keeps a statement far below PostgreSQL’s 65 535 parameters by default', () => {
    const ids = Array.from({ length: 2 * IDS_PER_QUERY + 1 }, (_, index) => index);

    expect(inBatches(ids).map((batch) => batch.length)).toEqual([IDS_PER_QUERY, IDS_PER_QUERY, 1]);
    expect(IDS_PER_QUERY).toBeLessThanOrEqual(65_535 / 2);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a batch size of %s', (size) => {
    expect(() => inBatches([1], size)).toThrow(RangeError);
  });
});
