import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { LocalDate } from '../../domain/dates.ts';
import type { HabitPeriod, QuestSize } from '../../domain/duration.ts';
import type { WeekStart } from '../../domain/periods.ts';
import { decryptText, encryptText } from '../../platform/crypto/field-cipher.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { increment } from '../../platform/db/expressions.ts';
import { quests } from '../../platform/db/schema/index.ts';
import type { UserDataKey } from '../accounts/data-key.ts';

/**
 * Quests of one user (data-model §3.3): every query filters by the user; title, notes, unit, start and target value
 * are encrypted with the user's data key, bound to record and column (R-QST-06).
 */

export type QuestType = 'one_time' | 'habit' | 'target';

export interface HabitSettings {
  readonly period: HabitPeriod;
  readonly timesPerPeriod: number;
  readonly periodCount: number;
  readonly startDate: LocalDate;
  /** The week start the run began with (Q-34). */
  readonly weekStart: WeekStart;
}

/** Values as canonical decimal strings (`decimal.ts`). */
export interface TargetSettings {
  readonly start: string;
  readonly target: string;
  readonly unit: string | null;
}

export interface NewQuest {
  readonly achievementId: string;
  readonly position: number;
  readonly type: QuestType;
  readonly size: QuestSize;
  readonly isRequired: boolean;
  readonly prerequisiteQuestId: string | null;
  readonly title: string;
  readonly notes: string | null;
  /** Habit quests only. */
  readonly habit: HabitSettings | null;
  /** Target quests only. */
  readonly target: TargetSettings | null;
}

export interface QuestRecord extends NewQuest {
  readonly id: string;
  /** Habit resets in the current attempt (R-QST-04, R-RANK-01). */
  readonly resetCount: number;
  /** The longest met-period count of the runs that ended (R-STR-01). */
  readonly habitBestStreak: number;
  readonly needsRestart: boolean;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

/** What the goal engine changes on a quest: resets (R-QST-04), runs moved to the unlock day (Q-38), completion. */
export interface QuestStateChange {
  readonly needsRestart?: boolean;
  readonly resetCount?: number;
  readonly habitBestStreak?: number;
  readonly habitStartDate?: LocalDate;
  readonly habitWeekStart?: WeekStart;
  readonly completedAt?: Date | null;
}

export interface QuestsRepository {
  insert(quest: NewQuest, now: Date): Promise<QuestRecord>;
  find(id: string): Promise<QuestRecord | undefined>;
  /** The quests of an achievement in their order: position, then creation. */
  listByAchievement(achievementId: string): Promise<QuestRecord[]>;
  /** Applies the change and bumps the version, as every change of a quest does (ADR-0008). */
  updateState(quest: QuestRecord, change: QuestStateChange, now: Date): Promise<QuestRecord>;
}

type Row = typeof quests.$inferSelect;

export function questsRepository(tx: Transaction, userId: string, dataKey: UserDataKey): QuestsRepository {
  const seal = (recordId: string, field: string, value: string): Buffer =>
    encryptText(dataKey.key, { userId, recordId, field }, value);
  const sealOptional = (recordId: string, field: string, value: string | null | undefined): Buffer | null =>
    value === null || value === undefined ? null : seal(recordId, field, value);
  const open = (recordId: string, field: string, blob: Buffer): string =>
    decryptText(dataKey.key, { userId, recordId, field }, blob);
  const openOptional = (recordId: string, field: string, blob: Buffer | null): string | null =>
    blob === null ? null : open(recordId, field, blob);

  const habitOf = (row: Row): HabitSettings | null =>
    row.habitPeriod === null ||
    row.habitTimesPerPeriod === null ||
    row.habitPeriodCount === null ||
    row.habitStartDate === null
      ? null
      : {
          period: row.habitPeriod as HabitPeriod,
          timesPerPeriod: row.habitTimesPerPeriod,
          periodCount: row.habitPeriodCount,
          startDate: row.habitStartDate,
          // Daily runs have no week start (data-model §3.3); it never matters for them.
          weekStart: (row.habitWeekStart ?? 'monday') as WeekStart,
        };
  const targetOf = (row: Row): TargetSettings | null =>
    row.startValueEnc === null || row.targetValueEnc === null
      ? null
      : {
          start: open(row.id, 'start_value_enc', row.startValueEnc),
          target: open(row.id, 'target_value_enc', row.targetValueEnc),
          unit: openOptional(row.id, 'unit_enc', row.unitEnc),
        };

  const toRecord = (row: Row): QuestRecord => ({
    id: row.id,
    achievementId: row.achievementId,
    position: row.position,
    type: row.type as QuestType,
    size: row.size as QuestSize,
    isRequired: row.isRequired,
    prerequisiteQuestId: row.prerequisiteQuestId,
    title: open(row.id, 'title_enc', row.titleEnc),
    notes: openOptional(row.id, 'notes_enc', row.notesEnc),
    habit: habitOf(row),
    target: targetOf(row),
    resetCount: row.resetCount,
    habitBestStreak: row.habitBestStreak,
    needsRestart: row.needsRestart,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  });

  const mine = eq(quests.userId, userId);

  return {
    async insert(quest, now) {
      const id = randomUUID();
      const [row] = await tx
        .insert(quests)
        .values({
          id,
          userId,
          achievementId: quest.achievementId,
          position: quest.position,
          type: quest.type,
          size: quest.size,
          isRequired: quest.isRequired,
          prerequisiteQuestId: quest.prerequisiteQuestId,
          titleEnc: seal(id, 'title_enc', quest.title),
          notesEnc: sealOptional(id, 'notes_enc', quest.notes),
          unitEnc: sealOptional(id, 'unit_enc', quest.target?.unit),
          startValueEnc: sealOptional(id, 'start_value_enc', quest.target?.start),
          targetValueEnc: sealOptional(id, 'target_value_enc', quest.target?.target),
          habitPeriod: quest.habit?.period ?? null,
          habitTimesPerPeriod: quest.habit?.timesPerPeriod ?? null,
          habitPeriodCount: quest.habit?.periodCount ?? null,
          habitStartDate: quest.habit?.startDate ?? null,
          habitWeekStart: quest.habit?.period === 'week' ? quest.habit.weekStart : null,
          dekVersion: dataKey.version,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (row === undefined) throw new Error('the quest was not stored');
      return toRecord(row);
    },

    async find(id) {
      const [row] = await tx
        .select()
        .from(quests)
        .where(and(mine, eq(quests.id, id)));
      return row === undefined ? undefined : toRecord(row);
    },

    async listByAchievement(achievementId) {
      const rows = await tx
        .select()
        .from(quests)
        .where(and(mine, eq(quests.achievementId, achievementId)))
        .orderBy(asc(quests.position), asc(quests.createdAt), asc(quests.id));
      return rows.map(toRecord);
    },

    async updateState(quest, change, now) {
      const [row] = await tx
        .update(quests)
        .set({
          needsRestart: change.needsRestart,
          resetCount: change.resetCount,
          habitBestStreak: change.habitBestStreak,
          habitStartDate: change.habitStartDate,
          habitWeekStart: change.habitWeekStart,
          completedAt: change.completedAt,
          updatedAt: now,
          version: increment(quests.version),
        })
        .where(and(mine, eq(quests.id, quest.id)))
        .returning();
      if (row === undefined) throw new Error('the quest to update is gone');
      return toRecord(row);
    },
  };
}
