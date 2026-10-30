import { deadlineAfterTargetChange } from '../../domain/rank.ts';
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
import { syncAchievement, withGoals, type AchievementView } from '../goals/engine.ts';
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
  };
}
