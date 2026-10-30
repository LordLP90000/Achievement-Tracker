import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays } from './dates.ts';
import {
  deadlineAfterTargetChange,
  executionScore,
  isFlawless,
  rankBonus,
  rankForScore,
  type FlawlessInputs,
  type ScoreInputs,
  type ScoredQuest,
} from './rank.ts';

const DAY_MS = 86_400_000;
const quest = (overrides: Partial<ScoredQuest> = {}): ScoredQuest => ({
  isRequired: true,
  xp: 10,
  resetCount: 0,
  completed: true,
  ...overrides,
});
const onTime: ScoreInputs = { quests: [quest()], deadline: null, unlockDate: '2026-10-29', lostGambles: 0 };

describe('execution score [R-RANK-01, Q-31, A-35]', () => {
  it('is 100 for an attempt without resets, lateness or lost gambles', () => {
    expect(executionScore(onTime)).toBe(100);
  });

  it('scores each required quest 100 / (1 + its resets), weighted by XP; bonus quests do not count', () => {
    const inputs: ScoreInputs = {
      ...onTime,
      quests: [
        quest({ xp: 10, resetCount: 0 }),
        quest({ xp: 30, resetCount: 1 }),
        quest({ xp: 50, resetCount: 3, isRequired: false }),
      ],
    };

    expect(executionScore(inputs)).toBe(62.5);
  });

  it.each([
    [0, 100],
    [1, 96.67],
    [15, 50],
    [30, 0],
    [31, 0],
  ])('multiplies by max(0, 1 − days late / 30): %i day(s) after the deadline → %d', (daysLate, score) => {
    expect(executionScore({ ...onTime, deadline: '2026-10-01', unlockDate: addDays('2026-10-01', daysLate) })).toBe(
      score,
    );
  });

  it('counts an unlock on the deadline itself, or before it, as on time [A-20]', () => {
    expect(executionScore({ ...onTime, deadline: '2026-10-29', unlockDate: '2026-10-29' })).toBe(100);
    expect(executionScore({ ...onTime, deadline: '2026-11-15', unlockDate: '2026-10-29' })).toBe(100);
  });

  it('subtracts 10 points per gamble lost on the achievement, never going below 0', () => {
    expect(executionScore({ ...onTime, lostGambles: 1 })).toBe(90);
    expect(executionScore({ ...onTime, lostGambles: 3 })).toBe(70);
    expect(executionScore({ ...onTime, lostGambles: 11 })).toBe(0);
  });

  it('rounds to two decimals', () => {
    expect(executionScore({ ...onTime, quests: [quest({ resetCount: 2 })] })).toBe(33.33);
    expect(executionScore({ ...onTime, quests: [quest({ resetCount: 5 })] })).toBe(16.67);
  });

  it('refuses an achievement without required quests, which can never unlock [A-17]', () => {
    expect(() => executionScore({ ...onTime, quests: [quest({ isRequired: false })] })).toThrow(
      'an unlocked achievement has required quests',
    );
  });

  it('never rises when a reset, a late day or a lost gamble is added', () => {
    const scenario = fc.record({
      quests: fc.array(
        fc.record({
          isRequired: fc.boolean(),
          xp: fc.integer({ min: 1, max: 150 }),
          resetCount: fc.nat(5),
          completed: fc.constant(true),
        }),
        { minLength: 1, maxLength: 10 },
      ),
      daysLate: fc.integer({ min: -10, max: 40 }),
      lostGambles: fc.nat(5),
    });
    fc.assert(
      fc.property(scenario, fc.nat(9), fc.constantFrom('reset', 'late', 'gamble'), (s, which, worse) => {
        fc.pre(s.quests.some((q) => q.isRequired));
        const inputs = (daysLate: number, lostGambles: number, quests: readonly ScoredQuest[]): ScoreInputs => ({
          quests,
          deadline: '2026-10-01',
          unlockDate: addDays('2026-10-01', daysLate),
          lostGambles,
        });
        const base = inputs(s.daysLate, s.lostGambles, s.quests);
        const index = which % s.quests.length;
        const worsened =
          worse === 'reset'
            ? inputs(
                s.daysLate,
                s.lostGambles,
                s.quests.map((q, i) => (i === index ? { ...q, resetCount: q.resetCount + 1 } : q)),
              )
            : worse === 'late'
              ? inputs(s.daysLate + 1, s.lostGambles, s.quests)
              : inputs(s.daysLate, s.lostGambles + 1, s.quests);

        expect(executionScore(worsened)).toBeLessThanOrEqual(executionScore(base));
        const order = ['unranked', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'champion'];
        expect(order.indexOf(rankForScore(executionScore(worsened), false))).toBeLessThanOrEqual(
          order.indexOf(rankForScore(executionScore(base), false)),
        );
      }),
    );
  });
});

describe('ranks [R-RANK-02]', () => {
  it.each([
    [0, 'unranked'],
    [54.99, 'unranked'],
    [55, 'bronze'],
    [64.99, 'bronze'],
    [65, 'silver'],
    [75, 'gold'],
    [85, 'platinum'],
    [91.99, 'platinum'],
    [92, 'emerald'],
    [99.99, 'emerald'],
    [100, 'diamond'],
  ] as const)('a score of %d is %s', (score, rank) => {
    expect(rankForScore(score, false)).toBe(rank);
  });

  it('makes a perfect score Champion only when the run was flawless', () => {
    expect(rankForScore(100, true)).toBe('champion');
    expect(rankForScore(99.99, true)).toBe('emerald');
  });

  const flawless: FlawlessInputs = {
    attempt: 1,
    quests: [quest(), quest({ isRequired: false })],
    lostGambles: 0,
    deadline: '2026-10-29',
    unlockDate: '2026-10-29',
  };

  it('calls a run flawless: first attempt, no reset in any quest, every bonus quest done, no lost gamble, on time', () => {
    expect(isFlawless(flawless)).toBe(true);
    expect(isFlawless({ ...flawless, deadline: null })).toBe(true);
  });

  it.each([
    ['a second attempt', { attempt: 2 }],
    ['a reset in a bonus quest', { quests: [quest(), quest({ isRequired: false, resetCount: 1 })] }],
    ['a reset in a required quest', { quests: [quest({ resetCount: 1 })] }],
    ['an open bonus quest', { quests: [quest(), quest({ isRequired: false, completed: false })] }],
    ['a gamble lost in an earlier attempt', { lostGambles: 1 }],
    ['an unlock after the deadline', { unlockDate: '2026-10-30' }],
  ] as const)('is not flawless with %s', (_case, change) => {
    expect(isFlawless({ ...flawless, ...change })).toBe(false);
  });
});

describe('rank bonus [R-RANK-03, Q-31, A-34]', () => {
  const OLD_ENOUGH = 7 * DAY_MS;

  it.each([
    ['unranked', 0],
    ['bronze', 13],
    ['silver', 38],
    ['gold', 113],
    ['platinum', 338],
    ['emerald', 1_000],
    ['diamond', 3_000],
    ['champion', 9_125],
  ] as const)('pays round(25 required XP × multiplier) for %s: %i XP', (rank, bonus) => {
    expect(rankBonus(25, rank, OLD_ENOUGH)).toBe(bonus);
  });

  it('pays nothing when the achievement is less than 7 × 24 hours old at its unlock (A-34)', () => {
    expect(rankBonus(25, 'champion', OLD_ENOUGH - 1)).toBe(0);
    expect(rankBonus(25, 'champion', 0)).toBe(0);
    expect(rankBonus(25, 'champion', OLD_ENOUGH)).toBe(9_125);
  });
});

describe('the deadline of an attempt [Q-31, A-35]', () => {
  it('starts as the first target date, moves earlier with an earlier date, and ignores later or removed dates', () => {
    expect(deadlineAfterTargetChange(null, null)).toBeNull();
    expect(deadlineAfterTargetChange(null, '2026-12-01')).toBe('2026-12-01');
    expect(deadlineAfterTargetChange('2026-12-01', '2026-11-15')).toBe('2026-11-15');
    expect(deadlineAfterTargetChange('2026-11-15', '2026-12-31')).toBe('2026-11-15');
    expect(deadlineAfterTargetChange('2026-11-15', null)).toBe('2026-11-15');
  });
});
