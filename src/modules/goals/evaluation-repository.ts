import { and, asc, eq, exists, inArray, isNull, lte, or } from 'drizzle-orm';
import type { LocalDate } from '../../domain/dates.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { ascNullsFirst } from '../../platform/db/expressions.ts';
import { achievements, gambles, goalEvaluations, quests, users } from '../../platform/db/schema/index.ts';

/**
 * Bookkeeping of the daily goal evaluation in the worker (A-20, A-21, data-model §3.4): which users are due — their
 * last evaluation lies before their current local day — and which of their achievements time alone can change; and,
 * for the stats, which ones with a habit nothing changes by itself (R-STA-01).
 */

export interface DueUser {
  readonly userId: string;
  readonly timeZone: string;
}

/** A paused achievement or one of the archive: only a request changes it (R-ACH-06, A-40). */
export interface RestingAchievement {
  readonly id: string;
  readonly status: 'paused' | 'completed';
  readonly attempt: number;
  readonly completedAt: Date | null;
}

/** The achievement of the outer query has a habit quest. */
function hasHabitQuest(tx: Transaction) {
  return exists(
    tx
      .select({ id: quests.id })
      .from(quests)
      .where(and(eq(quests.achievementId, achievements.id), eq(quests.type, 'habit'))),
  );
}

/** An active achievement that time alone can change: a habit's period closes, or a gamble's target date passes. */
function changesWithTime(tx: Transaction) {
  const pendingGamble = tx
    .select({ id: gambles.id })
    .from(gambles)
    .where(and(eq(gambles.achievementId, achievements.id), eq(gambles.status, 'pending')));
  return and(eq(achievements.status, 'active'), or(hasHabitQuest(tx), exists(pendingGamble)));
}

/** Users with such an achievement whose next evaluation is due at `now`, never-evaluated and longest-waiting first. */
export function dueUsers(tx: Transaction, now: Date, limit: number): Promise<DueUser[]> {
  const changing = tx
    .select({ id: achievements.id })
    .from(achievements)
    .where(and(eq(achievements.userId, users.id), changesWithTime(tx)));
  return tx
    .select({ userId: users.id, timeZone: users.timezone })
    .from(users)
    .leftJoin(goalEvaluations, eq(goalEvaluations.userId, users.id))
    .where(and(or(isNull(goalEvaluations.dueAt), lte(goalEvaluations.dueAt, now)), exists(changing)))
    .orderBy(ascNullsFirst(goalEvaluations.dueAt), asc(users.id))
    .limit(limit);
}

/** The user's achievements that time alone can change, oldest first. */
export async function changingAchievements(tx: Transaction, userId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: achievements.id })
    .from(achievements)
    .where(and(eq(achievements.userId, userId), changesWithTime(tx)))
    .orderBy(asc(achievements.createdAt), asc(achievements.id));
  return rows.map((row) => row.id);
}

/** The user's paused and completed achievements with a habit quest, oldest first. */
export async function restingHabitAchievements(tx: Transaction, userId: string): Promise<RestingAchievement[]> {
  const rows = await tx
    .select({
      id: achievements.id,
      status: achievements.status,
      attempt: achievements.attempt,
      completedAt: achievements.completedAt,
    })
    .from(achievements)
    .where(
      and(eq(achievements.userId, userId), inArray(achievements.status, ['paused', 'completed']), hasHabitQuest(tx)),
    )
    .orderBy(asc(achievements.createdAt), asc(achievements.id));
  return rows.map((row) => ({ ...row, status: row.status as RestingAchievement['status'] }));
}

/** The local day just evaluated, and the next local midnight, when the user is due again. */
export async function recordEvaluation(
  tx: Transaction,
  userId: string,
  evaluatedOn: LocalDate,
  dueAt: Date,
): Promise<void> {
  await tx
    .insert(goalEvaluations)
    .values({ userId, evaluatedOn, dueAt })
    .onConflictDoUpdate({ target: goalEvaluations.userId, set: { evaluatedOn, dueAt } });
}
