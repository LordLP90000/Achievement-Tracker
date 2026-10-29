import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { durationFactor, effectiveXp, habitSpanDays, type HabitSpan } from './duration.ts';

const daily = (periodCount: number): HabitSpan => ({ period: 'day', periodCount });
const weekly = (periodCount: number): HabitSpan => ({ period: 'week', periodCount });

describe('duration factor, from the structure of a habit only [R-XP-02, Q-05g/h]', () => {
  it.each([
    [1, 1],
    [28, 1],
    [29, 1.5],
    [56, 1.5],
    [57, 2],
    [112, 2],
    [113, 3],
    [520, 3],
  ])('a daily habit over %i days has factor %d', (days, factor) => {
    expect(habitSpanDays(daily(days))).toBe(days);
    expect(durationFactor(daily(days))).toBe(factor);
  });

  it.each([
    [4, 28, 1],
    [5, 35, 1.5],
    [8, 56, 1.5],
    [9, 63, 2],
    [16, 112, 2],
    [17, 119, 3],
  ])('a weekly habit over %i weeks spans %i days and has factor %d', (weeks, days, factor) => {
    expect(habitSpanDays(weekly(weeks))).toBe(days);
    expect(durationFactor(weekly(weeks))).toBe(factor);
  });

  it('is 1 for one-time and target quests, which have no habit', () => {
    expect(durationFactor(null)).toBe(1);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a period count of %d', (periodCount) => {
    expect(() => durationFactor(daily(periodCount))).toThrow(RangeError);
    expect(() => durationFactor(daily(periodCount))).toThrow('a habit has a whole number of periods, at least one');
    expect(() => habitSpanDays(weekly(periodCount))).toThrow(RangeError);
  });

  it('never decreases as the span grows', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3_640 }), fc.integer({ min: 1, max: 3_640 }), (a, b) => {
        expect(durationFactor(daily(Math.min(a, b)))).toBeLessThanOrEqual(durationFactor(daily(Math.max(a, b))));
      }),
    );
  });
});

describe('effective XP of a quest [R-QST-01, R-XP-02]', () => {
  it.each([
    ['S', null, 10],
    ['M', null, 25],
    ['L', null, 50],
    ['S', daily(29), 15],
    ['M', daily(29), 38],
    ['L', daily(29), 75],
    ['M', weekly(9), 50],
    ['L', weekly(17), 150],
  ] as const)('size %s with %o is worth %i XP (half up)', (size, habit, xp) => {
    expect(effectiveXp(size, habit)).toBe(xp);
  });

  it('is a whole number of at least the base XP', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('S', 'M', 'L'),
        fc.constantFrom<HabitSpan['period']>('day', 'week'),
        fc.integer({ min: 1, max: 520 }),
        (size, period, periodCount) => {
          const xp = effectiveXp(size, { period, periodCount });
          expect(Number.isInteger(xp)).toBe(true);
          expect(xp).toBeGreaterThanOrEqual(effectiveXp(size, null));
        },
      ),
    );
  });
});
