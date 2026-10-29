/**
 * Every tunable number of the game rules (ADR-0015): changing one is a one-line change here plus the update of its
 * table-driven test. Each domain file adds its numbers when it arrives.
 */

/** Base XP per quest size (R-QST-01). */
export const SIZE_XP = Object.freeze({ S: 10, M: 25, L: 50 });

/** Days in one habit period (R-XP-02). */
export const PERIOD_DAYS = Object.freeze({ day: 1, week: 7 });

/** Duration factor of a habit by its span in days, longest span first (R-XP-02, Q-05g/h). */
export const DURATION_FACTORS: readonly { readonly fromDays: number; readonly factor: number }[] = Object.freeze([
  { fromDays: 113, factor: 3 },
  { fromDays: 57, factor: 2 },
  { fromDays: 29, factor: 1.5 },
]);

/** Factor of shorter habits and of one-time and target quests. */
export const BASE_DURATION_FACTOR = 1;

/** Level curve (R-XP-03, Q-05e): reaching level L ≥ 2 takes LEVEL_BASE_XP × LEVEL_GROWTH^(L − 2) XP in total. */
export const LEVEL_BASE_XP = 100;
export const LEVEL_GROWTH = 3;

/** How many days back a check-in may be dated; such check-ins are history and never count (R-CHK-04, Q-08). */
export const BACKDATE_LIMIT_DAYS = 7;
