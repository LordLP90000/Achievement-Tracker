import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sum } from 'drizzle-orm';
import type { Rank } from '../../domain/constants.ts';
import type { LocalDate } from '../../domain/dates.ts';
import type { XpEventDraft } from '../../domain/effects.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { badges, xpEvents } from '../../platform/db/schema/index.ts';

/**
 * The XP ledger and rank badges of one user (data-model §3.4). The ledger is append-only for the API (R-XP-01): the
 * effects engine reads what it credits and appends only differences.
 */

/** Kinds that make up what a quest credits in the current attempt: a pause brings it back to 0 (R-ACH-06). */
const QUEST_CREDIT_KINDS = ['quest_completed', 'quest_uncompleted', 'pause_revoked'];
const RANK_BONUS_KINDS = ['rank_bonus', 'rank_bonus_revoked'];
const GAMBLE_WIN_KINDS = ['gamble_won', 'gamble_reverted'];

export interface LedgerFacts {
  /** The user's XP total (R-XP-04). */
  readonly totalXp: number;
  /** What each quest credits in the current attempt. */
  readonly questCredits: ReadonlyMap<string, number>;
  /** The achievement's rank bonus as credited now. */
  readonly rankBonusCredited: number;
}

const amount = (total: string | null): number => Number(total ?? 0);

/** The user's XP total (R-XP-04): the sum of the ledger, never below 0 (A-38). */
export async function totalXp(tx: Transaction, userId: string): Promise<number> {
  const [total] = await tx
    .select({ xp: sum(xpEvents.amount) })
    .from(xpEvents)
    .where(eq(xpEvents.userId, userId));
  return amount(total?.xp ?? null);
}

export async function ledgerFacts(
  tx: Transaction,
  userId: string,
  achievementId: string,
  questIds: readonly string[],
): Promise<LedgerFacts> {
  const mine = eq(xpEvents.userId, userId);
  const credits =
    questIds.length === 0
      ? []
      : await tx
          .select({ questId: xpEvents.questId, xp: sum(xpEvents.amount) })
          .from(xpEvents)
          .where(and(mine, inArray(xpEvents.questId, [...questIds]), inArray(xpEvents.kind, QUEST_CREDIT_KINDS)))
          .groupBy(xpEvents.questId);
  const [bonus] = await tx
    .select({ xp: sum(xpEvents.amount) })
    .from(xpEvents)
    .where(and(mine, eq(xpEvents.achievementId, achievementId), inArray(xpEvents.kind, RANK_BONUS_KINDS)));
  return {
    totalXp: await totalXp(tx, userId),
    questCredits: new Map(credits.map((credit) => [credit.questId ?? '', amount(credit.xp)])),
    rankBonusCredited: amount(bonus?.xp ?? null),
  };
}

/** What the gamble's current win paid: its wins net of reverted wins (R-ACH-05). */
export async function gambleWinPaid(tx: Transaction, userId: string, gambleId: string): Promise<number> {
  const [paid] = await tx
    .select({ xp: sum(xpEvents.amount) })
    .from(xpEvents)
    .where(and(eq(xpEvents.userId, userId), eq(xpEvents.gambleId, gambleId), inArray(xpEvents.kind, GAMBLE_WIN_KINDS)));
  return amount(paid?.xp ?? null);
}

/** Appends the engine's events, dated in the user's time zone for "XP over time" (A-13). */
export async function appendXpEvents(
  tx: Transaction,
  userId: string,
  achievementId: string,
  events: readonly XpEventDraft[],
  localDate: LocalDate,
  now: Date,
): Promise<void> {
  if (events.length === 0) return;
  await tx.insert(xpEvents).values(
    events.map((event) => ({
      id: randomUUID(),
      userId,
      kind: event.kind,
      amount: event.amount,
      questId: event.questId,
      achievementId,
      gambleId: event.gambleId,
      localDate,
      createdAt: now,
    })),
  );
}

/** The achievement's rank badge, awarded on unlock (R-RANK-03, A-06). */
export async function awardRankBadge(
  tx: Transaction,
  userId: string,
  achievementId: string,
  rank: Rank,
  now: Date,
): Promise<void> {
  await tx
    .insert(badges)
    .values({ id: randomUUID(), userId, achievementId, kind: 'achievement_rank', rank, awardedAt: now });
}

/** Removed with a re-lock (R-ACH-05, R-RANK-04). */
export async function removeRankBadge(tx: Transaction, userId: string, achievementId: string): Promise<void> {
  await tx.delete(badges).where(and(eq(badges.userId, userId), eq(badges.achievementId, achievementId)));
}
