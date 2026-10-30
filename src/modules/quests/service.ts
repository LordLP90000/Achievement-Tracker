import { daysBetween, type LocalDate } from '../../domain/dates.ts';
import { formatDecimal, parseDecimal } from '../../domain/decimal.ts';
import type { HabitPeriod, QuestSize } from '../../domain/duration.ts';
import { checkPrerequisite } from '../../domain/transitions.ts';
import {
  runIdempotent,
  type IdempotentOutcome,
  type IdempotentRequest,
  type StoredResponse,
} from '../../platform/idempotency/idempotent.ts';
import { achievementsRepository } from '../achievements/repository.ts';
import { hasActiveConsent } from '../consents/repository.ts';
import { syncAchievement, withGoals, type GoalDependencies, type GoalScope, type QuestView } from '../goals/engine.ts';
import type { Principal } from '../sessions/guard.ts';
import {
  questsRepository,
  type HabitSettings,
  type QuestRecord,
  type QuestType,
  type TargetSettings,
} from './repository.ts';

/** R-IN-01 (Q-16): quests per achievement. */
export const QUEST_LIMIT = 50;

/** A new quest as the client describes it (contract `QuestCreate`), before the rules of the service. */
export interface QuestInput {
  readonly title: string;
  readonly notes: string | null;
  readonly type: QuestType;
  readonly size: QuestSize;
  readonly isRequired: boolean;
  /** Last when omitted. */
  readonly position: number | null;
  readonly prerequisiteQuestId: string | null;
  readonly habit: {
    readonly period: HabitPeriod;
    readonly timesPerPeriod: number;
    readonly periodCount: number;
    /** Today when omitted. */
    readonly startDate: LocalDate | null;
  } | null;
  readonly target: { readonly start: string; readonly target: string; readonly unit: string | null } | null;
}

/** A rule the request breaks (`422`), with a JSON pointer into the request and a static message. */
export interface RuleViolation {
  readonly outcome: 'invalid';
  readonly pointer: string;
  readonly message: string;
}

export type CreateQuestRefusal =
  { readonly outcome: 'consent_required' | 'not_found' | 'achievement_completed' | 'limit_reached' } | RuleViolation;

export type CreateQuestResult =
  IdempotentOutcome | { readonly outcome: 'refused'; readonly refusal: CreateQuestRefusal };

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

const violation = (pointer: string, message: string): RuleViolation => ({ outcome: 'invalid', pointer, message });

/** Stands for the quest being created in prerequisite checks; never a UUID, so never an existing quest. */
const NEW_QUEST = 'new-quest';

/** Thousandths of a decimal within ±10^9 (A-05), or null beyond it. */
function decimalOf(text: string): number | null {
  try {
    return parseDecimal(text);
  } catch {
    return null;
  }
}

/** The first rule a new quest breaks (A-05, A-16, A-28, R-QST-02…05), or null. */
function violationOf(input: QuestInput, today: LocalDate, existing: readonly QuestRecord[]): RuleViolation | null {
  if ((input.type === 'habit') !== (input.habit !== null)) {
    return violation('/habit', input.type === 'habit' ? 'is required for a habit quest' : 'is only for habit quests');
  }
  if ((input.type === 'target') !== (input.target !== null)) {
    return violation(
      '/target',
      input.type === 'target' ? 'is required for a target quest' : 'is only for target quests',
    );
  }
  const startDate = input.habit?.startDate ?? null;
  if (startDate !== null && daysBetween(today, startDate) < 0) {
    return violation('/habit/start_date', 'must be today or later: back-dated check-ins never count');
  }
  if (input.target !== null) {
    const start = decimalOf(input.target.start);
    if (start === null) return violation('/target/start_value', 'must lie within ±1000000000');
    const target = decimalOf(input.target.target);
    if (target === null) return violation('/target/target_value', 'must lie within ±1000000000');
    if (start === target) return violation('/target/target_value', 'must differ from start_value');
  }
  if (input.prerequisiteQuestId !== null) {
    const links = new Map(existing.map((quest) => [quest.id, quest.prerequisiteQuestId]));
    const refusal = checkPrerequisite(NEW_QUEST, input.prerequisiteQuestId, links);
    if (refusal === 'unknown') return violation('/prerequisite_quest_id', 'is not a quest of this achievement');
    if (refusal !== null) return violation('/prerequisite_quest_id', 'would make a chain of more than 20 quests');
  }
  return null;
}

export function createQuestsService(deps: GoalDependencies): QuestsService {
  /** The quest's view after the engine looked at its achievement now (A-21). */
  const viewOf = async (scope: GoalScope, achievementId: string, questId: string): Promise<QuestView | undefined> =>
    (await syncAchievement(scope, achievementId))?.view.quests.find((quest) => quest.record.id === questId);

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
            const broken = violationOf(input, scope.today, existing);
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
  };
}
