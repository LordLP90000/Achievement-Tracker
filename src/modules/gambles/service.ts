import { placeGamble, type PlacementRefusal } from '../../domain/gamble.ts';
import { pageOf, type Page, type PagePosition } from '../../platform/http/pagination.ts';
import {
  runIdempotent,
  type IdempotentOutcome,
  type IdempotentRequest,
  type StoredResponse,
} from '../../platform/idempotency/idempotent.ts';
import { syncAchievement, withGoals, type GoalDependencies } from '../goals/engine.ts';
import type { Principal } from '../sessions/guard.ts';
import {
  gambleFacts,
  hasPendingGamble,
  insertGamble,
  listGambles,
  pendingGambleAchievement,
  type GambleRecord,
} from './repository.ts';

/** Gamble endpoints' service (R-GMB-01…05): place one on an achievement and list them. */

export type PlaceGambleRefusal = 'not_found' | PlacementRefusal;

export type PlaceGambleResult =
  IdempotentOutcome | { readonly outcome: 'refused'; readonly refusal: PlaceGambleRefusal };

export interface GamblesService {
  /** `render` turns the new gamble into the response that a retry with the same key replays (ADR-0008). */
  place(
    principal: Principal,
    achievementId: string,
    request: IdempotentRequest,
    render: (placed: GambleRecord) => StoredResponse,
  ): Promise<PlaceGambleResult>;
  /** The achievement's gambles, newest first; undefined unless it is the user's achievement. */
  list(
    principal: Principal,
    achievementId: string,
    page: { readonly after: PagePosition | null; readonly limit: number },
  ): Promise<Page<GambleRecord> | undefined>;
}

/** Rolls back a refused placement: nothing of it may remain, not even its idempotency record (Q-39). */
class PlaceRefused extends Error {
  override readonly name = 'PlaceRefused';
  readonly refusal: PlaceGambleRefusal;

  constructor(refusal: PlaceGambleRefusal) {
    super(refusal);
    this.refusal = refusal;
  }
}

export function createGamblesService(deps: GoalDependencies): GamblesService {
  return {
    async place(principal, achievementId, request, render) {
      const userId = principal.userId;
      try {
        return await withGoals(deps, userId, (scope) =>
          runIdempotent(scope.tx, scope.dataKey.key, userId, request, scope.now, async () => {
            // As of now: a gamble whose target date has passed is lost before another can be placed (A-20, A-21).
            const synced = await syncAchievement(scope, achievementId);
            if (synced === undefined) throw new PlaceRefused('not_found');
            // The pending gamble elsewhere, if its target date has passed, is lost first and does not block this one.
            const elsewhere = await pendingGambleAchievement(scope.tx, userId);
            const latest =
              elsewhere === null || elsewhere === achievementId
                ? synced
                : ((await syncAchievement(scope, elsewhere)) ?? synced);
            const achievement = synced.view.record;
            const facts = await gambleFacts(scope.tx, userId, achievement.id, achievement.attempt);
            // Under the user's goal lock, so simultaneous placements cannot both see no pending gamble (Q-31).
            const placement = placeGamble({
              achievementStatus: achievement.status,
              targetDate: achievement.targetDate,
              today: scope.today,
              userHasPendingGamble: await hasPendingGamble(scope.tx, userId),
              lostThisAttempt: facts.lostThisAttempt,
              totalXp: latest.totalXp,
            });
            if (placement.outcome === 'refused') throw new PlaceRefused(placement.reason);
            const gamble = { achievementId: achievement.id, attempt: achievement.attempt, stake: placement.stake };
            return render(await insertGamble(scope.tx, userId, gamble, scope.now));
          }),
        );
      } catch (error) {
        if (error instanceof PlaceRefused) return { outcome: 'refused', refusal: error.refusal };
        throw error;
      }
    },

    list(principal, achievementId, page) {
      return withGoals(deps, principal.userId, async (scope) => {
        // As of now, so a gamble lost since the last request shows as lost (A-21).
        if ((await syncAchievement(scope, achievementId)) === undefined) return undefined;
        const rows = await listGambles(scope.tx, scope.userId, achievementId, {
          after: page.after,
          limit: page.limit + 1,
        });
        return pageOf(rows, page.limit, (gamble) => ({ createdAt: gamble.placedAt, id: gamble.id }));
      });
    },
  };
}
