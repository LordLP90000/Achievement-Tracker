import { LEVEL_BASE_XP, LEVEL_GROWTH } from './constants.ts';

/**
 * Levels and XP totals (R-XP-03, R-XP-04). A total is a non-negative safe integer; the level is derived from it, and
 * level 1 starts at 0 XP.
 */

/** Thresholds of levels 1, 2, 3 …, as long as they are safe integers. */
const THRESHOLDS: readonly number[] = (() => {
  const thresholds = [0];
  for (let next = LEVEL_BASE_XP; Number.isSafeInteger(next); next *= LEVEL_GROWTH) thresholds.push(next);
  return thresholds;
})();

/** The highest level: the next threshold would not be a safe integer (far beyond reach, given the caps of Q-31). */
export const MAX_LEVEL = THRESHOLDS.length;

function assertTotal(totalXp: number): void {
  if (!Number.isSafeInteger(totalXp) || totalXp < 0) {
    throw new RangeError('an XP total is a non-negative safe integer');
  }
}

/** Total XP at which `level` begins. */
export function xpThreshold(level: number): number {
  const threshold = THRESHOLDS[level - 1];
  if (threshold === undefined) throw new RangeError('no such level');
  return threshold;
}

export function levelForXp(totalXp: number): number {
  assertTotal(totalXp);
  return THRESHOLDS.findLastIndex((threshold) => threshold <= totalXp) + 1;
}

/** XP still missing to the next level; 0 at the highest level. */
export function xpToNextLevel(totalXp: number): number {
  const level = levelForXp(totalXp);
  return level === MAX_LEVEL ? 0 : xpThreshold(level + 1) - totalXp;
}

/** XP above the threshold of the current level: the gamble stake (R-GMB-01) and the most a loss may take (Q-31). */
export function xpAboveLevel(totalXp: number): number {
  return totalXp - xpThreshold(levelForXp(totalXp));
}

/** Applies a signed change; a total never goes below 0 or leaves the safe-integer range (R-XP-04). */
export function addXp(totalXp: number, delta: number): number {
  assertTotal(totalXp);
  const next = totalXp + delta;
  assertTotal(next);
  return next;
}
