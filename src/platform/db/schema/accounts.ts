import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, timestamptz } from './types.ts';

/** Accounts, keys, tokens, sessions and consents (docs/data-model.md §3.1–3.2). */

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    emailEnc: bytea('email_enc').notNull(),
    emailBlindIndex: bytea('email_blind_index').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    nicknameEnc: bytea('nickname_enc'),
    timezone: text('timezone').notNull(),
    locale: text('locale').notNull(),
    weekStart: text('week_start').notNull().default('monday'),
    ageConfirmed: boolean('age_confirmed').notNull(),
    emailVerifiedAt: timestamptz('email_verified_at'),
    deactivatedAt: timestamptz('deactivated_at'),
    privacyPolicyVersion: text('privacy_policy_version').notNull(),
    passwordChangedAt: timestamptz('password_changed_at').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    check('users_email_blind_index_check', sql`octet_length(${table.emailBlindIndex}) = 32`),
    check('users_week_start_check', sql`${table.weekStart} in ('monday', 'sunday', 'saturday')`),
    check('users_age_confirmed_check', sql`${table.ageConfirmed}`),
    check('users_version_check', sql`${table.version} >= 1`),
  ],
);

export const userKeys = pgTable(
  'user_keys',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    wrappedDek: bytea('wrapped_dek').notNull(),
    kekId: text('kek_id').notNull(),
    kekVersion: integer('kek_version').notNull(),
    dekVersion: integer('dek_version').notNull().default(1),
    createdAt: timestamptz('created_at').notNull(),
    rotatedAt: timestamptz('rotated_at'),
  },
  (table) => [check('user_keys_versions_check', sql`${table.kekVersion} >= 1 and ${table.dekVersion} >= 1`)],
);

export const oneTimeTokens = pgTable(
  'one_time_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    tokenHash: bytea('token_hash').notNull().unique(),
    newEmailEnc: bytea('new_email_enc'),
    newEmailBlindIndex: bytea('new_email_blind_index'),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    check('one_time_tokens_purpose_check', sql`${table.purpose} in ('verify_email', 'change_email', 'reset_password')`),
    check(
      'one_time_tokens_new_email_check',
      sql`(${table.purpose} = 'change_email' and ${table.newEmailEnc} is not null and ${table.newEmailBlindIndex} is not null)
        or (${table.purpose} <> 'change_email' and ${table.newEmailEnc} is null and ${table.newEmailBlindIndex} is null)`,
    ),
    check(
      'one_time_tokens_lifetime_check',
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '30 minutes'`,
    ),
    check('one_time_tokens_token_hash_check', sql`octet_length(${table.tokenHash}) = 32`),
    index('one_time_tokens_user_purpose_idx').on(table.userId, table.purpose),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    client: text('client').notNull(),
    deviceLabelEnc: bytea('device_label_enc'),
    createdAt: timestamptz('created_at').notNull(),
    lastUsedAt: timestamptz('last_used_at').notNull(),
    lastReauthAt: timestamptz('last_reauth_at').notNull(),
    absoluteExpiresAt: timestamptz('absolute_expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    // Target of the session_tokens foreign key that keeps a token's user equal to its session's user.
    unique('sessions_id_user_id_unique').on(table.id, table.userId),
    index('sessions_user_id_idx').on(table.userId),
    check('sessions_client_check', sql`${table.client} in ('ios', 'android')`),
    check(
      'sessions_revoked_reason_check',
      sql`${table.revokedReason} in ('logout', 'logout_all', 'user_revoked', 'password_changed', 'password_reset',
        'refresh_reuse', 'expired', 'account_deleted', 'session_limit')`,
    ),
    check('sessions_revoked_check', sql`(${table.revokedAt} is null) = (${table.revokedReason} is null)`),
    check(
      'sessions_lifetime_check',
      sql`${table.absoluteExpiresAt} > ${table.createdAt}
        and ${table.absoluteExpiresAt} <= ${table.createdAt} + interval '180 days'`,
    ),
  ],
);

export const sessionTokens = pgTable(
  'session_tokens',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id').notNull(),
    userId: uuid('user_id').notNull(),
    generation: integer('generation').notNull(),
    accessTokenHash: bytea('access_token_hash').notNull().unique(),
    accessExpiresAt: timestamptz('access_expires_at').notNull(),
    refreshTokenHash: bytea('refresh_token_hash').notNull().unique(),
    refreshExpiresAt: timestamptz('refresh_expires_at').notNull(),
    rotatedAt: timestamptz('rotated_at'),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'session_tokens_session_fk',
      columns: [table.sessionId, table.userId],
      foreignColumns: [sessions.id, sessions.userId],
    }).onDelete('cascade'),
    unique('session_tokens_session_generation_unique').on(table.sessionId, table.generation),
    check('session_tokens_generation_check', sql`${table.generation} >= 1`),
    check(
      'session_tokens_hashes_check',
      sql`octet_length(${table.accessTokenHash}) = 32 and octet_length(${table.refreshTokenHash}) = 32`,
    ),
    check(
      'session_tokens_access_lifetime_check',
      sql`${table.accessExpiresAt} > ${table.createdAt}
        and ${table.accessExpiresAt} <= ${table.createdAt} + interval '15 minutes'`,
    ),
    check(
      'session_tokens_refresh_lifetime_check',
      sql`${table.refreshExpiresAt} > ${table.createdAt}
        and ${table.refreshExpiresAt} <= ${table.createdAt} + interval '30 days'`,
    ),
  ],
);

export const consents = pgTable(
  'consents',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    version: text('version').notNull(),
    grantedAt: timestamptz('granted_at').notNull(),
    withdrawnAt: timestamptz('withdrawn_at'),
  },
  (table) => [
    check('consents_type_check', sql`${table.type} in ('goal_content')`),
    check('consents_withdrawn_check', sql`${table.withdrawnAt} is null or ${table.withdrawnAt} >= ${table.grantedAt}`),
    uniqueIndex('consents_active_unique')
      .on(table.userId, table.type)
      .where(sql`${table.withdrawnAt} is null`),
  ],
);
