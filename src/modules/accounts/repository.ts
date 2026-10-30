import { and, eq, gt, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { WrappedKey } from '../../platform/crypto/key-wrapper.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { isUniqueViolation } from '../../platform/db/errors.ts';
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

export async function findAccountById(
  tx: Transaction,
  userId: string,
): Promise<(AccountRecord & { readonly passwordHash: string }) | undefined> {
  const [account] = await tx
    .select({
      id: users.id,
      emailEnc: users.emailEnc,
      locale: users.locale,
      emailVerifiedAt: users.emailVerifiedAt,
      deactivatedAt: users.deactivatedAt,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.id, userId));
  return account;
}

/**
 * Stores a new password hash and `password_changed_at`. With `previous`, only if the stored hash is still that one
 * (a concurrent change wins); returns whether the password was changed.
 */
export async function changePasswordHash(
  tx: Transaction,
  userId: string,
  hashes: { readonly previous?: string; readonly next: string },
  now: Date,
): Promise<boolean> {
  const changed = await tx
    .update(users)
    .set({ passwordHash: hashes.next, passwordChangedAt: now, updatedAt: now })
    .where(
      and(eq(users.id, userId), hashes.previous === undefined ? undefined : eq(users.passwordHash, hashes.previous)),
    )
    .returning({ id: users.id });
  return changed.length === 1;
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

/** The wrapped data key with its version, which encrypted goal-content rows record as `dek_version` (ADR-0006). */
export async function requireVersionedKey(
  tx: Transaction,
  userId: string,
): Promise<{ readonly wrapped: WrappedKey; readonly version: number }> {
  const [key] = await tx
    .select({
      blob: userKeys.wrappedDek,
      kekId: userKeys.kekId,
      kekVersion: userKeys.kekVersion,
      dekVersion: userKeys.dekVersion,
    })
    .from(userKeys)
    .where(eq(userKeys.userId, userId));
  if (key === undefined) throw new MissingDataKeyError();
  const { dekVersion, ...wrapped } = key;
  return { wrapped, version: dekVersion };
}

export interface NewOneTimeToken {
  /** Generated here unless the caller needs it first (as associated data of `newEmailEnc`). */
  readonly id?: string;
  readonly userId: string;
  readonly purpose: OneTimeTokenPurpose;
  readonly tokenHash: Buffer;
  readonly expiresAt: Date;
  /** `change_email` only: the requested address, encrypted with the user's data key, and its blind index. */
  readonly newEmailEnc?: Buffer;
  readonly newEmailBlindIndex?: Buffer;
}

export interface ConsumedToken {
  readonly id: string;
  readonly userId: string;
  readonly newEmailEnc: Buffer | null;
  readonly newEmailBlindIndex: Buffer | null;
}

/** Stores a new single-use token; unused tokens of the same purpose stop working (the newest email wins). */
export async function replaceOneTimeToken(tx: Transaction, token: NewOneTimeToken, now: Date): Promise<void> {
  await tx
    .delete(oneTimeTokens)
    .where(
      and(
        eq(oneTimeTokens.userId, token.userId),
        eq(oneTimeTokens.purpose, token.purpose),
        isNull(oneTimeTokens.usedAt),
      ),
    );
  await tx.insert(oneTimeTokens).values({ ...token, id: token.id ?? randomUUID(), createdAt: now });
}

/** Marks an unused, unexpired token as used and returns it; a token can be consumed exactly once. */
export async function consumeOneTimeToken(
  tx: Transaction,
  purpose: OneTimeTokenPurpose,
  tokenHash: Buffer,
  now: Date,
): Promise<ConsumedToken | undefined> {
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
    .returning({
      id: oneTimeTokens.id,
      userId: oneTimeTokens.userId,
      newEmailEnc: oneTimeTokens.newEmailEnc,
      newEmailBlindIndex: oneTimeTokens.newEmailBlindIndex,
    });
  return consumed;
}

/** Voids every unused link of the user, e.g. reset links that went to an address the account no longer has. */
export async function deleteUnusedOneTimeTokens(tx: Transaction, userId: string): Promise<void> {
  await tx.delete(oneTimeTokens).where(and(eq(oneTimeTokens.userId, userId), isNull(oneTimeTokens.usedAt)));
}

/**
 * Moves the account to a new, verified address. Runs in a savepoint: if the address was registered meanwhile, the
 * unique blind index refuses it and `false` is returned with the outer transaction still usable.
 */
export async function changeEmail(
  tx: Transaction,
  userId: string,
  email: { readonly emailEnc: Buffer; readonly blindIndex: Buffer },
  now: Date,
): Promise<boolean> {
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint
        .update(users)
        .set({
          emailEnc: email.emailEnc,
          emailBlindIndex: email.blindIndex,
          emailVerifiedAt: now,
          updatedAt: now,
          version: increment(users.version),
        })
        .where(eq(users.id, userId));
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
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

/** True while the token is unused and unexpired; it is consumed later with `consumeOneTimeToken`. */
export async function isOneTimeTokenUsable(
  tx: Transaction,
  purpose: OneTimeTokenPurpose,
  tokenHash: Buffer,
  now: Date,
): Promise<boolean> {
  const [token] = await tx
    .select({ id: oneTimeTokens.id })
    .from(oneTimeTokens)
    .where(
      and(
        eq(oneTimeTokens.tokenHash, tokenHash),
        eq(oneTimeTokens.purpose, purpose),
        isNull(oneTimeTokens.usedAt),
        gt(oneTimeTokens.expiresAt, now),
      ),
    );
  return token !== undefined;
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

export interface Profile {
  readonly id: string;
  readonly emailEnc: Buffer;
  readonly nicknameEnc: Buffer | null;
  readonly timezone: string;
  readonly locale: string;
  readonly weekStart: string;
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
  readonly version: number;
}

export interface ProfileChanges {
  /** `null` removes the nickname; absent leaves it. */
  readonly nicknameEnc?: Buffer | null;
  readonly timezone?: string;
  readonly locale?: string;
  readonly weekStart?: string;
}

const profileColumns = {
  id: users.id,
  emailEnc: users.emailEnc,
  nicknameEnc: users.nicknameEnc,
  timezone: users.timezone,
  locale: users.locale,
  weekStart: users.weekStart,
  emailVerifiedAt: users.emailVerifiedAt,
  createdAt: users.createdAt,
  version: users.version,
};

export async function findProfile(tx: Transaction, userId: string): Promise<Profile | undefined> {
  const [profile] = await tx.select(profileColumns).from(users).where(eq(users.id, userId));
  return profile;
}

/** Applies the changes only at `expectedVersion` (ADR-0008); `undefined` when the version is no longer current. */
export async function updateProfile(
  tx: Transaction,
  userId: string,
  expectedVersion: number,
  changes: ProfileChanges,
  now: Date,
): Promise<Profile | undefined> {
  const [profile] = await tx
    .update(users)
    .set({ ...changes, updatedAt: now, version: increment(users.version) })
    .where(and(eq(users.id, userId), eq(users.version, expectedVersion)))
    .returning(profileColumns);
  return profile;
}
