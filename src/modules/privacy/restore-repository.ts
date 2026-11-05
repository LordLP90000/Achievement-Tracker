import { asc, eq, gt, inArray } from 'drizzle-orm';
import type { Transaction } from '../../platform/db/database.ts';
import { consents, passkeys, recoveryCodes, sessions, totpSecrets, users } from '../../platform/db/schema/index.ts';

/**
 * The account rows the replay after a restore compares and changes (Q-57, ADR-0020 as amended), read in both
 * databases and written in the restored one with the migrator's role while the API and the worker are stopped.
 */

export interface AccountState {
  readonly id: string;
  readonly deactivatedAt: Date | null;
  readonly passwordHash: string;
  readonly passwordChangedAt: Date;
  readonly emailEnc: Buffer;
  readonly emailBlindIndex: Buffer;
  readonly emailVerifiedAt: Date | null;
  readonly version: number;
}

export type AccountChanges = Partial<
  Pick<
    AccountState,
    'deactivatedAt' | 'passwordHash' | 'passwordChangedAt' | 'emailEnc' | 'emailBlindIndex' | 'emailVerifiedAt'
  >
>;

export interface AddressHolder {
  readonly id: string;
  readonly emailBlindIndex: Buffer;
  readonly emailVerifiedAt: Date | null;
}

const ACCOUNT_STATE = {
  id: users.id,
  deactivatedAt: users.deactivatedAt,
  passwordHash: users.passwordHash,
  passwordChangedAt: users.passwordChangedAt,
  emailEnc: users.emailEnc,
  emailBlindIndex: users.emailBlindIndex,
  emailVerifiedAt: users.emailVerifiedAt,
  version: users.version,
};

/** The next `limit` account IDs after `after`, in order: the replay walks every account once. */
export async function accountIdsAfter(tx: Transaction, after: string | undefined, limit: number): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(after === undefined ? undefined : gt(users.id, after))
    .orderBy(asc(users.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

export async function readAccountStates(tx: Transaction, ids: readonly string[]): Promise<AccountState[]> {
  if (ids.length === 0) return [];
  return tx
    .select(ACCOUNT_STATE)
    .from(users)
    .where(inArray(users.id, [...ids]));
}

/** Writes the changes with a new version and `updated_at`. */
export async function updateAccount(
  tx: Transaction,
  id: string,
  changes: AccountChanges,
  version: number,
  now: Date,
): Promise<void> {
  await tx
    .update(users)
    .set({ ...changes, version, updatedAt: now })
    .where(eq(users.id, id));
}

export async function setBlindIndex(tx: Transaction, id: string, blindIndex: Buffer): Promise<void> {
  await tx.update(users).set({ emailBlindIndex: blindIndex }).where(eq(users.id, id));
}

/** The accounts whose address is one of these. */
export async function accountsHoldingAddresses(
  tx: Transaction,
  blindIndexes: readonly Buffer[],
): Promise<AddressHolder[]> {
  if (blindIndexes.length === 0) return [];
  return tx
    .select({ id: users.id, emailBlindIndex: users.emailBlindIndex, emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(inArray(users.emailBlindIndex, [...blindIndexes]));
}

/** Deletes the accounts with everything they own; returns how many. */
export async function deleteAccounts(tx: Transaction, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const deleted = await tx
    .delete(users)
    .where(inArray(users.id, [...ids]))
    .returning({ id: users.id });
  return deleted.length;
}

export type PasskeyRow = typeof passkeys.$inferSelect;
export type TotpSecretRow = typeof totpSecrets.$inferSelect;
export type RecoveryCodeRow = typeof recoveryCodes.$inferSelect;
export type ConsentRow = typeof consents.$inferSelect;

/** An account's ways in besides the password: passkeys, the TOTP secret and the recovery codes (ADR-0019). */
export interface SignInRows {
  readonly passkeys: readonly PasskeyRow[];
  readonly totpSecrets: readonly TotpSecretRow[];
  readonly recoveryCodes: readonly RecoveryCodeRow[];
}

/** The sign-in-method rows of these accounts, each table in a fixed order. */
export async function readSignInRows(tx: Transaction, ids: readonly string[]): Promise<SignInRows> {
  if (ids.length === 0) return { passkeys: [], totpSecrets: [], recoveryCodes: [] };
  return {
    passkeys: await tx
      .select()
      .from(passkeys)
      .where(inArray(passkeys.userId, [...ids]))
      .orderBy(asc(passkeys.id)),
    totpSecrets: await tx
      .select()
      .from(totpSecrets)
      .where(inArray(totpSecrets.userId, [...ids]))
      .orderBy(asc(totpSecrets.userId)),
    recoveryCodes: await tx
      .select()
      .from(recoveryCodes)
      .where(inArray(recoveryCodes.userId, [...ids]))
      .orderBy(asc(recoveryCodes.id)),
  };
}

/**
 * Replaces these accounts' sign-in-method rows with the given ones, which keep their IDs, so the data key and the
 * associated data of an encrypted name or secret still fit. All are deleted before any is inserted, so no unique
 * credential ID or code digest clashes on the way. The rows travel as JavaScript values: exact, because the app writes
 * every timestamp from its clock in milliseconds and no column has a database-side default time.
 */
export async function replaceSignInRows(tx: Transaction, ids: readonly string[], rows: SignInRows): Promise<void> {
  if (ids.length === 0) return;
  await tx.delete(passkeys).where(inArray(passkeys.userId, [...ids]));
  await tx.delete(totpSecrets).where(inArray(totpSecrets.userId, [...ids]));
  await tx.delete(recoveryCodes).where(inArray(recoveryCodes.userId, [...ids]));
  if (rows.passkeys.length > 0) await tx.insert(passkeys).values([...rows.passkeys]);
  if (rows.totpSecrets.length > 0) await tx.insert(totpSecrets).values([...rows.totpSecrets]);
  if (rows.recoveryCodes.length > 0) await tx.insert(recoveryCodes).values([...rows.recoveryCodes]);
}

export async function readConsents(tx: Transaction, ids: readonly string[]): Promise<ConsentRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(consents)
    .where(inArray(consents.userId, [...ids]))
    .orderBy(asc(consents.id));
}

/** Replaces these accounts' consent records with the given ones. */
export async function replaceConsents(
  tx: Transaction,
  ids: readonly string[],
  rows: readonly ConsentRow[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx.delete(consents).where(inArray(consents.userId, [...ids]));
  if (rows.length > 0) await tx.insert(consents).values([...rows]);
}

/** Deletes up to `limit` sessions with their tokens (cascade); returns how many. */
export async function deleteSessions(tx: Transaction, limit: number): Promise<number> {
  const batch = tx.select({ id: sessions.id }).from(sessions).limit(limit);
  const deleted = await tx.delete(sessions).where(inArray(sessions.id, batch)).returning({ id: sessions.id });
  return deleted.length;
}
