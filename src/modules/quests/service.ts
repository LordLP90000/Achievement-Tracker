import { formatDecimal, parseDecimal } from '../../domain/decimal.ts';
import {
  runIdempotent,
  type IdempotentOutcome,
  type IdempotentRequest,
  type StoredResponse,
} from '../../platform/idempotency/idempotent.ts';
import { achievementsRepository } from '../achievements/repository.ts';
import { hasActiveConsent } from '../consents/repository.ts';
import {
  deleteQuest,
  effectsOf,
  lockedQuestsOf,
  questView,
  syncAchievement,
  withGoals,
  type GoalDependencies,
  type GoalEffects,
  type GoalScope,
  type GoalSync,
  type QuestView,
} from '../goals/engine.ts';
import type { Principal } from '../sessions/guard.ts';
import { questsRepository, type HabitSettings, type TargetSettings } from './repository.ts';
import { applyEdit, createViolation, type QuestEdit, type QuestInput, type RuleViolation } from './rules.ts';

/** R-IN-01 (Q-16): quests per achievement. */
export const QUEST_LIMIT = 50;

export type CreateQuestRefusal =
  { readonly outcome: 'consent_required' | 'not_found' | 'achievement_completed' | 'limit_reached' } | RuleViolation;

export type CreateQuestResult =
  IdempotentOutcome | { readonly outcome: 'refused'; readonly refusal: CreateQuestRefusal };

/** Why an edit or a deletion cannot touch the quest at all. */
export type QuestChangeRefusal =
  | { readonly outcome: 'not_found' | 'achievement_completed' }
  | { readonly outcome: 'version_conflict'; readonly currentVersion: number };

export type UpdateQuestResult =
  | { readonly outcome: 'updated'; readonly quest: QuestView; readonly effects: GoalEffects }
  | QuestChangeRefusal
  | RuleViolation;

export type DeleteQuestResult = { readonly outcome: 'deleted'; readonly effects: GoalEffects } | QuestChangeRefusal;

export interface QuestsService {
  /** `render` turns the new quest into the response that a retry with the same key replays (ADR-0008). */
  create(
    principal: Principal,
    achievementId: string,
    input: QuestInput,
    request: IdempotentRequest,
    render: (created: QuestView) => StoredResponse,
  ): Promise<CreateQuestResult>;
  /** The quests of the user's achievement in order; undefined unless it is the user's. */
  list(principal: Principal, achievementId: string): Promise<readonly QuestView[] | undefined>;
  get(principal: Principal, questId: string): Promise<QuestView | undefined>;
  /** Applies the edit if `expectedVersion` is current (R-QST-07, ADR-0008); progress and XP follow. */
  update(principal: Principal, questId: string, expectedVersion: number, edit: QuestEdit): Promise<UpdateQuestResult>;
  /** Deletes the quest if `expectedVersion` is current (R-QST-08, Q-12). */
  delete(principal: Principal, questId: string, expectedVersion: number): Promise<DeleteQuestResult>;
}

/** Rolls back a refused create: nothing of it may remain, not even its idempotency record (Q-39). */
class CreateRefused extends Error {
  override readonly name = 'CreateRefused';
  readonly refusal: CreateQuestRefusal;

  constructor(refusal: CreateQuestRefusal) {
    super(refusal.outcome);
    this.refusal = refusal;
  }
}

/**
 * The quest and its achievement as of now (A-21), if the request may change it. A completed achievement answers 409
 * whatever the version: a precondition only matters for a request that could succeed (RFC 9110 §13.2.1).
 */
async function changeable(
  scope: GoalScope,
  questId: string,
  expectedVersion: number,
): Promise<{ readonly before: GoalSync; readonly quest: QuestView } | QuestChangeRefusal> {
  const record = await questsRepository(scope.tx, scope.userId, scope.dataKey).find(questId);
  const before = record === undefined ? undefined : await syncAchievement(scope, record.achievementId);
  const quest = questView(before, questId);
  if (before === undefined || quest === undefined) return { outcome: 'not_found' };
  if (before.view.record.status === 'completed') return { outcome: 'achievement_completed' };
  if (quest.record.version !== expectedVersion) {
    return { outcome: 'version_conflict', currentVersion: quest.record.version };
  }
  return { before, quest };
}

export function createQuestsService(deps: GoalDependencies): QuestsService {
  /** The quest's view after the engine looked at its achievement now (A-21). */
  const viewOf = async (scope: GoalScope, achievementId: string, questId: string): Promise<QuestView | undefined> =>
    questView(await syncAchievement(scope, achievementId), questId);

  return {
    async create(principal, achievementId, input, request, render) {
      const userId = principal.userId;
      try {
        return await withGoals(deps, userId, (scope) =>
          runIdempotent(scope.tx, scope.dataKey.key, userId, request, scope.now, async () => {
            if (!(await hasActiveConsent(scope.tx, userId, 'goal_content'))) {
              throw new CreateRefused({ outcome: 'consent_required' });
            }
            const achievement = await achievementsRepository(scope.tx, userId, scope.dataKey).find(achievementId);
            if (achievement === undefined) throw new CreateRefused({ outcome: 'not_found' });
            if (achievement.status === 'completed') throw new CreateRefused({ outcome: 'achievement_completed' });
            const quests = questsRepository(scope.tx, userId, scope.dataKey);
            const existing = await quests.listByAchievement(achievementId);
            if (existing.length >= QUEST_LIMIT) throw new CreateRefused({ outcome: 'limit_reached' });
            const broken = createViolation(input, scope.today, existing);
            if (broken !== null) throw new CreateRefused(broken);
            const habit: HabitSettings | null =
              input.habit === null
                ? null
                : {
                    period: input.habit.period,
                    timesPerPeriod: input.habit.timesPerPeriod,
                    periodCount: input.habit.periodCount,
                    startDate: input.habit.startDate ?? scope.today,
                    // A run keeps the week start in effect when it starts (Q-34).
                    weekStart: scope.weekStart,
                  };
            const target: TargetSettings | null =
              input.target === null
                ? null
                : {
                    start: formatDecimal(parseDecimal(input.target.start)),
                    target: formatDecimal(parseDecimal(input.target.target)),
                    unit: input.target.unit,
                  };
            const last = existing.reduce((highest, quest) => Math.max(highest, quest.position + 1), 0);
            const created = await quests.insert(
              {
                achievementId,
                position: input.position ?? last,
                type: input.type,
                size: input.size,
                isRequired: input.isRequired,
                prerequisiteQuestId: input.prerequisiteQuestId,
                title: input.title,
                notes: input.notes,
                habit,
                target,
              },
              scope.now,
            );
            const view = await viewOf(scope, achievementId, created.id);
            if (view === undefined) throw new Error('the new quest is gone');
            return render(view);
          }),
        );
      } catch (error) {
        if (error instanceof CreateRefused) return { outcome: 'refused', refusal: error.refusal };
        throw error;
      }
    },

    list(principal, achievementId) {
      return withGoals(
        deps,
        principal.userId,
        async (scope) => (await syncAchievement(scope, achievementId))?.view.quests,
      );
    },

    get(principal, questId) {
      return withGoals(deps, principal.userId, async (scope) => {
        const quest = await questsRepository(scope.tx, scope.userId, scope.dataKey).find(questId);
        return quest === undefined ? undefined : viewOf(scope, quest.achievementId, quest.id);
      });
    },

    update(principal, questId, expectedVersion, edit) {
      return withGoals(deps, principal.userId, async (scope): Promise<UpdateQuestResult> => {
        const found = await changeable(scope, questId, expectedVersion);
        if ('outcome' in found) return found;
        const { before, quest } = found;
        const edited = applyEdit(edit, {
          quest: quest.record,
          evaluation: quest.evaluation,
          paused: before.view.record.status === 'paused',
          quests: before.view.quests.map((sibling) => sibling.record),
          today: scope.today,
          weekStart: scope.weekStart,
        });
        if (edited.outcome === 'invalid') return edited;
        await questsRepository(scope.tx, scope.userId, scope.dataKey).update(quest.record, edited.quest, scope.now);
        const after = await syncAchievement(scope, quest.record.achievementId, {
          lockedBefore: lockedQuestsOf(before.view),
        });
        const updated = questView(after, questId);
        if (after === undefined || updated === undefined) throw new Error('the edited quest is gone');
        return { outcome: 'updated', quest: updated, effects: effectsOf(before, after) };
      });
    },

    delete(principal, questId, expectedVersion) {
      return withGoals(deps, principal.userId, async (scope): Promise<DeleteQuestResult> => {
        const found = await changeable(scope, questId, expectedVersion);
        if ('outcome' in found) return found;
        const after = await deleteQuest(scope, found.quest.record, { lockedBefore: lockedQuestsOf(found.before.view) });
        return { outcome: 'deleted', effects: effectsOf(found.before, after) };
      });
    },
  };
}
