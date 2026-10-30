import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { LocalDate } from '../../domain/dates.ts';
import { decryptText, encryptText } from '../../platform/crypto/field-cipher.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { afterPosition } from '../../platform/db/expressions.ts';
import { checkIns } from '../../platform/db/schema/index.ts';
import type { UserDataKey } from '../accounts/data-key.ts';

/**
 * Check-ins of one user (data-model §3.3): every query filters by the user; value and note are encrypted with the
 * user's data key, bound to record and column (R-CHK-02). Check-ins are immutable; an undo deletes one (Q-36).
 */

export interface NewCheckIn {
  readonly questId: string;
  readonly localDate: LocalDate;
  /** The achievement's attempt when the check-in was made; earlier attempts are history (R-ACH-06). */
  readonly attempt: number;
  /** Dated today at creation (R-CHK-04). */
  readonly countsForProgress: boolean;
  /** Target quests only: a canonical decimal string. */
  readonly value: string | null;
  readonly note: string | null;
}

export interface CheckInRecord extends NewCheckIn {
  readonly id: string;
  readonly createdAt: Date;
}

/** What evaluation needs of a counting check-in (`quest-evaluation.ts`); the note stays encrypted. */
export interface CountingCheckInRecord {
  readonly localDate: LocalDate;
  readonly createdAt: Date;
  readonly value: string | null;
}

export interface CheckInsRepository {
  insert(checkIn: NewCheckIn, now: Date): Promise<CheckInRecord>;
  find(id: string): Promise<CheckInRecord | undefined>;
  /** The quest's check-ins, newest first, after the position of a page cursor (R-IN-01). */
  listByQuest(
    questId: string,
    page: { readonly after: { readonly createdAt: Date; readonly id: string } | null; readonly limit: number },
  ): Promise<CheckInRecord[]>;
  /** The quest's check-ins dated `localDate`, counting or not (R-IN-01, A-42). */
  countOnDate(questId: string, localDate: LocalDate): Promise<number>;
  /** An undo (R-CHK-03). */
  remove(id: string): Promise<void>;
  /** The counting check-ins of one attempt per quest, oldest first. */
  countingByQuest(questIds: readonly string[], attempt: number): Promise<Map<string, CountingCheckInRecord[]>>;
}

type Row = typeof checkIns.$inferSelect;

export function checkInsRepository(tx: Transaction, userId: string, dataKey: UserDataKey): CheckInsRepository {
  const seal = (recordId: string, field: string, value: string | null): Buffer | null =>
    value === null ? null : encryptText(dataKey.key, { userId, recordId, field }, value);
  const open = (recordId: string, field: string, blob: Buffer | null): string | null =>
    blob === null ? null : decryptText(dataKey.key, { userId, recordId, field }, blob);

  const toRecord = (row: Row): CheckInRecord => ({
    id: row.id,
    questId: row.questId,
    localDate: row.localDate,
    attempt: row.attempt,
    countsForProgress: row.countsForProgress,
    value: open(row.id, 'value_enc', row.valueEnc),
    note: open(row.id, 'note_enc', row.noteEnc),
    createdAt: row.createdAt,
  });

  const mine = eq(checkIns.userId, userId);

  return {
    async insert(checkIn, now) {
      const id = randomUUID();
      await tx.insert(checkIns).values({
        id,
        userId,
        questId: checkIn.questId,
        localDate: checkIn.localDate,
        attempt: checkIn.attempt,
        countsForProgress: checkIn.countsForProgress,
        valueEnc: seal(id, 'value_enc', checkIn.value),
        noteEnc: seal(id, 'note_enc', checkIn.note),
        dekVersion: dataKey.version,
        createdAt: now,
      });
      return { id, ...checkIn, createdAt: now };
    },

    async find(id) {
      const [row] = await tx
        .select()
        .from(checkIns)
        .where(and(mine, eq(checkIns.id, id)));
      return row === undefined ? undefined : toRecord(row);
    },

    async listByQuest(questId, page) {
      const rows = await tx
        .select()
        .from(checkIns)
        .where(
          and(
            mine,
            eq(checkIns.questId, questId),
            page.after === null ? undefined : afterPosition(checkIns.createdAt, checkIns.id, page.after),
          ),
        )
        .orderBy(desc(checkIns.createdAt), desc(checkIns.id))
        .limit(page.limit);
      return rows.map(toRecord);
    },

    countOnDate(questId, localDate) {
      return tx.$count(checkIns, and(mine, eq(checkIns.questId, questId), eq(checkIns.localDate, localDate)));
    },

    async remove(id) {
      await tx.delete(checkIns).where(and(mine, eq(checkIns.id, id)));
    },

    async countingByQuest(questIds, attempt) {
      const counting = new Map<string, CountingCheckInRecord[]>();
      if (questIds.length === 0) return counting;
      const rows = await tx
        .select({
          id: checkIns.id,
          questId: checkIns.questId,
          localDate: checkIns.localDate,
          createdAt: checkIns.createdAt,
          valueEnc: checkIns.valueEnc,
        })
        .from(checkIns)
        .where(
          and(
            mine,
            inArray(checkIns.questId, [...questIds]),
            eq(checkIns.attempt, attempt),
            eq(checkIns.countsForProgress, true),
          ),
        )
        .orderBy(asc(checkIns.localDate), asc(checkIns.createdAt), asc(checkIns.id));
      for (const row of rows) {
        const record = {
          localDate: row.localDate,
          createdAt: row.createdAt,
          value: open(row.id, 'value_enc', row.valueEnc),
        };
        const list = counting.get(row.questId);
        if (list === undefined) counting.set(row.questId, [record]);
        else list.push(record);
      }
      return counting;
    },
  };
}
