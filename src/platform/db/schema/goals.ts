import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts.ts';
import { bytea, timestamptz } from './types.ts';

/**
 * Goal content and gamification (docs/data-model.md §3.3–3.4). Child rows reference their parent together with
 * `user_id` (composite foreign keys), so a row can never hang below another user's achievement or quest (T-01).
 */

const RANKS = sql.raw(`'unranked', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'champion'`);

/** Kinds whose amount is a credit; every other kind is a debit (`src/domain/effects.ts`). */
const CREDIT_KINDS = sql.raw(`'quest_completed', 'rank_bonus', 'gamble_won', 'xp_floor'`);
const DEBIT_KINDS = sql.raw(
  `'quest_uncompleted', 'rank_bonus_revoked', 'gamble_lost', 'gamble_reverted', 'pause_revoked', 'quest_deleted',
        'achievement_deleted'`,
);

export const achievements = pgTable(
  'achievements',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    titleEnc: bytea('title_enc').notNull(),
    descriptionEnc: bytea('description_enc'),
    motivationEnc: bytea('motivation_enc'),
    categoryEnc: bytea('category_enc'),
    targetDateEnc: bytea('target_date_enc'),
    deadlineEnc: bytea('deadline_enc'),
    status: text('status').notNull(),
    isPrivate: boolean('is_private').notNull().default(false),
    attempt: integer('attempt').notNull().default(1),
    completedAt: timestamptz('completed_at'),
    executionScore: numeric('execution_score', { precision: 5, scale: 2, mode: 'number' }),
    rank: text('rank'),
    dekVersion: integer('dek_version').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    unique('achievements_id_user_id_unique').on(table.id, table.userId),
    // Scanned backwards for newest-first pages: `created_at desc, id desc` is the exact reverse of this order.
    index('achievements_user_status_created_idx').on(table.userId, table.status, table.createdAt, table.id),
    check('achievements_status_check', sql`${table.status} in ('active', 'paused', 'completed')`),
    check('achievements_rank_check', sql`${table.rank} in (${RANKS})`),
    check('achievements_execution_score_check', sql`${table.executionScore} between 0 and 100`),
    check(
      'achievements_completion_check',
      sql`(${table.status} = 'completed') = (${table.completedAt} is not null)
        and (${table.completedAt} is null) = (${table.executionScore} is null)
        and (${table.completedAt} is null) = (${table.rank} is null)`,
    ),
    check(
      'achievements_counters_check',
      sql`${table.attempt} >= 1 and ${table.dekVersion} >= 1 and ${table.version} >= 1`,
    ),
  ],
);

export const gambles = pgTable(
  'gambles',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    achievementId: uuid('achievement_id').notNull(),
    attempt: integer('attempt').notNull(),
    stake: bigint('stake', { mode: 'number' }).notNull(),
    status: text('status').notNull(),
    lossReason: text('loss_reason'),
    placedAt: timestamptz('placed_at').notNull(),
    settledAt: timestamptz('settled_at'),
  },
  (table) => [
    foreignKey({
      name: 'gambles_achievement_fk',
      columns: [table.achievementId, table.userId],
      foreignColumns: [achievements.id, achievements.userId],
    }).onDelete('cascade'),
    unique('gambles_id_user_id_unique').on(table.id, table.userId),
    uniqueIndex('gambles_pending_unique')
      .on(table.userId)
      .where(sql`${table.status} = 'pending'`),
    index('gambles_achievement_idx').on(table.achievementId),
    check('gambles_status_check', sql`${table.status} in ('pending', 'won', 'lost')`),
    check(
      'gambles_loss_reason_check',
      sql`${table.lossReason} in ('target_date_passed', 'habit_reset', 'paused', 'deleted')`,
    ),
    check(
      'gambles_settlement_check',
      sql`(${table.status} = 'pending') = (${table.settledAt} is null)
        and (${table.status} = 'lost') = (${table.lossReason} is not null)
        and (${table.settledAt} is null or ${table.settledAt} >= ${table.placedAt})`,
    ),
    check('gambles_counters_check', sql`${table.stake} > 0 and ${table.attempt} >= 1`),
  ],
);

export const quests = pgTable(
  'quests',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    achievementId: uuid('achievement_id').notNull(),
    position: integer('position').notNull(),
    type: text('type').notNull(),
    size: text('size').notNull(),
    isRequired: boolean('is_required').notNull().default(true),
    prerequisiteQuestId: uuid('prerequisite_quest_id'),
    titleEnc: bytea('title_enc').notNull(),
    notesEnc: bytea('notes_enc'),
    unitEnc: bytea('unit_enc'),
    startValueEnc: bytea('start_value_enc'),
    targetValueEnc: bytea('target_value_enc'),
    habitPeriod: text('habit_period'),
    habitTimesPerPeriod: integer('habit_times_per_period'),
    habitPeriodCount: integer('habit_period_count'),
    habitStartDate: date('habit_start_date', { mode: 'string' }),
    habitWeekStart: text('habit_week_start'),
    resetCount: integer('reset_count').notNull().default(0),
    habitBestStreak: integer('habit_best_streak').notNull().default(0),
    needsRestart: boolean('needs_restart').notNull().default(false),
    completedAt: timestamptz('completed_at'),
    dekVersion: integer('dek_version').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: 'quests_achievement_fk',
      columns: [table.achievementId, table.userId],
      foreignColumns: [achievements.id, achievements.userId],
    }).onDelete('cascade'),
    // A prerequisite lies in the same achievement (R-QST-02). The migration narrows SET NULL to the prerequisite.
    foreignKey({
      name: 'quests_prerequisite_fk',
      columns: [table.prerequisiteQuestId, table.achievementId],
      foreignColumns: [table.id, table.achievementId],
    }).onDelete('set null'),
    unique('quests_id_user_id_unique').on(table.id, table.userId),
    unique('quests_id_achievement_id_unique').on(table.id, table.achievementId),
    index('quests_achievement_position_idx').on(table.achievementId, table.position),
    index('quests_user_id_idx').on(table.userId),
    check('quests_type_check', sql`${table.type} in ('one_time', 'habit', 'target')`),
    check('quests_size_check', sql`${table.size} in ('S', 'M', 'L')`),
    check('quests_prerequisite_check', sql`${table.prerequisiteQuestId} <> ${table.id}`),
    check('quests_habit_period_check', sql`${table.habitPeriod} in ('day', 'week')`),
    check('quests_habit_times_per_period_check', sql`${table.habitTimesPerPeriod} between 1 and 50`),
    check('quests_habit_period_count_check', sql`${table.habitPeriodCount} between 1 and 520`),
    check('quests_habit_week_start_check', sql`${table.habitWeekStart} in ('monday', 'sunday', 'saturday')`),
    check(
      'quests_habit_columns_check',
      sql`(${table.type} = 'habit') = (${table.habitPeriod} is not null)
        and (${table.type} = 'habit') = (${table.habitTimesPerPeriod} is not null)
        and (${table.type} = 'habit') = (${table.habitPeriodCount} is not null)
        and (${table.type} = 'habit') = (${table.habitStartDate} is not null)
        and (${table.habitPeriod} is not distinct from 'week') = (${table.habitWeekStart} is not null)`,
    ),
    check(
      'quests_target_columns_check',
      sql`(${table.type} = 'target') = (${table.startValueEnc} is not null)
        and (${table.type} = 'target') = (${table.targetValueEnc} is not null)
        and (${table.type} = 'target' or ${table.unitEnc} is null)`,
    ),
    check(
      'quests_habit_state_check',
      sql`(${table.type} = 'habit' or (${table.resetCount} = 0 and ${table.habitBestStreak} = 0 and not ${table.needsRestart}))
        and not (${table.needsRestart} and ${table.completedAt} is not null)`,
    ),
    check(
      'quests_counters_check',
      sql`${table.position} >= 0 and ${table.resetCount} >= 0 and ${table.habitBestStreak} >= 0
        and ${table.dekVersion} >= 1 and ${table.version} >= 1`,
    ),
  ],
);

export const checkIns = pgTable(
  'check_ins',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    questId: uuid('quest_id').notNull(),
    localDate: date('local_date', { mode: 'string' }).notNull(),
    attempt: integer('attempt').notNull(),
    countsForProgress: boolean('counts_for_progress').notNull(),
    valueEnc: bytea('value_enc'),
    noteEnc: bytea('note_enc'),
    dekVersion: integer('dek_version').notNull(),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'check_ins_quest_fk',
      columns: [table.questId, table.userId],
      foreignColumns: [quests.id, quests.userId],
    }).onDelete('cascade'),
    index('check_ins_counting_idx')
      .on(table.questId, table.attempt, table.localDate)
      .where(sql`${table.countsForProgress}`),
    index('check_ins_quest_created_idx').on(table.questId, table.createdAt, table.id),
    check('check_ins_counters_check', sql`${table.attempt} >= 1 and ${table.dekVersion} >= 1`),
  ],
);

export const xpEvents = pgTable(
  'xp_events',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    questId: uuid('quest_id'),
    achievementId: uuid('achievement_id'),
    gambleId: uuid('gamble_id'),
    localDate: date('local_date', { mode: 'string' }).notNull(),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    // The ledger outlives what it refers to; the migration narrows SET NULL to the reference, keeping `user_id`.
    foreignKey({
      name: 'xp_events_quest_fk',
      columns: [table.questId, table.userId],
      foreignColumns: [quests.id, quests.userId],
    }).onDelete('set null'),
    foreignKey({
      name: 'xp_events_achievement_fk',
      columns: [table.achievementId, table.userId],
      foreignColumns: [achievements.id, achievements.userId],
    }).onDelete('set null'),
    foreignKey({
      name: 'xp_events_gamble_fk',
      columns: [table.gambleId, table.userId],
      foreignColumns: [gambles.id, gambles.userId],
    }).onDelete('set null'),
    index('xp_events_user_date_idx').on(table.userId, table.localDate),
    index('xp_events_quest_idx')
      .on(table.questId)
      .where(sql`${table.questId} is not null`),
    index('xp_events_achievement_idx')
      .on(table.achievementId)
      .where(sql`${table.achievementId} is not null`),
    index('xp_events_gamble_idx')
      .on(table.gambleId)
      .where(sql`${table.gambleId} is not null`),
    check('xp_events_kind_check', sql`${table.kind} in (${CREDIT_KINDS}, ${DEBIT_KINDS})`),
    check(
      'xp_events_amount_check',
      sql`case when ${table.kind} in (${CREDIT_KINDS}) then ${table.amount} > 0 else ${table.amount} < 0 end`,
    ),
  ],
);

export const badges = pgTable(
  'badges',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    achievementId: uuid('achievement_id').notNull(),
    kind: text('kind').notNull(),
    rank: text('rank').notNull(),
    awardedAt: timestamptz('awarded_at').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'badges_achievement_fk',
      columns: [table.achievementId, table.userId],
      foreignColumns: [achievements.id, achievements.userId],
    }).onDelete('cascade'),
    unique('badges_achievement_kind_unique').on(table.achievementId, table.kind),
    index('badges_user_id_idx').on(table.userId),
    check('badges_kind_check', sql`${table.kind} in ('achievement_rank')`),
    check('badges_rank_check', sql`${table.rank} in (${RANKS})`),
  ],
);
