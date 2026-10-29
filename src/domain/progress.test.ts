import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { achievementProgress, habitProgress, oneTimeProgress, targetProgress } from './progress.ts';

const value = (units: number) => Math.round(units * 1000);

describe('quest progress [R-QST-03, R-QST-04, R-QST-05]', () => {
  it('completes a one-time quest with one counting check-in [R-QST-03]', () => {
    expect(oneTimeProgress(0)).toBe(0);
    expect(oneTimeProgress(1)).toBe(1);
    expect(oneTimeProgress(3)).toBe(1);
  });

  it.each([
    ['increasing 0 → 12, now 6', 0, 12, 6, 0.5],
    ['decreasing 90 → 80, now 85', 90, 80, 85, 0.5],
    ['increasing, overshot', 0, 12, 15, 1],
    ['decreasing, overshot', 90, 80, 70, 1],
    ['increasing, below the start', 10, 20, 5, 0],
    ['decreasing, above the start', 90, 80, 95, 0],
    ['at the start', 10, 20, 10, 0],
    ['exactly at the target', 10, 20, 20, 1],
    ['decimals 80.5 → 75.25, now 77.875', 80.5, 75.25, 77.875, 0.5],
    ['negative values −5 → 5, now 0', -5, 5, 0, 0.5],
  ])('a target quest %s has progress %d [R-QST-05]', (_case, start, target, current, progress) => {
    expect(targetProgress(value(start), value(target), value(current))).toBe(progress);
  });

  it('refuses a target equal to its start value [A-05]', () => {
    expect(() => targetProgress(value(10), value(10), value(10))).toThrow(RangeError);
    expect(() => targetProgress(value(10), value(10), value(10))).toThrow('a target differs from its start value');
  });

  it.each([
    [0, 8, 0],
    [3, 8, 0.375],
    [8, 8, 1],
    [9, 8, 1],
  ])('a habit with %i of %i periods met has progress %d [R-QST-04]', (met, periodCount, progress) => {
    expect(habitProgress(met, periodCount)).toBe(progress);
  });

  describe('properties', () => {
    const anyValue = fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 });

    it('target progress stays within 0 … 1 and never falls as the value moves towards the target', () => {
      fc.assert(
        fc.property(anyValue, anyValue, anyValue, anyValue, (start, target, a, b) => {
          fc.pre(start !== target);
          const [nearer, further] =
            target > start ? [Math.max(a, b), Math.min(a, b)] : [Math.min(a, b), Math.max(a, b)];
          const progress = targetProgress(start, target, nearer);

          expect(progress).toBeGreaterThanOrEqual(0);
          expect(progress).toBeLessThanOrEqual(1);
          expect(progress).toBeGreaterThanOrEqual(targetProgress(start, target, further));
        }),
      );
    });

    it('habit progress stays within 0 … 1', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 600 }), fc.integer({ min: 1, max: 520 }), (met, periodCount) => {
          expect(habitProgress(met, periodCount)).toBeGreaterThanOrEqual(0);
          expect(habitProgress(met, periodCount)).toBeLessThanOrEqual(1);
        }),
      );
    });
  });
});

describe('achievement progress: the XP-weighted mean of its required quests [R-ACH-03, A-17]', () => {
  it('weights each required quest by its effective XP', () => {
    expect(
      achievementProgress([
        { isRequired: true, xp: 10, progress: 1 },
        { isRequired: true, xp: 30, progress: 0.5 },
      ]),
    ).toBe(0.625);
  });

  it('ignores bonus quests, which never block an unlock', () => {
    expect(
      achievementProgress([
        { isRequired: true, xp: 25, progress: 1 },
        { isRequired: false, xp: 50, progress: 0 },
      ]),
    ).toBe(1);
  });

  it('is 0 without required quests [A-17]', () => {
    expect(achievementProgress([])).toBe(0);
    expect(achievementProgress([{ isRequired: false, xp: 10, progress: 1 }])).toBe(0);
  });

  it('stays below 1 while a required quest is incomplete, even where a floating-point sum would round up', () => {
    const almostDone = 1 - Number.EPSILON / 2;
    const progress = achievementProgress([
      { isRequired: true, xp: 150, progress: 1 },
      { isRequired: true, xp: 1, progress: almostDone },
    ]);

    expect((150 + almostDone) / 151).toBe(1);
    expect(progress).toBeLessThan(1);
  });

  it('stays within 0 … 1 and reaches 1 exactly when every required quest is complete', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            isRequired: fc.boolean(),
            xp: fc.integer({ min: 1, max: 150 }),
            progress: fc.oneof(fc.constant(1), fc.double({ min: 0, max: 1, noNaN: true })),
          }),
          { maxLength: 50 },
        ),
        (quests) => {
          const progress = achievementProgress(quests);
          const required = quests.filter((quest) => quest.isRequired);

          expect(progress).toBeGreaterThanOrEqual(0);
          expect(progress).toBeLessThanOrEqual(1);
          expect(progress === 1).toBe(required.length > 0 && required.every((quest) => quest.progress === 1));
        },
      ),
    );
  });
});
