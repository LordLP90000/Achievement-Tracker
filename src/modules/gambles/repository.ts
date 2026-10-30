import { and, eq } from 'drizzle-orm';
import type { GambleLossReason } from '../../domain/gamble.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { gambles } from '../../platform/db/schema/index.ts';

/** Gambles of one user (data-model §3.3, R-GMB-*): one pending at a time across all achievements (Q-31). */

export interface GambleFacts {
  readonly pending: { readonly id: string; readonly stake: number } | null;
  /** The gamble won by the current attempt's unlock. */
  readonly won: { readonly id: string } | null;
  /** Gambles lost on the achievement, in any attempt (R-RANK-01, R-RANK-02). */
  readonly lost: number;
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
  return {
    pending: pending === undefined ? null : { id: pending.id, stake: pending.stake },
    won: won === undefined ? null : { id: won.id },
    lost: rows.filter((row) => row.status === 'lost').length,
  };
}

export interface GambleSettlement {
  readonly id: string;
  /** `reverted`: the unlock that won it was undone, so it is pending again (R-ACH-05). */
  readonly outcome: 'won' | 'lost' | 'reverted';
  readonly lossReason: GambleLossReason | null;
}

/** Whether the user has a pending gamble, on any achievement (R-GMB-01, Q-31). */
export async function hasPendingGamble(tx: Transaction, userId: string): Promise<boolean> {
  return (await tx.$count(gambles, and(eq(gambles.userId, userId), eq(gambles.status, 'pending')))) > 0;
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
