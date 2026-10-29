import { BASE_DURATION_FACTOR, DURATION_FACTORS, PERIOD_DAYS, SIZE_XP } from './constants.ts';

/** Duration factor and effective XP of a quest (R-QST-01, R-XP-02), derived from its structure only. */

export type QuestSize = keyof typeof SIZE_XP;
export type HabitPeriod = keyof typeof PERIOD_DAYS;

/** What decides a habit's duration factor: never a claim of the user (Q-05g/h). */
export interface HabitSpan {
  readonly period: HabitPeriod;
  readonly periodCount: number;
}

/** `period_count` days for a daily habit, `period_count × 7` for a weekly one. */
export function habitSpanDays(habit: HabitSpan): number {
  if (!Number.isInteger(habit.periodCount) || habit.periodCount < 1) {
    throw new RangeError('a habit has a whole number of periods, at least one');
  }
  return habit.periodCount * PERIOD_DAYS[habit.period];
}

/** ×1 up to 28 days and for one-time and target quests (`null`), ×1.5 up to 56, ×2 up to 112, ×3 beyond. */
export function durationFactor(habit: HabitSpan | null): number {
  const days = habit === null ? 0 : habitSpanDays(habit);
  return DURATION_FACTORS.find((row) => days >= row.fromDays)?.factor ?? BASE_DURATION_FACTOR;
}

/** `round(base × factor)`, half up: an M habit over 29 days is worth round(37.5) = 38 XP. */
export function effectiveXp(size: QuestSize, habit: HabitSpan | null): number {
  return Math.round(SIZE_XP[size] * durationFactor(habit));
}
