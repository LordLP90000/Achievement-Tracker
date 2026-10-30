import {
  LATENESS_WINDOW_DAYS,
  LOST_GAMBLE_PENALTY,
  MIN_ACHIEVEMENT_AGE_MS,
  PERFECT_SCORE,
  RANK_MULTIPLIERS,
  RANK_THRESHOLDS,
  type Rank,
} from './constants.ts';
import { daysBetween, fromDayNumber, toDayNumber, type LocalDate } from './dates.ts';

/** Execution score, rank and rank bonus of an unlock (R-RANK-01…03), from server-recorded facts only (T-18). */

export type { Rank } from './constants.ts';

export interface ScoredQuest {
  readonly isRequired: boolean;
  /** Effective XP: the weight of the quest. */
  readonly xp: number;
  /** Habit resets in the current attempt; always 0 for one-time and target quests. */
  readonly resetCount: number;
  readonly completed: boolean;
}

export interface ScoreInputs {
  readonly quests: readonly ScoredQuest[];
  /** The attempt's deadline: the earliest target date in effect during it (Q-31, A-35); null without one. */
  readonly deadline: LocalDate | null;
  /** The unlock's date in the account's time zone. */
  readonly unlockDate: LocalDate;
  /** Gambles lost on this achievement, in any attempt. */
  readonly lostGambles: number;
}

/** Days after the deadline; an unlock on the deadline itself is on time (A-20). */
function daysLate(inputs: Pick<ScoreInputs, 'deadline' | 'unlockDate'>): number {
  return inputs.deadline === null ? 0 : Math.max(0, daysBetween(inputs.deadline, inputs.unlockDate));
}

/**
 * 0–100, two decimals: the XP-weighted mean of `100 / (1 + resets)` over the required quests, times
 * `max(0, 1 − days late / 30)`, minus 10 per lost gamble, clamped.
 */
export function executionScore(inputs: ScoreInputs): number {
  const required = inputs.quests.filter((quest) => quest.isRequired);
  if (required.length === 0) throw new RangeError('an unlocked achievement has required quests');
  const weight = required.reduce((sum, quest) => sum + quest.xp, 0);
  const execution =
    required.reduce((sum, quest) => sum + (quest.xp * PERFECT_SCORE) / (1 + quest.resetCount), 0) / weight;
  const lateness = Math.max(0, 1 - daysLate(inputs) / LATENESS_WINDOW_DAYS);
  const score = execution * lateness - LOST_GAMBLE_PENALTY * inputs.lostGambles;
  return Math.round(Math.min(PERFECT_SCORE, Math.max(0, score)) * 100) / 100;
}

export interface FlawlessInputs extends Omit<ScoreInputs, 'quests'> {
  readonly attempt: number;
  readonly quests: readonly ScoredQuest[];
}

/**
 * Champion's conditions besides the perfect score (R-RANK-02): the first attempt, no reset in any quest — bonus
 * quests included — every bonus quest completed, no gamble ever lost on the achievement, and on time.
 */
export function isFlawless(inputs: FlawlessInputs): boolean {
  return (
    inputs.attempt === 1 &&
    inputs.quests.every((quest) => quest.resetCount === 0 && quest.completed) &&
    inputs.lostGambles === 0 &&
    daysLate(inputs) === 0
  );
}

export function rankForScore(score: number, flawless: boolean): Rank {
  if (score === PERFECT_SCORE) return flawless ? 'champion' : 'diamond';
  return RANK_THRESHOLDS.find((threshold) => score >= threshold.minScore)?.rank ?? 'unranked';
}

/**
 * `round(Σ required XP × multiplier)` (R-RANK-03); nothing when the achievement was created less than 7 × 24 hours
 * before its unlock, so a trivial same-day achievement earns no bonus (Q-31, A-34).
 */
export function rankBonus(requiredXp: number, rank: Rank, achievementAgeMs: number): number {
  if (achievementAgeMs < MIN_ACHIEVEMENT_AGE_MS) return 0;
  return Math.round(requiredXp * RANK_MULTIPLIERS[rank]);
}

/** The deadline after `target_date` changes: the earliest target date in effect during the attempt (A-35). */
export function deadlineAfterTargetChange(deadline: LocalDate | null, targetDate: LocalDate | null): LocalDate | null {
  if (targetDate === null) return deadline;
  if (deadline === null) return targetDate;
  return fromDayNumber(Math.min(toDayNumber(deadline), toDayNumber(targetDate)));
}
