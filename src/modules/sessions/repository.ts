import { and, asc, desc, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Transaction } from '../../platform/db/database.ts';
import { increment } from '../../platform/db/expressions.ts';
import { sessions, sessionTokens, users } from '../../platform/db/schema/index.ts';

/**
 * Device sessions and their token generations (data-model §3.1). `sessions` is under row-level security (bind the
 * user first); `session_tokens` and `users` are looked up by hash or blind index before the user is known.
 */

export type RevokedReason =
  | 'logout'
  | 'logout_all'
  | 'user_revoked'
  | 'password_changed'
  | 'password_reset'
  | 'refresh_reuse'
  | 'expired'
  | 'account_deleted'
  | 'session_limit';

export interface LoginAccount {
  readonly id: string;
  readonly passwordHash: string;
  readonly emailVerifiedAt: Date | null;
  readonly deactivatedAt: Date | null;
}

export interface NewSession {
  readonly id: string;
  readonly userId: string;
  readonly client: 'ios' | 'android';
  readonly deviceLabelEnc: Buffer | null;
  readonly absoluteExpiresAt: Date;
}

export interface NewTokenGeneration {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly generation: number;
  readonly accessTokenHash: Buffer;
  readonly accessExpiresAt: Date;
  readonly refreshTokenHash: Buffer;
  readonly refreshExpiresAt: Date;
}

const loginColumns = {
  id: users.id,
  passwordHash: users.passwordHash,
  emailVerifiedAt: users.emailVerifiedAt,
  deactivatedAt: users.deactivatedAt,
};

export async function findLoginAccount(tx: Transaction, blindIndex: Buffer): Promise<LoginAccount | undefined> {
  const [account] = await tx.select(loginColumns).from(users).where(eq(users.emailBlindIndex, blindIndex));
  return account;
}

/** Locks the account row for the rest of the transaction (serialises logins of one user) and returns it fresh. */
export async function lockLoginAccount(tx: Transaction, userId: string): Promise<LoginAccount | undefined> {
  const [account] = await tx.select(loginColumns).from(users).where(eq(users.id, userId)).for('update');
  return account;
}

export async function reactivateAccount(tx: Transaction, userId: string, now: Date): Promise<void> {
  await tx
    .update(users)
    .set({ deactivatedAt: null, updatedAt: now, version: increment(users.version) })
    .where(and(eq(users.id, userId), isNotNull(users.deactivatedAt)));
}

/** Stores a re-hash with current parameters; the password itself is unchanged, so is `password_changed_at`. */
export async function replacePasswordHash(
  tx: Transaction,
  userId: string,
  hashes: { readonly previous: string; readonly next: string },
  now: Date,
): Promise<void> {
  await tx
    .update(users)
    .set({ passwordHash: hashes.next, updatedAt: now })
    .where(and(eq(users.id, userId), eq(users.passwordHash, hashes.previous)));
}

/** Live sessions of the user, least recently used first. */
export async function liveSessionsByLeastRecentUse(tx: Transaction, userId: string, now: Date): Promise<string[]> {
  const rows = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.absoluteExpiresAt, now)))
    .orderBy(asc(sessions.lastUsedAt), asc(sessions.createdAt));
  return rows.map((row) => row.id);
}

/** Revokes the sessions and deletes their tokens at once (data-model §3.1); the session rows remain for 7 days. */
export async function revokeSessions(
  tx: Transaction,
  sessionIds: readonly string[],
  reason: RevokedReason,
  now: Date,
): Promise<void> {
  if (sessionIds.length === 0) return;
  await tx
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(inArray(sessions.id, [...sessionIds]), isNull(sessions.revokedAt)));
  await tx.delete(sessionTokens).where(inArray(sessionTokens.sessionId, [...sessionIds]));
}

export async function insertSession(tx: Transaction, session: NewSession, now: Date): Promise<void> {
  await tx.insert(sessions).values({ ...session, createdAt: now, lastUsedAt: now, lastReauthAt: now });
}

export async function insertTokenGeneration(tx: Transaction, tokens: NewTokenGeneration, now: Date): Promise<void> {
  await tx.insert(sessionTokens).values({ ...tokens, createdAt: now });
}

export interface TokenGeneration {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly generation: number;
  readonly refreshExpiresAt: Date;
  readonly rotatedAt: Date | null;
}

export interface LiveSession {
  readonly id: string;
  readonly userId: string;
  readonly lastReauthAt: Date;
  readonly absoluteExpiresAt: Date;
}

/** The generation a refresh token belongs to, locked so that concurrent uses of one token are serialised. */
export async function lockGenerationByRefreshHash(
  tx: Transaction,
  refreshTokenHash: Buffer,
): Promise<TokenGeneration | undefined> {
  const [generation] = await tx
    .select({
      id: sessionTokens.id,
      sessionId: sessionTokens.sessionId,
      userId: sessionTokens.userId,
      generation: sessionTokens.generation,
      refreshExpiresAt: sessionTokens.refreshExpiresAt,
      rotatedAt: sessionTokens.rotatedAt,
    })
    .from(sessionTokens)
    .where(eq(sessionTokens.refreshTokenHash, refreshTokenHash))
    .for('update');
  return generation;
}

export async function markGenerationRotated(tx: Transaction, generationId: string, now: Date): Promise<void> {
  await tx.update(sessionTokens).set({ rotatedAt: now }).where(eq(sessionTokens.id, generationId));
}

/** The session unless it was revoked or reached its absolute expiry. */
export async function findLiveSession(tx: Transaction, sessionId: string, now: Date): Promise<LiveSession | undefined> {
  const [session] = await tx
    .select({
      id: sessions.id,
      userId: sessions.userId,
      lastReauthAt: sessions.lastReauthAt,
      absoluteExpiresAt: sessions.absoluteExpiresAt,
    })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt), gt(sessions.absoluteExpiresAt, now)));
  return session;
}

/** `last_used_at` follows logins and refreshes (every ≤ 15 minutes while the app is in use), not every request. */
export async function touchSession(tx: Transaction, sessionId: string, now: Date): Promise<void> {
  await tx.update(sessions).set({ lastUsedAt: now }).where(eq(sessions.id, sessionId));
}

/** The session and user of an unexpired access token (RLS-exempt lookup by hash; the session is checked next). */
export async function findAccessToken(
  tx: Transaction,
  accessTokenHash: Buffer,
  now: Date,
): Promise<{ readonly sessionId: string; readonly userId: string } | undefined> {
  const [token] = await tx
    .select({ sessionId: sessionTokens.sessionId, userId: sessionTokens.userId })
    .from(sessionTokens)
    .where(and(eq(sessionTokens.accessTokenHash, accessTokenHash), gt(sessionTokens.accessExpiresAt, now)));
  return token;
}

/** Revokes every session of the user that is not revoked yet and deletes all their tokens. */
export async function revokeAllSessions(
  tx: Transaction,
  userId: string,
  reason: RevokedReason,
  now: Date,
): Promise<void> {
  await tx
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  await tx.delete(sessionTokens).where(eq(sessionTokens.userId, userId));
}

export interface SessionRecord {
  readonly id: string;
  readonly client: 'ios' | 'android';
  readonly deviceLabelEnc: Buffer | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
}

/** Sessions that can still be used: not revoked, before the absolute expiry, with an unexpired refresh token. */
export async function listActiveSessions(tx: Transaction, userId: string, now: Date): Promise<SessionRecord[]> {
  const refreshable = tx
    .select({ sessionId: sessionTokens.sessionId })
    .from(sessionTokens)
    .where(and(eq(sessionTokens.userId, userId), gt(sessionTokens.refreshExpiresAt, now)));
  const rows = await tx
    .select({
      id: sessions.id,
      client: sessions.client,
      deviceLabelEnc: sessions.deviceLabelEnc,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.absoluteExpiresAt, now),
        inArray(sessions.id, refreshable),
      ),
    )
    .orderBy(desc(sessions.createdAt));
  return rows.map((row) => ({ ...row, client: row.client as SessionRecord['client'] }));
}

/** Revokes one of the user's live sessions and deletes its tokens; false when there is no such session. */
export async function revokeLiveSession(
  tx: Transaction,
  ids: { readonly userId: string; readonly sessionId: string },
  reason: RevokedReason,
  now: Date,
): Promise<boolean> {
  const revoked = await tx
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(
      and(
        eq(sessions.id, ids.sessionId),
        eq(sessions.userId, ids.userId),
        isNull(sessions.revokedAt),
        gt(sessions.absoluteExpiresAt, now),
      ),
    )
    .returning({ id: sessions.id });
  if (revoked.length === 0) return false;
  await tx.delete(sessionTokens).where(eq(sessionTokens.sessionId, ids.sessionId));
  return true;
}

export async function findPasswordHash(tx: Transaction, userId: string): Promise<string | undefined> {
  const [user] = await tx.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId));
  return user?.passwordHash;
}

/** R-AUTH-06: the session entered the password just now. */
export async function markReauthenticated(tx: Transaction, sessionId: string, now: Date): Promise<void> {
  await tx.update(sessions).set({ lastReauthAt: now }).where(eq(sessions.id, sessionId));
}
