import { checkInDating } from '../../domain/check-in-dating.ts';
import { formatDecimal, parseDecimal } from '../../domain/decimal.ts';
import { pageOf, type Page, type PagePosition } from '../../platform/http/pagination.ts';
import {
  runIdempotent,
  type IdempotentOutcome,
  type IdempotentRequest,
  type StoredResponse,
} from '../../platform/idempotency/idempotent.ts';
import { localDateOf } from '../../platform/time/time-zones.ts';
import { hasActiveConsent } from '../consents/repository.ts';
import {
  effectsOf,
  lockedQuestsOf,
  PendingGambleConflict,
  questView,
  syncAchievement,
  withGoals,
  type GoalDependencies,
  type GoalEffects,
  type QuestView,
} from '../goals/engine.ts';
import { questsRepository } from '../quests/repository.ts';
import type { Principal } from '../sessions/guard.ts';
import { checkInsRepository, type CheckInRecord } from './repository.ts';
import { checkInRefusal, type CheckInInput, type CheckInRefusal } from './rules.ts';

/** R-IN-01 (Q-16): check-ins per quest and day — the day they are dated (A-42). */
export const CHECK_INS_PER_DAY = 50;

export type CreateCheckInRefusal =
  { readonly outcome: 'consent_required' | 'not_found' | 'limit_reached' } | CheckInRefusal;

export type CreateCheckInResult =
  IdempotentOutcome | { readonly outcome: 'refused'; readonly refusal: CreateCheckInRefusal };

/** What a new check-in did (contract `CheckInResult`, R-CHK-06). */
export interface CheckInCreated {
  readonly checkIn: CheckInRecord;
  readonly quest: QuestView;
  readonly effects: GoalEffects;
}

export type UndoCheckInResult =
  | { readonly outcome: 'undone'; readonly quest: QuestView; readonly effects: GoalEffects }
  | { readonly outcome: 'not_found' | 'check_in_final' | 'gamble_pending' };

export interface CheckInsService {
  /** `render` turns the result into the response that a retry with the same key replays (ADR-0008). */
  create(
    principal: Principal,
    questId: string,
    input: CheckInInput,
    request: IdempotentRequest,
    render: (created: CheckInCreated) => StoredResponse,
  ): Promise<CreateCheckInResult>;
  /** The quest's check-ins, newest first, history included; undefined unless it is the user's quest. */
  list(
    principal: Principal,
    questId: string,
    page: { readonly after: PagePosition | null; readonly limit: number },
  ): Promise<Page<CheckInRecord> | undefined>;
  /** Deletes the check-in and reverses all its effects (R-CHK-03), on the day it was made only (Q-36). */
  undo(principal: Principal, checkInId: string): Promise<UndoCheckInResult>;
}

/** Rolls back a refused create: nothing of it may remain, not even its idempotency record (Q-39). */
class CreateRefused extends Error {
  override readonly name = 'CreateRefused';
  readonly refusal: CreateCheckInRefusal;

  constructor(refusal: CreateCheckInRefusal) {
    super(refusal.outcome);
    this.refusal = refusal;
  }
}

export function createCheckInsService(deps: GoalDependencies): CheckInsService {
  return {
    async create(principal, questId, input, request, render) {
      const userId = principal.userId;
      try {
        return await withGoals(deps, userId, (scope) =>
          runIdempotent(scope.tx, scope.dataKey.key, userId, request, scope.now, async () => {
            if (!(await hasActiveConsent(scope.tx, userId, 'goal_content'))) {
              throw new CreateRefused({ outcome: 'consent_required' });
            }
            const record = await questsRepository(scope.tx, userId, scope.dataKey).find(questId);
            // As of now: a missed period resets the habit before the check-in could count for it (A-21).
            const before = record === undefined ? undefined : await syncAchievement(scope, record.achievementId);
            const quest = questView(before, questId);
            if (before === undefined || quest === undefined) throw new CreateRefused({ outcome: 'not_found' });
            const achievement = before.view.record;
            const refusal = checkInRefusal(input, quest, achievement.status, scope.today);
            if (refusal !== null) throw new CreateRefused(refusal);
            const checkIns = checkInsRepository(scope.tx, userId, scope.dataKey);
            if ((await checkIns.countOnDate(questId, input.localDate)) >= CHECK_INS_PER_DAY) {
              throw new CreateRefused({ outcome: 'limit_reached' });
            }
            const checkIn = await checkIns.insert(
              {
                questId,
                localDate: input.localDate,
                attempt: achievement.attempt,
                countsForProgress: checkInDating(input.localDate, scope.today) === 'counts',
                value: input.value === null ? null : formatDecimal(parseDecimal(input.value)),
                note: input.note,
              },
              scope.now,
            );
            const after = await syncAchievement(scope, achievement.id, { lockedBefore: lockedQuestsOf(before.view) });
            const updated = questView(after, questId);
            if (after === undefined || updated === undefined) throw new Error('the checked-in quest is gone');
            return render({ checkIn, quest: updated, effects: effectsOf(before, after) });
          }),
        );
      } catch (error) {
        if (error instanceof CreateRefused) return { outcome: 'refused', refusal: error.refusal };
        throw error;
      }
    },

    list(principal, questId, page) {
      return withGoals(deps, principal.userId, async (scope) => {
        if ((await questsRepository(scope.tx, scope.userId, scope.dataKey).find(questId)) === undefined) {
          return undefined;
        }
        const checkIns = checkInsRepository(scope.tx, scope.userId, scope.dataKey);
        const rows = await checkIns.listByQuest(questId, { after: page.after, limit: page.limit + 1 });
        return pageOf(rows, page.limit, (checkIn) => checkIn);
      });
    },

    async undo(principal, checkInId) {
      try {
        return await withGoals(deps, principal.userId, async (scope): Promise<UndoCheckInResult> => {
          const checkIns = checkInsRepository(scope.tx, scope.userId, scope.dataKey);
          const checkIn = await checkIns.find(checkInId);
          if (checkIn === undefined) return { outcome: 'not_found' };
          // Q-36: closed periods and completed achievements never change afterwards.
          if (localDateOf(checkIn.createdAt, scope.timeZone) !== scope.today) return { outcome: 'check_in_final' };
          const record = await questsRepository(scope.tx, scope.userId, scope.dataKey).find(checkIn.questId);
          const before = record === undefined ? undefined : await syncAchievement(scope, record.achievementId);
          if (before === undefined) throw new Error('the quest of the check-in is gone');
          await checkIns.remove(checkIn.id);
          const after = await syncAchievement(scope, before.view.record.id, {
            lockedBefore: lockedQuestsOf(before.view),
          });
          const quest = questView(after, checkIn.questId);
          if (after === undefined || quest === undefined) throw new Error('the quest of the check-in is gone');
          return { outcome: 'undone', quest, effects: effectsOf(before, after) };
        });
      } catch (error) {
        if (error instanceof PendingGambleConflict) return { outcome: 'gamble_pending' };
        throw error;
      }
    },
  };
}
