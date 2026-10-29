import { sql } from 'drizzle-orm';
import { check, cidr, doublePrecision, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './accounts.ts';
import { bytea, timestamptz } from './types.ts';

/** Audit, email outbox, rate limiting and deletion records (docs/data-model.md §3.5). */

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    // NULL for events about unknown accounts (e.g. a failed login with an unregistered email).
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    sessionId: uuid('session_id'),
    ipPrefix: cidr('ip_prefix'),
    client: text('client'),
    outcome: text('outcome').notNull(),
    metadata: jsonb('metadata')
      .$type<Readonly<Record<string, string>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    check(
      'audit_events_event_type_check',
      sql`${table.eventType} in ('login_succeeded', 'login_failed', 'logout', 'session_revoked',
        'refresh_reuse_detected', 'password_changed', 'password_reset_requested', 'password_reset_completed',
        'email_change_requested', 'email_changed', 'email_verified', 'consent_granted', 'consent_withdrawn',
        'export_requested', 'account_deleted', 'account_reactivated', 'reauth_succeeded', 'reauth_failed',
        'rate_limited')`,
    ),
    // Only truncated networks (IPv4 /24, IPv6 /48), never a full address (data-inventory C8).
    check(
      'audit_events_ip_prefix_check',
      sql`masklen(${table.ipPrefix}) <= case family(${table.ipPrefix}) when 4 then 24 else 48 end`,
    ),
    check('audit_events_client_check', sql`${table.client} in ('ios', 'android')`),
    check('audit_events_outcome_check', sql`${table.outcome} in ('success', 'failure')`),
    check('audit_events_metadata_check', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    index('audit_events_user_created_idx').on(table.userId, table.createdAt),
    index('audit_events_created_idx').on(table.createdAt),
  ],
);

export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    template: text('template').notNull(),
    payloadEnc: bytea('payload_enc').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').notNull(),
    lastErrorCode: text('last_error_code'),
    sentAt: timestamptz('sent_at'),
    deadAt: timestamptz('dead_at'),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    check(
      'email_outbox_template_check',
      sql`${table.template} in ('verify_email', 'registration_notice', 'password_reset', 'password_changed_notice',
        'email_change_verify', 'email_change_notice', 'account_deleted_notice')`,
    ),
    check('email_outbox_attempts_check', sql`${table.attempts} >= 0`),
    // An error class such as `smtp_552`, never message text, which could contain an address.
    check('email_outbox_last_error_code_check', sql`${table.lastErrorCode} ~ '^[a-z0-9_]{1,40}$'`),
    check('email_outbox_state_check', sql`${table.sentAt} is null or ${table.deadAt} is null`),
    index('email_outbox_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.sentAt} is null and ${table.deadAt} is null`),
  ],
);

/** Token buckets keyed by HMAC(daily key, scope:subject): never a raw IP address or email (Q-14). UNLOGGED. */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    bucketKey: bytea('bucket_key').primaryKey(),
    tokens: doublePrecision('tokens').notNull(),
    failures: integer('failures').notNull().default(0),
    blockedUntil: timestamptz('blocked_until'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    check('rate_limit_buckets_bucket_key_check', sql`octet_length(${table.bucketKey}) = 32`),
    check('rate_limit_buckets_counters_check', sql`${table.tokens} >= 0 and ${table.failures} >= 0`),
    index('rate_limit_buckets_updated_idx').on(table.updatedAt),
  ],
);

/** The random ID of a deleted account and the time of deletion, replayed after a backup restore (Q-13). */
export const deletedUserTombstones = pgTable('deleted_user_tombstones', {
  userId: uuid('user_id').primaryKey(),
  deletedAt: timestamptz('deleted_at').notNull(),
});
