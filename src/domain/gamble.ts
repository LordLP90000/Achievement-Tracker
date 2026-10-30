import { MIN_ACHIEVEMENT_AGE_MS } from './constants.ts';
import { daysBetween, type LocalDate } from './dates.ts';
import { xpAboveLevel } from './xp.ts';

/**
 * Gambles (R-GMB-01…05): XP only, double or nothing on unlocking an achievement by its target date. A user has at most
 * one pending gamble; a win pays at most the achievement's required XP and nothing for an achievement younger than
 * 7 × 24 hours; a loss never takes more than the XP above the current level's threshold (Q-31, A-34).
 */

export type GambleStatus = 'pending' | 'won' | 'lost';
export type GambleLossReason = 'target_date_passed' | 'habit_reset' | 'paused' | 'deleted';
export type AchievementStatus = 'active' | 'paused' | 'completed';

/** Problem slugs of `placeGamble`, in the order the contract lists them; `nothing-to-stake` is the 422. */
export type PlacementRefusal =
  | 'achievement-not-active'
  | 'gamble-target-date-required'
  | 'gamble-pending'
  | 'gamble-lost-this-attempt'
  | 'nothing-to-stake';

export interface PlacementInputs {
  readonly achievementStatus: AchievementStatus;
  readonly targetDate: LocalDate | null;
  readonly today: LocalDate;
  /** A pending gamble on any achievement of the user (Q-31). */
  readonly userHasPendingGamble: boolean;
  /** A gamble lost on this achievement in its current attempt (A-27). */
  readonly lostThisAttempt: boolean;
  readonly totalXp: number;
}

export type Placement =
  | { readonly outcome: 'placed'; readonly stake: number }
  | { readonly outcome: 'refused'; readonly reason: PlacementRefusal };

function refusalOf(inputs: PlacementInputs, stake: number): PlacementRefusal | undefined {
  if (inputs.achievementStatus !== 'active') return 'achievement-not-active';
  if (inputs.targetDate === null || daysBetween(inputs.today, inputs.targetDate) <= 0) {
    return 'gamble-target-date-required';
  }
  if (inputs.userHasPendingGamble) return 'gamble-pending';
  if (inputs.lostThisAttempt) return 'gamble-lost-this-attempt';
  return stake > 0 ? undefined : 'nothing-to-stake';
}

/** The stake is the XP above the current level's threshold, computed server-side (R-GMB-01, T-17). */
export function placeGamble(inputs: PlacementInputs): Placement {
  const stake = xpAboveLevel(inputs.totalXp);
  const reason = refusalOf(inputs, stake);
  return reason === undefined ? { outcome: 'placed', stake } : { outcome: 'refused', reason };
}

/** A settlement as the contract's `GambleOutcome` reports it; a negative delta never comes out as −0. */
export type Settlement =
  | { readonly outcome: 'won'; readonly xpDelta: number }
  | { readonly outcome: 'lost'; readonly xpDelta: number; readonly lossReason: GambleLossReason }
  | { readonly outcome: 'reverted'; readonly xpDelta: number };

/** Loses the stake, at most the XP above the current level's threshold: the level never drops (R-GMB-03, Q-31). */
export function settleAsLost(stake: number, totalXp: number, lossReason: GambleLossReason): Settlement {
  return { outcome: 'lost', xpDelta: 0 - Math.min(stake, xpAboveLevel(totalXp)), lossReason };
}

export interface UnlockFacts {
  /** The unlock's date in the account's time zone. */
  readonly date: LocalDate;
  /** Σ effective XP of the achievement's required quests: the most a win pays (Q-31). */
  readonly requiredXp: number;
  /** Time from the achievement's creation to its unlock (A-34). */
  readonly achievementAgeMs: number;
  /** The total when the gamble settles, for a loss. */
  readonly totalXp: number;
}

/** Won on or before the target date (A-20); after it the gamble is lost, as the daily job would have settled it. */
export function settleOnUnlock(gamble: { stake: number; targetDate: LocalDate }, unlock: UnlockFacts): Settlement {
  if (daysBetween(unlock.date, gamble.targetDate) < 0) {
    return settleAsLost(gamble.stake, unlock.totalXp, 'target_date_passed');
  }
  const paid = unlock.achievementAgeMs < MIN_ACHIEVEMENT_AGE_MS ? 0 : Math.min(gamble.stake, unlock.requiredXp);
  return { outcome: 'won', xpDelta: paid };
}

/** The daily check (A-20): the target date has fully passed in the account's time zone. */
export function targetDatePassed(targetDate: LocalDate, today: LocalDate): boolean {
  return daysBetween(targetDate, today) > 0;
}

/** Undoing the unlock that won takes back exactly what the win paid; the gamble is pending again (R-ACH-05). */
export function revertWin(wonXp: number): Settlement {
  return { outcome: 'reverted', xpDelta: 0 - wonXp };
}

/** Each settlement happens once: pending settles as won or lost, a win can only be reverted, a loss is final. */
export function assertGambleTransition(from: GambleStatus, to: GambleStatus): void {
  const settles = from === 'pending' && to !== 'pending';
  const reverts = from === 'won' && to === 'pending';
  if (!(settles || reverts)) throw new Error(`a gamble cannot go from ${from} to ${to}`);
}
