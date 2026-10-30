import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, type LocalDate } from './dates.ts';
import { evaluateHabit, type Habit, type HabitEvaluation } from './habit-reset.ts';
import { bestAfterRunEnds, habitStreak, topStreaks } from './streak.ts';

const running = (metPeriods: number): HabitEvaluation => ({
  state: 'running',
  metPeriods,
  currentPeriod: { start: '2026-10-29', end: '2026-10-29', checkIns: 0, required: 1 },
});
const days = (first: string, count: number): LocalDate[] => Array.from({ length: count }, (_, i) => addDays(first, i));

describe('streaks [R-STR-01, R-STR-02]', () => {
  it('counts the met periods of the running habit; the open period never breaks the streak', () => {
    expect(habitStreak(running(3), 0)).toEqual({ current: 3, best: 3 });
    expect(habitStreak(running(0), 0)).toEqual({ current: 0, best: 0 });
  });

  it('drops to 0 after a reset, while the best streak keeps the run that ended', () => {
    const reset: HabitEvaluation = {
      state: 'reset',
      metPeriods: 4,
      missedPeriod: { start: '2026-10-29', end: '2026-10-29' },
    };

    expect(habitStreak(reset, 2)).toEqual({ current: 0, best: 4 });
    expect(habitStreak(reset, 6)).toEqual({ current: 0, best: 6 });
  });

  it('keeps the full streak of a completed habit', () => {
    expect(habitStreak({ state: 'completed', metPeriods: 8 }, 5)).toEqual({ current: 8, best: 8 });
  });

  it('takes the best of the ended runs when the current run is shorter', () => {
    expect(habitStreak(running(2), 7)).toEqual({ current: 2, best: 7 });
  });

  it('remembers the longer of the stored best and the run that just ended (a reset or a pause)', () => {
    expect(bestAfterRunEnds(3, running(5))).toBe(5);
    expect(bestAfterRunEnds(9, running(5))).toBe(9);
    expect(bestAfterRunEnds(0, { state: 'completed', metPeriods: 4 })).toBe(4);
  });

  it('follows a daily habit day by day across the Zurich DST change of 2026-10-25', () => {
    const habit: Habit = {
      run: { period: 'day', startDate: '2026-10-23', weekStart: 'monday' },
      timesPerPeriod: 1,
      periodCount: 10,
    };

    expect(habitStreak(evaluateHabit(habit, days('2026-10-23', 3), '2026-10-25'), 0)).toEqual({ current: 3, best: 3 });
    expect(habitStreak(evaluateHabit(habit, days('2026-10-23', 4), '2026-10-27'), 0)).toEqual({ current: 4, best: 4 });
    expect(habitStreak(evaluateHabit(habit, days('2026-10-23', 4), '2026-10-28'), 0)).toEqual({ current: 0, best: 4 });
  });

  it('never reports a current streak above the best one', () => {
    fc.assert(
      fc.property(fc.nat(520), fc.nat(520), fc.constantFrom('running', 'completed', 'reset'), (met, stored, state) => {
        const evaluation: HabitEvaluation =
          state === 'running'
            ? running(met)
            : state === 'completed'
              ? { state, metPeriods: met }
              : { state, metPeriods: met, missedPeriod: { start: '2026-10-29', end: '2026-10-29' } };
        const streak = habitStreak(evaluation, stored);

        expect(streak.current).toBeLessThanOrEqual(streak.best);
        expect(streak.best).toBe(Math.max(stored, met));
      }),
    );
  });
});

describe('best streaks in the stats [R-STA-01]', () => {
  const streak = (questId: string, best: number, current: number) => ({ questId, best, current });

  it('lists the best streaks first, then the longer current streak, then by quest, at most the limit', () => {
    const items = [streak('c', 3, 1), streak('a', 5, 0), streak('b', 5, 2), streak('d', 3, 1), streak('e', 1, 1)];

    expect(topStreaks(items, 4).map((item) => item.questId)).toEqual(['b', 'a', 'c', 'd']);
    expect(topStreaks(items, 20)).toHaveLength(5);
    expect(items.map((item) => item.questId)).toEqual(['c', 'a', 'b', 'd', 'e']);
  });
});
