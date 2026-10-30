import { formatDecimal } from '../../domain/decimal.ts';
import { levelForXp } from '../../domain/xp.ts';
import type { AchievementRecord } from '../achievements/repository.ts';
import type { CheckInRecord } from '../check-ins/repository.ts';
import type { GambleRecord } from '../gambles/repository.ts';
import type { AchievementView, GoalEffects, QuestView } from './engine.ts';

/** Goal views as the contract represents them (`Achievement`, `Quest`, `Effects`, `CheckIn`, `Gamble`). */

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

/**
 * `Effects`: what a change did (R-CHK-06) — the quest (null once deleted), its achievement afterwards, the XP it moved
 * and the total, and an unlock, re-lock or gamble settlement among its outcomes.
 */
export function effectsJson(quest: QuestView | null, effects: GoalEffects) {
  const { outcomes, totalXp } = effects;
  const unlock = outcomes.findLast((outcome) => outcome.unlock !== null)?.unlock ?? null;
  const gamble = outcomes.findLast((outcome) => outcome.gamble !== null)?.gamble ?? null;
  return {
    quest: quest === null ? null : questJson(quest),
    achievement: achievementViewJson(effects.view),
    xp_delta: outcomes.flatMap((outcome) => outcome.events).reduce((sum, event) => sum + event.amount, 0),
    xp_total: totalXp,
    level: levelForXp(totalXp),
    achievement_unlocked: unlock !== null,
    achievement_relocked: outcomes.some((outcome) => outcome.relocked),
    rank: unlock?.rank ?? null,
    execution_score: unlock?.score ?? null,
    gamble:
      gamble === null
        ? null
        : { gamble_id: gamble.id, outcome: gamble.outcome, xp_delta: gamble.xpDelta, loss_reason: gamble.lossReason },
  };
}

/** `CheckIn` (R-CHK-01, R-CHK-04): the value as stored, a canonical decimal. */
export function checkInJson(checkIn: CheckInRecord) {
  return {
    id: checkIn.id,
    quest_id: checkIn.questId,
    local_date: checkIn.localDate,
    attempt: checkIn.attempt,
    counts_for_progress: checkIn.countsForProgress,
    value: checkIn.value,
    note: checkIn.note,
    created_at: checkIn.createdAt.toISOString(),
  };
}

/** `CheckInResult`: the new check-in and what it did, so the app needs no second round trip (R-CHK-06). */
export const checkInResultJson = (checkIn: CheckInRecord, quest: QuestView, effects: GoalEffects) => ({
  ...effectsJson(quest, effects),
  check_in: checkInJson(checkIn),
});

/** `Gamble` (R-GMB-01…04): the stake as recorded at placement. */
export function gambleJson(gamble: GambleRecord) {
  return {
    id: gamble.id,
    attempt: gamble.attempt,
    stake: gamble.stake,
    status: gamble.status,
    loss_reason: gamble.lossReason,
    placed_at: gamble.placedAt.toISOString(),
    settled_at: gamble.settledAt?.toISOString() ?? null,
  };
}
