import type { HabitEvaluation } from './habit-reset.ts';

/**
 * Streaks of habit quests (R-STR-01): the current streak is the met-period count of the open or completed run — the
 * open period never breaks it — and 0 once the run ended in a reset. The best streak also covers earlier runs, whose
 * met-period counts the service keeps as one number per quest (`habit_best_streak`), since a restart replaces the
 * run's start date.
 */

export interface Streak {
  readonly current: number;
  readonly best: number;
}

export function habitStreak(evaluation: HabitEvaluation, bestOfEndedRuns: number): Streak {
  const current = evaluation.state === 'reset' ? 0 : evaluation.metPeriods;
  return { current, best: Math.max(bestOfEndedRuns, evaluation.metPeriods) };
}

/** The best streak of the ended runs once another run ends, by a reset or by a pause (R-ACH-06). */
export function bestAfterRunEnds(bestOfEndedRuns: number, endedRun: HabitEvaluation): number {
  return Math.max(bestOfEndedRuns, endedRun.metPeriods);
}

export interface RankedStreak extends Streak {
  readonly questId: string;
}

/** The stats list: best streaks first, then the longer current one, then by quest ID for a stable order. */
export function topStreaks<T extends RankedStreak>(streaks: readonly T[], limit: number): T[] {
  return [...streaks]
    .sort((a, b) => b.best - a.best || b.current - a.current || a.questId.localeCompare(b.questId))
    .slice(0, limit);
}
