import { and, eq, gt, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { WrappedKey } from '../../platform/crypto/key-wrapper.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { increment } from '../../platform/db/expressions.ts';
import { oneTimeTokens, userKeys, users } from '../../platform/db/schema/index.ts';

/** Account rows (data-model §3.1). `user_keys` is under row-level security: set the user context first. */

export interface AccountRecord {
  readonly id: string;
  readonly emailEnc: Buffer;
  readonly locale: string;
  readonly emailVerifiedAt: Date | null;
  readonly deactivatedAt: Date | null;
}

export interface NewAccount {
  readonly id: string;
  readonly emailEnc: Buffer;
  readonly emailBlindIndex: Buffer;
  readonly passwordHash: string;
  readonly timezone: string;
  readonly locale: string;
  readonly privacyPolicyVersion: string;
}

export type OneTimeTokenPurpose = 'verify_email' | 'change_email' | 'reset_password';

/** The account's data key is missing: its encrypted fields cannot be read, so the request fails closed. */
export class MissingDataKeyError extends Error {
  override readonly name = 'MissingDataKeyError';

  constructor() {
    super('account has no data key');
  }
}

export async function findAccountByBlindIndex(tx: Transaction, blindIndex: Buffer): Promise<AccountRecord | undefined> {
  const [account] = await tx
    .select({
      id: users.id,
      emailEnc: users.emailEnc,
      locale: users.locale,
      emailVerifiedAt: users.emailVerifiedAt,
      deactivatedAt: users.deactivatedAt,
    })
    .from(users)
    .where(eq(users.emailBlindIndex, blindIndex));
  return account;
}

/** Creates the account unless its address is taken (also by a concurrent registration); true when created. */
export async function insertAccount(tx: Transaction, account: NewAccount, now: Date): Promise<boolean> {
  const created = await tx
    .insert(users)
    .values({
      ...account,
      ageConfirmed: true,
      passwordChangedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: users.emailBlindIndex })
    .returning({ id: users.id });
  return created.length === 1;
}

export async function insertUserKey(tx: Transaction, userId: string, wrapped: WrappedKey, now: Date): Promise<void> {
  await tx.insert(userKeys).values({
    userId,
    wrappedDek: wrapped.blob,
    kekId: wrapped.kekId,
    kekVersion: wrapped.kekVersion,
    createdAt: now,
  });
}

export async function requireWrappedKey(tx: Transaction, userId: string): Promise<WrappedKey> {
  const [key] = await tx
    .select({ blob: userKeys.wrappedDek, kekId: userKeys.kekId, kekVersion: userKeys.kekVersion })
    .from(userKeys)
    .where(eq(userKeys.userId, userId));
  if (key === undefined) throw new MissingDataKeyError();
  return key;
}

/** Stores a new single-use token; unused tokens of the same purpose stop working (the newest email wins). */
export async function replaceOneTimeToken(
  tx: Transaction,
  token: { userId: string; purpose: OneTimeTokenPurpose; tokenHash: Buffer; expiresAt: Date },
  now: Date,
): Promise<void> {
  await tx
    .delete(oneTimeTokens)
    .where(
      and(
        eq(oneTimeTokens.userId, token.userId),
        eq(oneTimeTokens.purpose, token.purpose),
        isNull(oneTimeTokens.usedAt),
      ),
    );
  await tx.insert(oneTimeTokens).values({ id: randomUUID(), ...token, createdAt: now });
}

/** Marks an unused, unexpired token as used and returns its user; a token can be consumed exactly once. */
export async function consumeOneTimeToken(
  tx: Transaction,
  purpose: OneTimeTokenPurpose,
  tokenHash: Buffer,
  now: Date,
): Promise<string | undefined> {
  const [consumed] = await tx
    .update(oneTimeTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(oneTimeTokens.tokenHash, tokenHash),
        eq(oneTimeTokens.purpose, purpose),
        isNull(oneTimeTokens.usedAt),
        gt(oneTimeTokens.expiresAt, now),
      ),
    )
    .returning({ userId: oneTimeTokens.userId });
  return consumed?.userId;
}

export async function isOneTimeTokenUsed(
  tx: Transaction,
  purpose: OneTimeTokenPurpose,
  tokenHash: Buffer,
): Promise<boolean> {
  const [token] = await tx
    .select({ usedAt: oneTimeTokens.usedAt })
    .from(oneTimeTokens)
    .where(and(eq(oneTimeTokens.tokenHash, tokenHash), eq(oneTimeTokens.purpose, purpose)));
  return token !== undefined && token.usedAt !== null;
}

/** True when the address was unverified until now. */
export async function markEmailVerified(tx: Transaction, userId: string, now: Date): Promise<boolean> {
  const updated = await tx
    .update(users)
    .set({ emailVerifiedAt: now, updatedAt: now, version: increment(users.version) })
    .where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)))
    .returning({ id: users.id });
  return updated.length === 1;
}
