/** Progress of quests and achievements (R-ACH-03, R-QST-03…05): from 0 to 1, where 1 means complete. */

/** A one-time quest is complete with its first counting check-in (R-QST-03). */
export function oneTimeProgress(countingCheckIns: number): number {
  return countingCheckIns > 0 ? 1 : 0;
}

/**
 * `clamp((current − start) / (target − start), 0, 1)` for increasing and decreasing targets (R-QST-05); values in
 * thousandths (`decimal.ts`), `current` being the latest counting check-in or else the start value.
 */
export function targetProgress(start: number, target: number, current: number): number {
  if (start === target) throw new RangeError('a target differs from its start value');
  return Math.min(1, Math.max(0, (current - start) / (target - start)));
}

/** Consecutive met periods of the current run over the periods required (R-QST-04). */
export function habitProgress(metPeriods: number, periodCount: number): number {
  return Math.min(1, metPeriods / periodCount);
}

export interface WeightedProgress {
  readonly isRequired: boolean;
  /** Effective XP of the quest (`duration.ts`), its weight. */
  readonly xp: number;
  readonly progress: number;
}

/** The highest progress of an incomplete achievement: a floating-point sum must never round it up to 1. */
const BELOW_COMPLETE = 1 - Number.EPSILON;

/**
 * The XP-weighted mean progress of the required quests (R-ACH-03); bonus quests never count, and an achievement
 * without required quests stays at 0 (A-17). It is 1 exactly when every required quest is complete.
 */
export function achievementProgress(quests: readonly WeightedProgress[]): number {
  const required = quests.filter((quest) => quest.isRequired);
  if (required.every((quest) => quest.progress === 1)) return required.length > 0 ? 1 : 0;
  const weight = required.reduce((sum, quest) => sum + quest.xp, 0);
  const earned = required.reduce((sum, quest) => sum + quest.xp * quest.progress, 0);
  return Math.min(earned / weight, BELOW_COMPLETE);
}
