import { PERIOD_DAYS } from './constants.ts';
import { addDays, daysBetween, isoWeekday, type LocalDate } from './dates.ts';
import type { HabitPeriod } from './duration.ts';

/** Day and week periods of habits (R-QST-04, R-QST-09): calendar weeks by the user's week start. */

export type WeekStart = 'monday' | 'sunday' | 'saturday';

/** ISO weekday (1 = Monday … 7 = Sunday) on which each kind of week begins. */
const FIRST_WEEKDAY: Readonly<Record<WeekStart, number>> = Object.freeze({ monday: 1, sunday: 7, saturday: 6 });

/** The first day of the calendar week that contains `date`. */
export function weekStartOf(date: LocalDate, weekStart: WeekStart): LocalDate {
  const daysIntoWeek = (isoWeekday(date) - FIRST_WEEKDAY[weekStart] + PERIOD_DAYS.week) % PERIOD_DAYS.week;
  return addDays(date, -daysIntoWeek);
}

/** A period is keyed by its first day: the date itself, or the first day of its calendar week. */
export function periodKeyFor(date: LocalDate, period: HabitPeriod, weekStart: WeekStart): LocalDate {
  return period === 'day' ? date : weekStartOf(date, weekStart);
}

/** One run of a habit: from its start date (creation or restart), with the week start it began with (Q-34). */
export interface HabitRun {
  readonly period: HabitPeriod;
  readonly startDate: LocalDate;
  readonly weekStart: WeekStart;
}

/** First and last day of a period, both included. */
export interface Period {
  readonly start: LocalDate;
  readonly end: LocalDate;
}

/** A daily run's first period is its start date; a weekly run's lasts to the end of the first full week (Q-33). */
function firstPeriodEnd(run: HabitRun): LocalDate {
  if (run.period === 'day') return run.startDate;
  const lastDayOfFirstWeek = PERIOD_DAYS.week - 1;
  return addDays(weekStartOf(addDays(run.startDate, lastDayOfFirstWeek), run.weekStart), lastDayOfFirstWeek);
}

/** Period `index` of a run, counted from 0. */
export function periodOfRun(run: HabitRun, index: number): Period {
  if (!Number.isInteger(index) || index < 0) throw new RangeError('a period index is a whole number from 0');
  const firstEnd = firstPeriodEnd(run);
  if (index === 0) return { start: run.startDate, end: firstEnd };
  const length = PERIOD_DAYS[run.period];
  return { start: addDays(firstEnd, (index - 1) * length + 1), end: addDays(firstEnd, index * length) };
}

/** Index of the period of `run` that contains `date`; −1 before the run starts. */
export function periodIndexOf(run: HabitRun, date: LocalDate): number {
  if (daysBetween(run.startDate, date) < 0) return -1;
  // Days inside the first period lie at or before its end: 0 or negative, so the period index is 0.
  return Math.max(0, Math.ceil(daysBetween(firstPeriodEnd(run), date) / PERIOD_DAYS[run.period]));
}
