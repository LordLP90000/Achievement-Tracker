import { and, between, count, desc, eq, sum } from 'drizzle-orm';
import type { Rank } from '../../domain/constants.ts';
import type { LocalDate } from '../../domain/dates.ts';
import { decryptText } from '../../platform/crypto/field-cipher.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { achievements, badges, gambles, xpEvents } from '../../platform/db/schema/index.ts';
import type { UserDataKey } from '../accounts/data-key.ts';
import type { AchievementStatus } from '../achievements/repository.ts';

/** What the stats read of one user (R-STA-01): totals of the ledger, achievements, badges and gambles. */

export interface StatusCount {
  readonly status: AchievementStatus;
  /** Completed achievements only. */
  readonly rank: Rank | null;
  readonly count: number;
}

export interface BadgeView {
  readonly id: string;
  readonly kind: string;
  readonly rank: Rank;
  readonly achievementId: string;
  readonly achievementTitle: string;
  readonly awardedAt: Date;
}

/** The XP of each local day from `from` to `to` that has ledger events (A-13). */
export async function xpByDay(
  tx: Transaction,
  userId: string,
  from: LocalDate,
  to: LocalDate,
): Promise<ReadonlyMap<LocalDate, number>> {
  const rows = await tx
    .select({ date: xpEvents.localDate, xp: sum(xpEvents.amount).mapWith(Number) })
    .from(xpEvents)
    .where(and(eq(xpEvents.userId, userId), between(xpEvents.localDate, from, to)))
    .groupBy(xpEvents.localDate);
  return new Map(rows.map((row) => [row.date, row.xp]));
}

export async function achievementCounts(tx: Transaction, userId: string): Promise<StatusCount[]> {
  const rows = await tx
    .select({ status: achievements.status, rank: achievements.rank, count: count() })
    .from(achievements)
    .where(eq(achievements.userId, userId))
    .groupBy(achievements.status, achievements.rank);
  return rows.map((row) => ({ ...row, status: row.status as AchievementStatus, rank: row.rank as Rank | null }));
}

/** Settled gambles of every achievement and attempt (R-GMB-03). */
export async function gambleRecord(tx: Transaction, userId: string): Promise<{ won: number; lost: number }> {
  const rows = await tx
    .select({ status: gambles.status, count: count() })
    .from(gambles)
    .where(eq(gambles.userId, userId))
    .groupBy(gambles.status);
  const counted = (status: string) => rows.find((row) => row.status === status)?.count ?? 0;
  return { won: counted('won'), lost: counted('lost') };
}

/** The user's newest rank badges (R-RANK-03), with the title of their achievement. */
export async function newestBadges(
  tx: Transaction,
  userId: string,
  dataKey: UserDataKey,
  limit: number,
): Promise<BadgeView[]> {
  const rows = await tx
    .select({
      id: badges.id,
      kind: badges.kind,
      rank: badges.rank,
      achievementId: badges.achievementId,
      titleEnc: achievements.titleEnc,
      awardedAt: badges.awardedAt,
    })
    .from(badges)
    .innerJoin(achievements, eq(achievements.id, badges.achievementId))
    .where(eq(badges.userId, userId))
    .orderBy(desc(badges.awardedAt), desc(badges.id))
    .limit(limit);
  return rows.map(({ titleEnc, ...badge }) => ({
    ...badge,
    rank: badge.rank as Rank,
    achievementTitle: decryptText(dataKey.key, { userId, recordId: badge.achievementId, field: 'title_enc' }, titleEnc),
  }));
}
