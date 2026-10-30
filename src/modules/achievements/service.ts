import type { LocalDate } from '../../domain/dates.ts';
import { deadlineAfterTargetChange } from '../../domain/rank.ts';
import { statusChange, type RequestedStatus } from '../../domain/transitions.ts';
import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { inTransaction, type Database, type Transaction } from '../../platform/db/database.ts';
import { pageOf, type Page, type PagePosition } from '../../platform/http/pagination.ts';
import {
  runIdempotent,
  type IdempotentOutcome,
  type IdempotentRequest,
  type StoredResponse,
} from '../../platform/idempotency/idempotent.ts';
import type { Clock } from '../../platform/time/clock.ts';
import { withUserDataKey, type UserDataKey } from '../accounts/data-key.ts';
import { hasActiveConsent } from '../consents/repository.ts';
import { gambleFacts } from '../gambles/repository.ts';
import {
  deleteAchievement,
  pauseAchievement,
  resumeAchievement,
  syncAchievement,
  withGoals,
  type AchievementView,
  type GoalScope,
} from '../goals/engine.ts';
import type { Principal } from '../sessions/guard.ts';
import {
  achievementsRepository,
  type AchievementContent,
  type AchievementRecord,
  type AchievementsRepository,
  type AchievementStatus,
} from './repository.ts';

/** R-IN-01 (Q-16): active and paused achievements per user; completed ones, the archive, do not count (Q-40). */
export const ACHIEVEMENT_LIMIT = 200;

export interface AchievementsServiceDependencies {
  readonly db: Database;
  readonly clock: Clock;
  readonly dataKeys: DataKeys;
}

export interface AchievementListRequest {
  readonly status: AchievementStatus | undefined;
  readonly after: PagePosition | null;
  readonly limit: number;
}

export type CreateAchievementResult =
  IdempotentOutcome | { readonly outcome: 'consent_required' } | { readonly outcome: 'limit_reached' };

/** An edit as the client sends it (contract `AchievementUpdate`): only what it names changes; null clears. */
export interface AchievementEdit {
  readonly title?: string;
  readonly description?: string | null;
  readonly motivation?: string | null;
  readonly category?: string | null;
  readonly targetDate?: LocalDate | null;
  readonly isPrivate?: boolean;
  /** Pause or resume (R-ACH-07). */
  readonly status?: RequestedStatus;
}

/** Why an edit or a deletion cannot touch the achievement. */
export type AchievementChangeRefusal =
  | { readonly outcome: 'not_found' | 'achievement_completed' | 'gamble_pending' }
  | { readonly outcome: 'version_conflict'; readonly currentVersion: number };

export type UpdateAchievementResult =
  { readonly outcome: 'updated'; readonly view: AchievementView } | AchievementChangeRefusal;

export type DeleteAchievementResult = { readonly outcome: 'deleted' } | AchievementChangeRefusal;

export interface AchievementsService {
  /** Each achievement evaluated now by the goal engine (A-21). */
  list(principal: Principal, request: AchievementListRequest): Promise<Page<AchievementView>>;
  /** `render` turns the new achievement into the response that a retry with the same key replays (ADR-0008). */
  create(
    principal: Principal,
    content: AchievementContent,
    request: IdempotentRequest,
    render: (created: AchievementRecord) => StoredResponse,
  ): Promise<CreateAchievementResult>;
  get(principal: Principal, achievementId: string): Promise<AchievementView | undefined>;
  /** Applies the edit if `expectedVersion` is current (ADR-0008): content, target date, pause or resume. */
  update(
    principal: Principal,
    achievementId: string,
    expectedVersion: number,
    edit: AchievementEdit,
  ): Promise<UpdateAchievementResult>;
  /** Deletes an active or paused achievement if `expectedVersion` is current (R-ACH-09). */
  delete(principal: Principal, achievementId: string, expectedVersion: number): Promise<DeleteAchievementResult>;
}

/** Rolls back a refused create: nothing of it may remain, not even its idempotency record (Q-39). */
class CreateRefused extends Error {
  override readonly name = 'CreateRefused';
  readonly outcome: 'consent_required' | 'limit_reached';

  constructor(outcome: 'consent_required' | 'limit_reached') {
    super(outcome);
    this.outcome = outcome;
  }
}

export function createAchievementsService(deps: AchievementsServiceDependencies): AchievementsService {
  /** A transaction bound to the user (RLS), with their data key and a repository that can only see their rows. */
  const withAchievements = <T>(
    userId: string,
    work: (repository: AchievementsRepository, tx: Transaction, dataKey: UserDataKey) => Promise<T>,
  ): Promise<T> =>
    inTransaction(deps.db, (tx) =>
      withUserDataKey(tx, deps.dataKeys, userId, (dataKey) =>
        work(achievementsRepository(tx, userId, dataKey), tx, dataKey),
      ),
    );

  return {
    list(principal, request) {
      return withGoals(deps, principal.userId, async (scope) => {
        const repository = achievementsRepository(scope.tx, scope.userId, scope.dataKey);
        const page = pageOf(
          await repository.list({ ...request, limit: request.limit + 1 }),
          request.limit,
          (achievement) => achievement,
        );
        const views: AchievementView[] = [];
        for (const achievement of page.items) {
          const synced = await syncAchievement(scope, achievement.id);
          if (synced !== undefined) views.push(synced.view);
        }
        return { items: views, nextCursor: page.nextCursor };
      });
    },

    async create(principal, content, request, render) {
      const now = deps.clock.now();
      try {
        return await withAchievements(principal.userId, (repository, tx, dataKey) =>
          runIdempotent(tx, dataKey.key, principal.userId, request, now, async () => {
            if (!(await hasActiveConsent(tx, principal.userId, 'goal_content'))) {
              throw new CreateRefused('consent_required');
            }
            await repository.lockCreation();
            if ((await repository.countOpen()) >= ACHIEVEMENT_LIMIT) throw new CreateRefused('limit_reached');
            const deadline = deadlineAfterTargetChange(null, content.targetDate);
            return render(await repository.insert(content, deadline, now));
          }),
        );
      } catch (error) {
        if (error instanceof CreateRefused) return { outcome: error.outcome };
        throw error;
      }
    },

    get(principal, achievementId) {
      return withGoals(deps, principal.userId, async (scope) => (await syncAchievement(scope, achievementId))?.view);
    },

    update(principal, achievementId, expectedVersion, edit) {
      return withGoals(deps, principal.userId, async (scope): Promise<UpdateAchievementResult> => {
        const found = await changeable(scope, achievementId, expectedVersion);
        if ('outcome' in found) return found;
        const current = found.record;
        const targetDate = edit.targetDate === undefined ? current.targetDate : edit.targetDate;
        const targetChanged = targetDate !== current.targetDate;
        const pending = (await gambleFacts(scope.tx, scope.userId, current.id, current.attempt)).pending;
        // A-26: otherwise a loss could be avoided by moving the date (T-17).
        if (targetChanged && pending !== null) return { outcome: 'gamble_pending' };
        const content: AchievementContent = {
          title: edit.title ?? current.title,
          description: edit.description === undefined ? current.description : edit.description,
          motivation: edit.motivation === undefined ? current.motivation : edit.motivation,
          category: edit.category === undefined ? current.category : edit.category,
          targetDate,
          isPrivate: edit.isPrivate ?? current.isPrivate,
        };
        // A-35: an earlier date moves the attempt's deadline; a later one, or none, does not.
        const deadline = targetChanged ? deadlineAfterTargetChange(current.deadline, targetDate) : current.deadline;
        const repository = achievementsRepository(scope.tx, scope.userId, scope.dataKey);
        const edited = { ...found, record: await repository.update(current, content, deadline, scope.now) };
        const change = edit.status === undefined ? 'unchanged' : statusChange(current.status, edit.status);
        if (change === 'pause') await pauseAchievement(scope, edited);
        if (change === 'resume') await resumeAchievement(scope, edited);
        const after = await syncAchievement(scope, achievementId);
        if (after === undefined) throw new Error('the edited achievement is gone');
        return { outcome: 'updated', view: after.view };
      });
    },

    delete(principal, achievementId, expectedVersion) {
      return withGoals(deps, principal.userId, async (scope): Promise<DeleteAchievementResult> => {
        const found = await changeable(scope, achievementId, expectedVersion);
        if ('outcome' in found) return found;
        await deleteAchievement(scope, found);
        return { outcome: 'deleted' };
      });
    },
  };
}

/**
 * The achievement as of now (A-21), if the request may change it. The archive answers 409 whatever the version: a
 * precondition only matters for a request that could succeed (RFC 9110 §13.2.1).
 */
async function changeable(
  scope: GoalScope,
  achievementId: string,
  expectedVersion: number,
): Promise<AchievementView | AchievementChangeRefusal> {
  const view = (await syncAchievement(scope, achievementId))?.view;
  if (view === undefined) return { outcome: 'not_found' };
  if (view.record.status === 'completed') return { outcome: 'achievement_completed' };
  if (view.record.version !== expectedVersion) {
    return { outcome: 'version_conflict', currentVersion: view.record.version };
  }
  return view;
}
