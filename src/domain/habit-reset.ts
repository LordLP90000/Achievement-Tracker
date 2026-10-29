import { daysBetween, type LocalDate } from './dates.ts';
import { periodIndexOf, periodOfRun, type HabitRun, type Period } from './periods.ts';

/**
 * Habit evaluation (R-QST-04): a pure function of the run, its counting check-ins and today, so evaluating lazily on
 * every read and write gives the same result as the daily job (A-21) — a closed period never gains check-ins.
 */

export interface Habit {
  readonly run: HabitRun;
  /** N: counting check-ins that meet a period. */
  readonly timesPerPeriod: number;
  /** K: consecutive met periods that complete the habit. */
  readonly periodCount: number;
}

/** The open period of a running habit (Q-35): today's, or the first one while the run has not started. */
export interface CurrentPeriod extends Period {
  readonly checkIns: number;
  readonly required: number;
}

export type HabitEvaluation =
  | { readonly state: 'running'; readonly metPeriods: number; readonly currentPeriod: CurrentPeriod }
  | { readonly state: 'completed'; readonly metPeriods: number }
  /** The first closed period with fewer than N counting check-ins: the run is over and needs a restart. */
  | { readonly state: 'reset'; readonly metPeriods: number; readonly missedPeriod: Period };

/**
 * Walks the periods of the run in order: a closed period must be met, or the habit resets; the open period counts once
 * it is met and never resets the habit; the habit completes as soon as its K-th period is met.
 */
export function evaluateHabit(habit: Habit, countingDates: readonly LocalDate[], today: LocalDate): HabitEvaluation {
  const { timesPerPeriod, periodCount } = habit;
  if (!(Number.isInteger(timesPerPeriod) && Number.isInteger(periodCount) && timesPerPeriod > 0 && periodCount > 0)) {
    throw new RangeError('a habit needs at least one check-in per period and at least one period');
  }
  const checkInsPerPeriod = new Map<number, number>();
  for (const date of countingDates) {
    const index = periodIndexOf(habit.run, date);
    checkInsPerPeriod.set(index, (checkInsPerPeriod.get(index) ?? 0) + 1);
  }
  for (let index = 0; index < periodCount; index += 1) {
    const period = periodOfRun(habit.run, index);
    const checkIns = checkInsPerPeriod.get(index) ?? 0;
    const met = checkIns >= timesPerPeriod;
    if (daysBetween(period.end, today) > 0) {
      if (!met) return { state: 'reset', metPeriods: index, missedPeriod: period };
    } else if (!met || index < periodCount - 1) {
      // The open period ends the walk, unless it is the last one and already met: then the habit is complete.
      const currentPeriod = { ...period, checkIns, required: timesPerPeriod };
      return { state: 'running', metPeriods: met ? index + 1 : index, currentPeriod };
    }
  }
  return { state: 'completed', metPeriods: periodCount };
}
