import { asc, eq, gt, inArray } from 'drizzle-orm';
import type { Transaction } from '../../platform/db/database.ts';
import { sessions, users } from '../../platform/db/schema/index.ts';

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

/** Deletes up to `limit` sessions with their tokens (cascade); returns how many. */
export async function deleteSessions(tx: Transaction, limit: number): Promise<number> {
  const batch = tx.select({ id: sessions.id }).from(sessions).limit(limit);
  const deleted = await tx.delete(sessions).where(inArray(sessions.id, batch)).returning({ id: sessions.id });
  return deleted.length;
}
