import { formatDecimal } from '../../domain/decimal.ts';
import type { AchievementRecord } from '../achievements/repository.ts';
import type { AchievementView, QuestView } from './engine.ts';

/** Goal views as the contract represents them (`Achievement`, `AchievementDetail`, `Quest`). */

export interface AchievementFigures {
  readonly progress: number;
  readonly xpRequiredTotal: number;
  readonly xpEarned: number;
}

/** A new achievement has no quests, so no progress, no required XP and nothing earned. */
export const NEW_ACHIEVEMENT: AchievementFigures = { progress: 0, xpRequiredTotal: 0, xpEarned: 0 };

/** `Achievement`; the deadline (A-35) is never sent. */
export function achievementJson(achievement: AchievementRecord, figures: AchievementFigures) {
  return {
    id: achievement.id,
    title: achievement.title,
    description: achievement.description,
    motivation: achievement.motivation,
    category: achievement.category,
    target_date: achievement.targetDate,
    status: achievement.status,
    is_private: achievement.isPrivate,
    attempt: achievement.attempt,
    progress: figures.progress,
    xp_required_total: figures.xpRequiredTotal,
    xp_earned: figures.xpEarned,
    rank: achievement.rank,
    execution_score: achievement.executionScore,
    completed_at: achievement.completedAt?.toISOString() ?? null,
    created_at: achievement.createdAt.toISOString(),
    updated_at: achievement.updatedAt.toISOString(),
    version: achievement.version,
  };
}

export const achievementViewJson = (view: AchievementView) => achievementJson(view.record, view);

/** `AchievementDetail`: the achievement with its quests in order. */
export const achievementDetailJson = (view: AchievementView) => ({
  ...achievementViewJson(view),
  quests: view.quests.map(questJson),
});

/** `Quest`: stored settings and the engine's evaluation (R-QST-01…05, R-STR-01, Q-35). */
export function questJson({ record, evaluation }: QuestView) {
  const { habit, target } = record;
  return {
    id: record.id,
    achievement_id: record.achievementId,
    title: record.title,
    notes: record.notes,
    type: record.type,
    size: record.size,
    xp: evaluation.xp,
    duration_factor: evaluation.durationFactor,
    is_required: record.isRequired,
    position: record.position,
    prerequisite_quest_id: record.prerequisiteQuestId,
    state: evaluation.state,
    progress: evaluation.progress,
    reset_count: record.resetCount,
    habit:
      habit === null
        ? null
        : {
            period: habit.period,
            times_per_period: habit.timesPerPeriod,
            period_count: habit.periodCount,
            start_date: habit.startDate,
          },
    target:
      target === null
        ? null
        : {
            start_value: target.start,
            target_value: target.target,
            ...(target.unit === null ? {} : { unit: target.unit }),
          },
    current_value: evaluation.currentValue === null ? null : formatDecimal(evaluation.currentValue),
    streak: habit === null || evaluation.streak === null ? null : { ...evaluation.streak, period: habit.period },
    current_period:
      evaluation.currentPeriod === null
        ? null
        : {
            start: evaluation.currentPeriod.start,
            end: evaluation.currentPeriod.end,
            check_ins: evaluation.currentPeriod.checkIns,
            required_check_ins: evaluation.currentPeriod.required,
          },
    completed_at: record.completedAt?.toISOString() ?? null,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
    version: record.version,
  };
}
