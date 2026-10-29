import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_LEVEL, addXp, levelForXp, xpAboveLevel, xpThreshold, xpToNextLevel } from './xp.ts';

const anyTotal = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
/** Realistic totals: the caps of Q-31 keep a whole account far below 10^9 XP. */
const realisticTotal = fc.integer({ min: 0, max: 1_000_000_000 });

describe('level curve [R-XP-03, Q-05e]', () => {
  it.each([
    [1, 0],
    [2, 100],
    [3, 300],
    [4, 900],
    [5, 2_700],
    [10, 656_100],
  ])('level %i starts at %i XP', (level, xp) => {
    expect(xpThreshold(level)).toBe(xp);
  });

  it.each([
    [0, 1],
    [99, 1],
    [100, 2],
    [299, 2],
    [300, 3],
    [899, 3],
    [900, 4],
    [656_099, 9],
    [656_100, 10],
  ])('%i XP in total is level %i', (xp, level) => {
    expect(levelForXp(xp)).toBe(level);
  });

  it.each([
    [0, 100],
    [99, 1],
    [100, 200],
    [250, 50],
    [656_100, 1_312_200],
  ])('with %i XP, %i XP are missing to the next level', (xp, missing) => {
    expect(xpToNextLevel(xp)).toBe(missing);
  });

  it.each([
    [0, 0],
    [99, 99],
    [100, 0],
    [450, 150],
    [1_000, 100],
  ])('with %i XP, %i XP lie above the threshold of the current level (the stake, R-GMB-01)', (xp, above) => {
    expect(xpAboveLevel(xp)).toBe(above);
  });

  it('ends at level 31, the last level whose threshold is a safe integer [R-XP-04]', () => {
    expect(MAX_LEVEL).toBe(31);
    expect(xpThreshold(31)).toBe(6_863_037_736_488_300);
    expect(levelForXp(6_863_037_736_488_299)).toBe(30);
    expect(levelForXp(Number.MAX_SAFE_INTEGER)).toBe(31);
    expect(xpToNextLevel(Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(xpAboveLevel(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER - 6_863_037_736_488_300);
  });

  it.each([0, -1, 1.5, 32, Number.NaN])('refuses level %d', (level) => {
    expect(() => xpThreshold(level)).toThrow(RangeError);
    expect(() => xpThreshold(level)).toThrow('no such level');
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'refuses %d as a total [R-XP-04]',
    (xp) => {
      expect(() => levelForXp(xp)).toThrow(RangeError);
      expect(() => levelForXp(xp)).toThrow('an XP total is a non-negative safe integer');
      expect(() => xpToNextLevel(xp)).toThrow(RangeError);
      expect(() => xpAboveLevel(xp)).toThrow(RangeError);
    },
  );

  describe('properties', () => {
    it('a total lies between the threshold of its level and the next one', () => {
      fc.assert(
        fc.property(anyTotal, (xp) => {
          const level = levelForXp(xp);
          expect(xpThreshold(level)).toBeLessThanOrEqual(xp);
          if (level < MAX_LEVEL) expect(xp).toBeLessThan(xpThreshold(level + 1));
        }),
      );
    });

    it('more XP never means a lower level', () => {
      fc.assert(
        fc.property(anyTotal, anyTotal, (a, b) => {
          expect(levelForXp(Math.min(a, b))).toBeLessThanOrEqual(levelForXp(Math.max(a, b)));
        }),
      );
    });

    it('threshold, XP above it and XP to the next level add up', () => {
      fc.assert(
        fc.property(realisticTotal, (xp) => {
          const level = levelForXp(xp);
          expect(xpThreshold(level) + xpAboveLevel(xp)).toBe(xp);
          expect(xp + xpToNextLevel(xp)).toBe(xpThreshold(level + 1));
          expect(xpToNextLevel(xp)).toBeGreaterThan(0);
        }),
      );
    });

    it('losing at most the XP above the threshold never lowers the level [Q-31, R-GMB-03]', () => {
      fc.assert(
        fc.property(
          realisticTotal.chain((xp) => fc.tuple(fc.constant(xp), fc.integer({ min: 0, max: xpAboveLevel(xp) }))),
          ([xp, loss]) => {
            expect(levelForXp(xp - loss)).toBe(levelForXp(xp));
          },
        ),
      );
    });
  });
});

describe('XP totals [R-XP-04]', () => {
  it('adds signed changes to a total', () => {
    expect(addXp(0, 25)).toBe(25);
    expect(addXp(100, -100)).toBe(0);
    expect(addXp(Number.MAX_SAFE_INTEGER - 1, 1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    [0, -1],
    [10, -11],
    [Number.MAX_SAFE_INTEGER, 1],
    [5, 0.5],
    [5, Number.NaN],
    [-1, 1],
  ])('refuses %d + %d: a total never goes below 0 or beyond the safe-integer range', (total, delta) => {
    expect(() => addXp(total, delta)).toThrow(RangeError);
  });
});
