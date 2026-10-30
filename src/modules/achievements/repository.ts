import { randomUUID } from 'node:crypto';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { Rank } from '../../domain/constants.ts';
import type { LocalDate } from '../../domain/dates.ts';
import { decryptText, encryptText } from '../../platform/crypto/field-cipher.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { afterPosition, increment } from '../../platform/db/expressions.ts';
import { transactionLock } from '../../platform/db/locks.ts';
import { achievements, idempotencyKeys, xpEvents } from '../../platform/db/schema/index.ts';
import type { UserDataKey } from '../accounts/data-key.ts';

/**
 * Achievements of one user (data-model §3.3): every query filters by the user, and title, description, motivation,
 * category, target date and deadline are encrypted with the user's data key, bound to record and column (R-ACH-02).
 */

export type AchievementStatus = 'active' | 'paused' | 'completed';

/** What a client writes (contract `AchievementCreate`). */
export interface AchievementContent {
  readonly title: string;
  readonly description: string | null;
  readonly motivation: string | null;
  readonly category: string | null;
  readonly targetDate: LocalDate | null;
  readonly isPrivate: boolean;
}

export interface AchievementRecord extends AchievementContent {
  readonly id: string;
  /** The attempt's deadline, the earliest target date in effect during it (A-35); never sent to clients. */
  readonly deadline: LocalDate | null;
  readonly status: AchievementStatus;
  readonly attempt: number;
  readonly completedAt: Date | null;
  readonly executionScore: number | null;
  readonly rank: Rank | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface AchievementListQuery {
  readonly status: AchievementStatus | undefined;
  /** Continue after this row of the newest-first list. */
  readonly after: { readonly createdAt: Date; readonly id: string } | null;
  readonly limit: number;
}

export interface AchievementsRepository {
  insert(content: AchievementContent, deadline: LocalDate | null, now: Date): Promise<AchievementRecord>;
  find(id: string): Promise<AchievementRecord | undefined>;
  /** Newest first (`created_at desc, id desc`), at most `limit` rows. */
  list(query: AchievementListQuery): Promise<AchievementRecord[]>;
  /** Active and paused achievements: what the limit of R-IN-01 counts (Q-40). */
  countOpen(): Promise<number>;
  /** Holds back the user's other creations until the transaction ends, so a limit check cannot race. */
  lockCreation(): Promise<void>;
  /** An unlock or re-lock decided by the effects engine (R-ACH-04/05); bumps the version (ADR-0008). */
  updateCompletion(achievement: AchievementRecord, change: CompletionChange, now: Date): Promise<AchievementRecord>;
}

export interface CompletionChange {
  readonly status: AchievementStatus;
  readonly completedAt: Date | null;
  readonly executionScore: number | null;
  readonly rank: Rank | null;
}

type Row = typeof achievements.$inferSelect;

export function achievementsRepository(tx: Transaction, userId: string, dataKey: UserDataKey): AchievementsRepository {
  const seal = (recordId: string, field: string, value: string): Buffer =>
    encryptText(dataKey.key, { userId, recordId, field }, value);
  const sealOptional = (recordId: string, field: string, value: string | null): Buffer | null =>
    value === null ? null : seal(recordId, field, value);
  const open = (recordId: string, field: string, blob: Buffer): string =>
    decryptText(dataKey.key, { userId, recordId, field }, blob);
  const openOptional = (recordId: string, field: string, blob: Buffer | null): string | null =>
    blob === null ? null : open(recordId, field, blob);

  const toRecord = (row: Row): AchievementRecord => ({
    id: row.id,
    title: open(row.id, 'title_enc', row.titleEnc),
    description: openOptional(row.id, 'description_enc', row.descriptionEnc),
    motivation: openOptional(row.id, 'motivation_enc', row.motivationEnc),
    category: openOptional(row.id, 'category_enc', row.categoryEnc),
    targetDate: openOptional(row.id, 'target_date_enc', row.targetDateEnc),
    deadline: openOptional(row.id, 'deadline_enc', row.deadlineEnc),
    status: row.status as AchievementStatus,
    isPrivate: row.isPrivate,
    attempt: row.attempt,
    completedAt: row.completedAt,
    executionScore: row.executionScore,
    rank: row.rank as Rank | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  });

  const mine = eq(achievements.userId, userId);

  return {
    async insert(content, deadline, now) {
      const id = randomUUID();
      await tx.insert(achievements).values({
        id,
        userId,
        titleEnc: seal(id, 'title_enc', content.title),
        descriptionEnc: sealOptional(id, 'description_enc', content.description),
        motivationEnc: sealOptional(id, 'motivation_enc', content.motivation),
        categoryEnc: sealOptional(id, 'category_enc', content.category),
        targetDateEnc: sealOptional(id, 'target_date_enc', content.targetDate),
        deadlineEnc: sealOptional(id, 'deadline_enc', deadline),
        status: 'active',
        isPrivate: content.isPrivate,
        attempt: 1,
        dekVersion: dataKey.version,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
      return {
        id,
        ...content,
        deadline,
        status: 'active',
        attempt: 1,
        completedAt: null,
        executionScore: null,
        rank: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
    },

    async find(id) {
      const [row] = await tx
        .select()
        .from(achievements)
        .where(and(mine, eq(achievements.id, id)));
      return row === undefined ? undefined : toRecord(row);
    },

    async list(query) {
      const rows = await tx
        .select()
        .from(achievements)
        .where(
          and(
            mine,
            query.status === undefined ? undefined : eq(achievements.status, query.status),
            query.after === null ? undefined : afterPosition(achievements.createdAt, achievements.id, query.after),
          ),
        )
        .orderBy(desc(achievements.createdAt), desc(achievements.id))
        .limit(query.limit);
      return rows.map(toRecord);
    },

    countOpen() {
      return tx.$count(achievements, and(mine, ne(achievements.status, 'completed')));
    },

    lockCreation() {
      return transactionLock(tx, `achievements:create:${userId}`);
    },

    async updateCompletion(achievement, change, now) {
      await tx
        .update(achievements)
        .set({ ...change, updatedAt: now, version: increment(achievements.version) })
        .where(and(mine, eq(achievements.id, achievement.id)));
      return { ...achievement, ...change, updatedAt: now, version: achievement.version + 1 };
    },
  };
}

/**
 * Deletes all goal content of the user (Q-10): achievements with their quests, check-ins, gambles and badges
 * (cascade), the XP ledger and the stored responses of create requests, which hold goal content for 24 hours. The
 * consent must be withdrawn first: until then restrictive policies keep completed achievements and the ledger.
 */
export async function deleteGoalContent(tx: Transaction, userId: string): Promise<void> {
  await tx.delete(achievements).where(eq(achievements.userId, userId));
  await tx.delete(xpEvents).where(eq(xpEvents.userId, userId));
  await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));
}
