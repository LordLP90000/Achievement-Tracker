import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Transaction } from '../../platform/db/database.ts';
import { recoveryCodes, totpSecrets } from '../../platform/db/schema/index.ts';

/**
 * TOTP secrets and recovery codes (data-model §3.1). Both tables are under row-level security: the transaction must be
 * bound to the account first.
 */

export interface TotpSecretRecord {
  readonly secretEnc: Buffer;
  /** `null` until a code from the app confirmed the secret. */
  readonly enabledAt: Date | null;
  readonly lastUsedStep: number | null;
  readonly createdAt: Date;
}

/** Stores a new unconfirmed secret in place of an unconfirmed one; `false` while TOTP is on, and nothing changes. */
export async function storePendingTotpSecret(
  tx: Transaction,
  userId: string,
  secretEnc: Buffer,
  now: Date,
): Promise<boolean> {
  const stored = await tx
    .insert(totpSecrets)
    .values({ userId, secretEnc, createdAt: now })
    .onConflictDoUpdate({
      target: totpSecrets.userId,
      set: { secretEnc, createdAt: now, lastUsedStep: null },
      setWhere: isNull(totpSecrets.enabledAt),
    })
    .returning({ userId: totpSecrets.userId });
  return stored.length > 0;
}

/** The account's secret, locked until the transaction ends: nothing replaces or removes it meanwhile. */
export async function lockTotpSecret(tx: Transaction, userId: string): Promise<TotpSecretRecord | undefined> {
  const [row] = await tx
    .select({
      secretEnc: totpSecrets.secretEnc,
      enabledAt: totpSecrets.enabledAt,
      lastUsedStep: totpSecrets.lastUsedStep,
      createdAt: totpSecrets.createdAt,
    })
    .from(totpSecrets)
    .where(eq(totpSecrets.userId, userId))
    .for('update');
  return row;
}

/** Turns TOTP on; `step` is the time step of the confirming code, which can never be used again. */
export async function enableTotp(tx: Transaction, userId: string, step: number, now: Date): Promise<void> {
  await tx.update(totpSecrets).set({ enabledAt: now, lastUsedStep: step }).where(eq(totpSecrets.userId, userId));
}

/** Deletes the secret of an account with TOTP on; `false` while TOTP is off (an unconfirmed secret stays). */
export async function deleteEnabledTotpSecret(tx: Transaction, userId: string): Promise<boolean> {
  const deleted = await tx
    .delete(totpSecrets)
    .where(and(eq(totpSecrets.userId, userId), isNotNull(totpSecrets.enabledAt)))
    .returning({ userId: totpSecrets.userId });
  return deleted.length > 0;
}

/** The account's recovery codes become exactly these digests. */
export async function replaceRecoveryCodes(
  tx: Transaction,
  userId: string,
  hashes: readonly Buffer[],
  now: Date,
): Promise<void> {
  await deleteRecoveryCodes(tx, userId);
  await tx
    .insert(recoveryCodes)
    .values(hashes.map((codeHash) => ({ id: randomUUID(), userId, codeHash, createdAt: now })));
}

export async function deleteRecoveryCodes(tx: Transaction, userId: string): Promise<void> {
  await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
}
