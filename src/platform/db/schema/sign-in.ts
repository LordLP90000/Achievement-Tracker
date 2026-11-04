import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './accounts.ts';
import { bytea, timestamptz } from './types.ts';

/** Sign-in methods: passkeys, TOTP, recovery codes and their short-lived challenges (ADR-0019, data-model §3.1). */

export const passkeys = pgTable(
  'passkeys',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: bytea('credential_id').notNull().unique(),
    /** The COSE public key the authenticator signs for. */
    publicKey: bytea('public_key').notNull(),
    signCount: bigint('sign_count', { mode: 'number' }).notNull(),
    transports: text('transports').array().notNull(),
    backedUp: boolean('backed_up').notNull(),
    nameEnc: bytea('name_enc'),
    createdAt: timestamptz('created_at').notNull(),
    lastUsedAt: timestamptz('last_used_at'),
  },
  (table) => [
    index('passkeys_user_id_idx').on(table.userId),
    check('passkeys_credential_id_check', sql`octet_length(${table.credentialId}) between 1 and 1023`),
    check('passkeys_public_key_check', sql`octet_length(${table.publicKey}) between 1 and 2048`),
    check('passkeys_sign_count_check', sql`${table.signCount} between 0 and 4294967295`),
    check(
      'passkeys_transports_check',
      sql`${table.transports} <@ array['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']::text[]
        and cardinality(${table.transports}) <= 7`,
    ),
  ],
);

/** A WebAuthn challenge, single use: deleted when a response uses it, purged when it expires. */
export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    id: uuid('id').primaryKey(),
    challengeHash: bytea('challenge_hash').notNull().unique(),
    purpose: text('purpose').notNull(),
    /** The account a registration is for; sign-in and step-up challenges name none. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    check('webauthn_challenges_purpose_check', sql`${table.purpose} in ('registration', 'authentication')`),
    check('webauthn_challenges_user_check', sql`(${table.purpose} = 'registration') = (${table.userId} is not null)`),
    check('webauthn_challenges_challenge_hash_check', sql`octet_length(${table.challengeHash}) = 32`),
    check(
      'webauthn_challenges_lifetime_check',
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '5 minutes'`,
    ),
    index('webauthn_challenges_expires_idx').on(table.expiresAt),
    index('webauthn_challenges_user_id_idx').on(table.userId),
  ],
);

/** One TOTP secret per account: pending until confirmed (`enabled_at` null), then on. */
export const totpSecrets = pgTable(
  'totp_secrets',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    secretEnc: bytea('secret_enc').notNull(),
    enabledAt: timestamptz('enabled_at'),
    /** The last time step a code was accepted for; no code of it or an earlier step is accepted again. */
    lastUsedStep: bigint('last_used_step', { mode: 'number' }),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    check('totp_secrets_enabled_check', sql`${table.enabledAt} >= ${table.createdAt}`),
    check('totp_secrets_last_used_step_check', sql`${table.lastUsedStep} >= 0`),
    index('totp_secrets_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.enabledAt} is null`),
  ],
);

/** Unused recovery codes, as digests; a used code is deleted. */
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: bytea('code_hash').notNull().unique(),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    check('recovery_codes_code_hash_check', sql`octet_length(${table.codeHash}) = 32`),
    index('recovery_codes_user_id_idx').on(table.userId),
  ],
);

/** The second step of a password login with TOTP on: a 5-minute token that takes at most 5 wrong codes. */
export const secondFactorChallenges = pgTable(
  'second_factor_challenges',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull().unique(),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull(),
  },
  (table) => [
    check('second_factor_challenges_token_hash_check', sql`octet_length(${table.tokenHash}) = 32`),
    check('second_factor_challenges_failed_attempts_check', sql`${table.failedAttempts} between 0 and 5`),
    check(
      'second_factor_challenges_lifetime_check',
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '5 minutes'`,
    ),
    index('second_factor_challenges_expires_idx').on(table.expiresAt),
    index('second_factor_challenges_user_id_idx').on(table.userId),
  ],
);
