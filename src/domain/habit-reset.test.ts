import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, fromDayNumber, type LocalDate } from './dates.ts';
import { evaluateHabit, type Habit, type HabitEvaluation } from './habit-reset.ts';
import { periodIndexOf, periodOfRun, type WeekStart } from './periods.ts';

const weekly = (
  startDate: string,
  timesPerPeriod: number,
  periodCount: number,
  weekStart: WeekStart = 'monday',
): Habit => ({
  run: { period: 'week', startDate, weekStart },
  timesPerPeriod,
  periodCount,
});
const daily = (startDate: string, timesPerPeriod: number, periodCount: number): Habit => ({
  run: { period: 'day', startDate, weekStart: 'monday' },
  timesPerPeriod,
  periodCount,
});
const days = (first: string, count: number): LocalDate[] => Array.from({ length: count }, (_, i) => addDays(first, i));

describe('habit evaluation [R-QST-04, A-21, Q-33]', () => {
  it('counts a period as met once it has N counting check-ins, while it is still open', () => {
    const habit = weekly('2026-10-26', 3, 4);

    expect(evaluateHabit(habit, days('2026-10-26', 3), '2026-10-29')).toEqual({
      state: 'running',
      metPeriods: 1,
      currentPeriod: { start: '2026-10-26', end: '2026-11-01', checkIns: 3, required: 3 },
    });
  });

  it('counts 6 check-ins in a week of a 5× habit as one met period, not 6/5', () => {
    const habit = weekly('2026-10-26', 5, 8);

    expect(evaluateHabit(habit, days('2026-10-26', 6), '2026-11-02')).toMatchObject({
      state: 'running',
      metPeriods: 1,
    });
  });

  it('resets on the first closed period with fewer than N counting check-ins', () => {
    const habit = weekly('2026-10-26', 3, 4);
    const checkIns = [...days('2026-10-26', 3), ...days('2026-11-02', 2)];

    expect(evaluateHabit(habit, checkIns, '2026-11-09')).toEqual({
      state: 'reset',
      metPeriods: 1,
      missedPeriod: { start: '2026-11-02', end: '2026-11-08' },
    });
  });

  it('never resets on the open period, even on its last day without a check-in', () => {
    expect(evaluateHabit(weekly('2026-10-26', 3, 4), [], '2026-11-01')).toMatchObject({
      state: 'running',
      metPeriods: 0,
    });
  });

  it('gives a weekly habit started mid-week its whole first period: no reset at the end of the calendar week (Q-33)', () => {
    const habit = weekly('2026-10-28', 2, 4);

    expect(evaluateHabit(habit, [], '2026-11-02')).toEqual({
      state: 'running',
      metPeriods: 0,
      currentPeriod: { start: '2026-10-28', end: '2026-11-08', checkIns: 0, required: 2 },
    });
    expect(evaluateHabit(habit, [], '2026-11-09')).toMatchObject({
      state: 'reset',
      missedPeriod: { end: '2026-11-08' },
    });
  });

  it('completes as soon as the last period is met, without waiting for it to close', () => {
    const habit = weekly('2026-10-26', 2, 2);
    const checkIns = [...days('2026-10-26', 2), '2026-11-03', '2026-11-04'];

    expect(evaluateHabit(habit, checkIns.slice(0, 3), '2026-11-04')).toMatchObject({ state: 'running', metPeriods: 1 });
    expect(evaluateHabit(habit, checkIns, '2026-11-04')).toEqual({ state: 'completed', metPeriods: 2 });
    expect(evaluateHabit(habit, checkIns, '2027-02-01')).toEqual({ state: 'completed', metPeriods: 2 });
  });

  it('runs a daily habit day by day, across both Zurich DST dates (calendar dates, no instants) [R-STR-02]', () => {
    const habit = daily('2026-10-24', 1, 5);

    expect(evaluateHabit(habit, days('2026-10-24', 3), '2026-10-26')).toMatchObject({
      state: 'running',
      metPeriods: 3,
    });
    expect(evaluateHabit(habit, days('2026-10-24', 3), '2026-10-28')).toEqual({
      state: 'reset',
      metPeriods: 3,
      missedPeriod: { start: '2026-10-27', end: '2026-10-27' },
    });
    expect(evaluateHabit(daily('2026-03-28', 1, 3), days('2026-03-28', 3), '2026-03-30')).toEqual({
      state: 'completed',
      metPeriods: 3,
    });
  });

  it('shows the first period of a run that has not started yet, with no check-ins', () => {
    expect(evaluateHabit(weekly('2026-11-04', 3, 4), ['2026-10-29'], '2026-10-29')).toEqual({
      state: 'running',
      metPeriods: 0,
      currentPeriod: { start: '2026-11-04', end: '2026-11-15', checkIns: 0, required: 3 },
    });
  });

  it('ignores counting check-ins from before the run started (an earlier run of a restarted habit)', () => {
    const habit = daily('2026-10-29', 1, 3);

    expect(evaluateHabit(habit, ['2026-10-27', '2026-10-28'], '2026-10-29')).toMatchObject({ metPeriods: 0 });
  });

  it.each([
    [0, 4],
    [3, 0],
    [1.5, 4],
    [3, Number.NaN],
  ])('refuses %d check-ins per period over %d periods', (timesPerPeriod, periodCount) => {
    expect(() => evaluateHabit(weekly('2026-10-26', timesPerPeriod, periodCount), [], '2026-10-29')).toThrow(
      'a habit needs at least one check-in per period and at least one period',
    );
  });

  describe('properties', () => {
    interface Scenario {
      readonly habit: Habit;
      readonly checkIns: readonly LocalDate[];
      readonly firstDay: LocalDate;
    }
    const scenarios = fc
      .record({
        period: fc.constantFrom<'day' | 'week'>('day', 'week'),
        weekStart: fc.constantFrom<WeekStart>('monday', 'sunday', 'saturday'),
        start: fc.integer({ min: 20_000, max: 21_000 }),
        timesPerPeriod: fc.integer({ min: 1, max: 4 }),
        periodCount: fc.integer({ min: 1, max: 6 }),
        offsets: fc.array(fc.integer({ min: -3, max: 60 }), { maxLength: 40 }),
      })
      .map(({ period, weekStart, start, timesPerPeriod, periodCount, offsets }): Scenario => {
        const startDate = fromDayNumber(start);
        return {
          habit: { run: { period, startDate, weekStart }, timesPerPeriod, periodCount },
          checkIns: offsets.map((offset) => addDays(startDate, offset)),
          firstDay: startDate,
        };
      });
    /** A day on or after every check-in: check-ins are never dated in the future. */
    const evaluationDay = (scenario: Scenario, extra: number) =>
      addDays([scenario.firstDay, ...scenario.checkIns].sort().at(-1) ?? scenario.firstDay, extra);

    it('a reset found on one day is found, unchanged, on every later day (lazy evaluation = daily job, A-21)', () => {
      fc.assert(
        fc.property(scenarios, fc.nat(30), fc.nat(60), (scenario, first, later) => {
          const early = evaluateHabit(scenario.habit, scenario.checkIns, evaluationDay(scenario, first));
          const late = evaluateHabit(scenario.habit, scenario.checkIns, evaluationDay(scenario, first + later));

          if (early.state === 'reset' || early.state === 'completed') expect(late).toEqual(early);
          if (late.state === 'reset' && late.missedPeriod.end < evaluationDay(scenario, first))
            expect(early).toEqual(late);
        }),
      );
    });

    it('resets exactly when a closed period before completion lacks check-ins, and reports the first such period', () => {
      fc.assert(
        fc.property(scenarios, fc.nat(60), (scenario, extra) => {
          const today = evaluationDay(scenario, extra);
          const result: HabitEvaluation = evaluateHabit(scenario.habit, scenario.checkIns, today);
          const counts = (index: number) =>
            scenario.checkIns.filter((date) => periodIndexOf(scenario.habit.run, date) === index).length;
          let expected: number | undefined;
          for (let index = 0; index < scenario.habit.periodCount; index += 1) {
            const period = periodOfRun(scenario.habit.run, index);
            if (period.end >= today) break;
            if (counts(index) < scenario.habit.timesPerPeriod) {
              expected = index;
              break;
            }
          }

          expect(result.state === 'reset').toBe(expected !== undefined);
          if (result.state === 'reset' && expected !== undefined) {
            expect(result.missedPeriod).toEqual(periodOfRun(scenario.habit.run, expected));
            expect(result.metPeriods).toBe(expected);
          }
          expect(result.metPeriods).toBeLessThanOrEqual(scenario.habit.periodCount);
        }),
      );
    });

    it('a check-in made today never causes a reset and never lowers the met periods', () => {
      fc.assert(
        fc.property(scenarios, fc.nat(60), (scenario, extra) => {
          const today = evaluationDay(scenario, extra);
          const before = evaluateHabit(scenario.habit, scenario.checkIns, today);
          const after = evaluateHabit(scenario.habit, [...scenario.checkIns, today], today);

          if (before.state !== 'reset') expect(after.state).not.toBe('reset');
          expect(after.metPeriods).toBeGreaterThanOrEqual(before.metPeriods);
        }),
      );
    });
  });
});
