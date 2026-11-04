import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import type { Transaction } from '../../platform/db/database.ts';
import { passkeys, recoveryCodes, totpSecrets, users, webauthnChallenges } from '../../platform/db/schema/index.ts';

/**
 * Passkeys, TOTP secrets and recovery codes (data-model §3.1), under row-level security: the transaction must be bound
 * to the account first. WebAuthn challenges are looked up by hash, before any account is known (⟂).
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

/** Whether TOTP is on for the account. */
export async function hasEnabledTotp(tx: Transaction, userId: string): Promise<boolean> {
  const rows = await tx
    .select({ userId: totpSecrets.userId })
    .from(totpSecrets)
    .where(and(eq(totpSecrets.userId, userId), isNotNull(totpSecrets.enabledAt)));
  return rows.length > 0;
}

/** Remembers the step of an accepted code: no code of it or an earlier step is accepted again. */
export async function recordTotpStep(tx: Transaction, userId: string, step: number): Promise<void> {
  await tx.update(totpSecrets).set({ lastUsedStep: step }).where(eq(totpSecrets.userId, userId));
}

/** Uses up the account's recovery code with this digest; `false` when it has none such (any more). */
export async function useRecoveryCode(tx: Transaction, userId: string, codeHash: Buffer): Promise<boolean> {
  const used = await tx
    .delete(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, codeHash)))
    .returning({ id: recoveryCodes.id });
  return used.length > 0;
}

export async function countRecoveryCodes(tx: Transaction, userId: string): Promise<number> {
  const rows = await tx.select({ id: recoveryCodes.id }).from(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  return rows.length;
}

/** Locks the account row: one change of its sign-in methods at a time, so a limit cannot be overrun. */
export async function lockAccount(tx: Transaction, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
}

export interface PasskeyRecord {
  readonly id: string;
  readonly credentialId: Buffer;
  readonly transports: readonly string[];
  readonly backedUp: boolean;
  readonly nameEnc: Buffer | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

/** The account's passkeys, newest first. */
export async function listPasskeys(tx: Transaction, userId: string): Promise<PasskeyRecord[]> {
  return tx
    .select({
      id: passkeys.id,
      credentialId: passkeys.credentialId,
      transports: passkeys.transports,
      backedUp: passkeys.backedUp,
      nameEnc: passkeys.nameEnc,
      createdAt: passkeys.createdAt,
      lastUsedAt: passkeys.lastUsedAt,
    })
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .orderBy(desc(passkeys.createdAt), desc(passkeys.id));
}

export interface NewPasskey {
  readonly id: string;
  readonly userId: string;
  readonly credentialId: Buffer;
  readonly publicKey: Buffer;
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly backedUp: boolean;
  readonly nameEnc: Buffer | null;
}

/** Stores the passkey; `false` when its credential is registered already, to this account or another. */
export async function insertPasskey(tx: Transaction, passkey: NewPasskey, now: Date): Promise<boolean> {
  const inserted = await tx
    .insert(passkeys)
    .values({ ...passkey, transports: [...passkey.transports], createdAt: now })
    .onConflictDoNothing({ target: passkeys.credentialId })
    .returning({ id: passkeys.id });
  return inserted.length > 0;
}

export async function deletePasskey(tx: Transaction, userId: string, passkeyId: string): Promise<boolean> {
  const deleted = await tx
    .delete(passkeys)
    .where(and(eq(passkeys.userId, userId), eq(passkeys.id, passkeyId)))
    .returning({ id: passkeys.id });
  return deleted.length > 0;
}

export interface NewWebauthnChallenge {
  readonly challengeHash: Buffer;
  readonly purpose: 'registration' | 'authentication';
  /** The account a registration is for; `null` for sign-in and step-up challenges. */
  readonly userId: string | null;
  readonly expiresAt: Date;
}

export async function insertWebauthnChallenge(
  tx: Transaction,
  challenge: NewWebauthnChallenge,
  now: Date,
): Promise<void> {
  await tx.insert(webauthnChallenges).values({ id: randomUUID(), ...challenge, createdAt: now });
}

/** Uses up the account's unexpired registration challenge with this hash; `false` when there is none. */
export async function consumeRegistrationChallenge(
  tx: Transaction,
  challengeHash: Buffer,
  userId: string,
  now: Date,
): Promise<boolean> {
  const consumed = await tx
    .delete(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.challengeHash, challengeHash),
        // Only registration challenges name an account (the table's CHECK).
        eq(webauthnChallenges.userId, userId),
        gt(webauthnChallenges.expiresAt, now),
      ),
    )
    .returning({ id: webauthnChallenges.id });
  return consumed.length > 0;
}
