import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { GambleLossReason, GambleStatus } from '../../domain/gamble.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { afterPosition } from '../../platform/db/expressions.ts';
import { gambles } from '../../platform/db/schema/index.ts';

/** Gambles of one user (data-model §3.3, R-GMB-*): one pending at a time across all achievements (Q-31). */

export interface GambleRecord {
  readonly id: string;
  readonly achievementId: string;
  readonly attempt: number;
  readonly stake: number;
  readonly status: GambleStatus;
  readonly lossReason: GambleLossReason | null;
  readonly placedAt: Date;
  readonly settledAt: Date | null;
}

type Row = typeof gambles.$inferSelect;

const toRecord = (row: Row): GambleRecord => ({
  id: row.id,
  achievementId: row.achievementId,
  attempt: row.attempt,
  stake: row.stake,
  status: row.status as GambleStatus,
  lossReason: row.lossReason as GambleLossReason | null,
  placedAt: row.placedAt,
  settledAt: row.settledAt,
});

export interface GambleFacts {
  readonly pending: { readonly id: string; readonly stake: number } | null;
  /** The gamble won by the current attempt's unlock. */
  readonly won: { readonly id: string } | null;
  /** Gambles lost on the achievement, in any attempt (R-RANK-01, R-RANK-02). */
  readonly lost: number;
  /** One was lost in the current attempt: no other in it (A-27). */
  readonly lostThisAttempt: boolean;
}

export async function gambleFacts(
  tx: Transaction,
  userId: string,
  achievementId: string,
  attempt: number,
): Promise<GambleFacts> {
  const rows = await tx
    .select({ id: gambles.id, stake: gambles.stake, status: gambles.status, attempt: gambles.attempt })
    .from(gambles)
    .where(and(eq(gambles.userId, userId), eq(gambles.achievementId, achievementId)));
  const pending = rows.find((row) => row.status === 'pending');
  const won = rows.find((row) => row.status === 'won' && row.attempt === attempt);
  const lost = rows.filter((row) => row.status === 'lost');
  return {
    pending: pending === undefined ? null : { id: pending.id, stake: pending.stake },
    won: won === undefined ? null : { id: won.id },
    lost: lost.length,
    lostThisAttempt: lost.some((row) => row.attempt === attempt),
  };
}

/** A new pending gamble with the stake computed server-side (R-GMB-01, T-17). */
export async function insertGamble(
  tx: Transaction,
  userId: string,
  gamble: { readonly achievementId: string; readonly attempt: number; readonly stake: number },
  now: Date,
): Promise<GambleRecord> {
  const [row] = await tx
    .insert(gambles)
    .values({ id: randomUUID(), userId, ...gamble, status: 'pending', placedAt: now })
    .returning();
  if (row === undefined) throw new Error('the gamble was not stored');
  return toRecord(row);
}

/** The achievement's gambles of every attempt, newest first, after the position of a page cursor. */
export async function listGambles(
  tx: Transaction,
  userId: string,
  achievementId: string,
  page: { readonly after: { readonly createdAt: Date; readonly id: string } | null; readonly limit: number },
): Promise<GambleRecord[]> {
  const rows = await tx
    .select()
    .from(gambles)
    .where(
      and(
        eq(gambles.userId, userId),
        eq(gambles.achievementId, achievementId),
        page.after === null ? undefined : afterPosition(gambles.placedAt, gambles.id, page.after),
      ),
    )
    .orderBy(desc(gambles.placedAt), desc(gambles.id))
    .limit(page.limit);
  return rows.map(toRecord);
}

/** Whether the user has a pending gamble, on any achievement (R-GMB-01, Q-31). */
export async function hasPendingGamble(tx: Transaction, userId: string): Promise<boolean> {
  return (await tx.$count(gambles, and(eq(gambles.userId, userId), eq(gambles.status, 'pending')))) > 0;
}

/** The achievement of the user's pending gamble, if any (Q-31: at most one). */
export async function pendingGambleAchievement(tx: Transaction, userId: string): Promise<string | null> {
  const [row] = await tx
    .select({ achievementId: gambles.achievementId })
    .from(gambles)
    .where(and(eq(gambles.userId, userId), eq(gambles.status, 'pending')));
  return row?.achievementId ?? null;
}

export interface GambleSettlement {
  readonly id: string;
  /** `reverted`: the unlock that won it was undone, so it is pending again (R-ACH-05). */
  readonly outcome: 'won' | 'lost' | 'reverted';
  readonly lossReason: GambleLossReason | null;
}

/** Records how the effects engine settled a gamble; settled exactly once per transition (T-17). */
export async function settleGamble(
  tx: Transaction,
  userId: string,
  settlement: GambleSettlement,
  now: Date,
): Promise<void> {
  const settled =
    settlement.outcome === 'reverted'
      ? { status: 'pending', settledAt: null, lossReason: null }
      : { status: settlement.outcome, settledAt: now, lossReason: settlement.lossReason };
  await tx
    .update(gambles)
    .set(settled)
    .where(and(eq(gambles.userId, userId), eq(gambles.id, settlement.id)));
}
