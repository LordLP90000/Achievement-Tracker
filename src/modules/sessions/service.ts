import { randomUUID } from 'node:crypto';
import { emailBlindIndex } from '../../platform/crypto/blind-index.ts';
import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { encryptText } from '../../platform/crypto/field-cipher.ts';
import type { PasswordHasher } from '../../platform/crypto/password.ts';
import { issueToken, tokenHash } from '../../platform/crypto/tokens.ts';
import { inTransaction, setUserContext, type Database, type Transaction } from '../../platform/db/database.ts';
import type { Clock } from '../../platform/time/clock.ts';
import { requireWrappedKey } from '../accounts/repository.ts';
import type { RequestContext } from '../audit/context.ts';
import { recordAuditEvent, type AuditEvent } from '../audit/repository.ts';
import {
  findLiveSession,
  findLoginAccount,
  insertSession,
  insertTokenGeneration,
  liveSessionsByLeastRecentUse,
  lockGenerationByRefreshHash,
  lockLoginAccount,
  markGenerationRotated,
  reactivateAccount,
  replacePasswordHash,
  revokeSessions,
  touchSession,
  type LoginAccount,
} from './repository.ts';
import type { LoginRequest } from './schemas.ts';

/** Login and device sessions (R-AUTH-04, -09, -10; R-PRIV-06; Q-29). */

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const ACCESS_TOKEN_LIFETIME_MS = 15 * MINUTE_MS;
export const REFRESH_TOKEN_LIFETIME_MS = 30 * DAY_MS;
export const SESSION_LIFETIME_MS = 180 * DAY_MS;
/** R-IN-01 / Q-16: a login beyond this many live sessions logs out the least recently used one (Q-29). */
export const MAX_SESSIONS = 20;
/** R-PRIV-06: an account pending deletion can be reactivated by logging in within this period. */
export const DELETION_GRACE_MS = 30 * DAY_MS;

export interface SessionsServiceDependencies {
  readonly db: Database;
  readonly clock: Clock;
  readonly hasher: PasswordHasher;
  readonly blindIndexKey: Uint8Array;
  readonly dataKeys: DataKeys;
}

/** The tokens of one session generation, handed to the client once and stored only as hashes. */
export interface IssuedTokens {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
  readonly issuedAt: Date;
}

export type LoginResult =
  | { readonly outcome: 'signed_in'; readonly tokens: IssuedTokens }
  | { readonly outcome: 'invalid_credentials' }
  | { readonly outcome: 'email_not_verified' };

export interface SessionsService {
  login(request: LoginRequest, context: RequestContext): Promise<LoginResult>;
  /** A new token pair for the session, or `undefined` for an unknown, expired, reused or foreign token. */
  refresh(refreshToken: string, context: RequestContext): Promise<IssuedTokens | undefined>;
}

const INVALID_CREDENTIALS = Object.freeze({ outcome: 'invalid_credentials' as const });

/** Past the grace period an account pending deletion counts as deleted, even before the purge job ran. */
const isGone = (account: LoginAccount | undefined, now: Date): boolean => {
  const requested = account?.deactivatedAt ?? null;
  return requested !== null && requested.getTime() <= now.getTime() - DELETION_GRACE_MS;
};

export function createSessionsService(deps: SessionsServiceDependencies): SessionsService {
  const audit = async (tx: Transaction, event: AuditEvent, now: Date): Promise<void> => {
    if (event.userId !== null) await setUserContext(tx, event.userId);
    await recordAuditEvent(tx, event, now);
  };

  const issueGeneration = async (
    tx: Transaction,
    session: { sessionId: string; userId: string; generation: number; absoluteExpiresAt: Date },
    now: Date,
  ): Promise<IssuedTokens> => {
    const access = issueToken('access');
    const refresh = issueToken('refresh');
    const cap = session.absoluteExpiresAt.getTime();
    const tokens: IssuedTokens = {
      sessionId: session.sessionId,
      accessToken: access.token,
      accessExpiresAt: new Date(Math.min(now.getTime() + ACCESS_TOKEN_LIFETIME_MS, cap)),
      refreshToken: refresh.token,
      refreshExpiresAt: new Date(Math.min(now.getTime() + REFRESH_TOKEN_LIFETIME_MS, cap)),
      issuedAt: now,
    };
    await insertTokenGeneration(
      tx,
      {
        id: randomUUID(),
        sessionId: session.sessionId,
        userId: session.userId,
        generation: session.generation,
        accessTokenHash: access.hash,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshTokenHash: refresh.hash,
        refreshExpiresAt: tokens.refreshExpiresAt,
      },
      now,
    );
    return tokens;
  };

  const encryptDeviceLabel = async (
    tx: Transaction,
    ids: { userId: string; sessionId: string },
    label: string | undefined,
  ): Promise<Buffer | null> => {
    if (label === undefined) return null;
    const wrapped = await requireWrappedKey(tx, ids.userId);
    return deps.dataKeys.withKey(ids.userId, wrapped, (dataKey) =>
      Promise.resolve(encryptText(dataKey, { ...ids, recordId: ids.sessionId, field: 'device_label_enc' }, label)),
    );
  };

  /** Q-29: makes room for one more session by logging out the least recently used ones. */
  const enforceSessionLimit = async (
    tx: Transaction,
    userId: string,
    context: RequestContext,
    now: Date,
  ): Promise<void> => {
    const live = await liveSessionsByLeastRecentUse(tx, userId, now);
    const evicted = live.slice(0, Math.max(0, live.length - (MAX_SESSIONS - 1)));
    await revokeSessions(tx, evicted, 'session_limit', now);
    for (const sessionId of evicted) {
      await audit(
        tx,
        {
          userId,
          eventType: 'session_revoked',
          outcome: 'success',
          ipPrefix: context.ipPrefix,
          client: null,
          sessionId,
          metadata: { reason: 'session_limit' },
        },
        now,
      );
    }
  };

  const failedLogin = async (
    userId: string | null,
    request: LoginRequest,
    context: RequestContext,
    now: Date,
    metadata: Readonly<Record<string, string>> = {},
  ): Promise<void> => {
    await inTransaction(deps.db, (tx) =>
      audit(
        tx,
        {
          userId,
          eventType: 'login_failed',
          outcome: 'failure',
          ipPrefix: context.ipPrefix,
          client: request.client,
          metadata,
        },
        now,
      ),
    );
  };

  return {
    async login(request, context) {
      const now = deps.clock.now();
      const blindIndex = emailBlindIndex(deps.blindIndexKey, request.email);
      const found = await inTransaction(deps.db, (tx) => findLoginAccount(tx, blindIndex));
      const account = isGone(found, now) ? undefined : found;
      // One Argon2id verification whether or not the account exists (R-AUTH-07, S-02).
      const valid = await deps.hasher.verify(account?.passwordHash, request.password);
      if (account === undefined || !valid) {
        await failedLogin(account?.id ?? null, request, context, now);
        return INVALID_CREDENTIALS;
      }
      // Disclosed only to someone who knows the password (I-05).
      if (account.emailVerifiedAt === null) {
        await failedLogin(account.id, request, context, now, { reason: 'email_not_verified' });
        return { outcome: 'email_not_verified' };
      }
      const rehash = deps.hasher.needsRehash(account.passwordHash)
        ? await deps.hasher.hash(request.password)
        : undefined;

      return inTransaction(deps.db, async (tx) => {
        await setUserContext(tx, account.id);
        const current = await lockLoginAccount(tx, account.id);
        // The password was changed (or the account deleted) while it was being verified: the old one is void.
        if (current?.passwordHash !== account.passwordHash || isGone(current, now)) return INVALID_CREDENTIALS;
        if (current.deactivatedAt !== null) {
          await reactivateAccount(tx, account.id, now);
          await audit(
            tx,
            {
              userId: account.id,
              eventType: 'account_reactivated',
              outcome: 'success',
              ...requestOf(context, request),
            },
            now,
          );
        }
        if (rehash !== undefined) {
          await replacePasswordHash(tx, account.id, { previous: account.passwordHash, next: rehash }, now);
        }
        await enforceSessionLimit(tx, account.id, context, now);

        const sessionId = randomUUID();
        const absoluteExpiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
        await insertSession(
          tx,
          {
            id: sessionId,
            userId: account.id,
            client: request.client,
            deviceLabelEnc: await encryptDeviceLabel(tx, { userId: account.id, sessionId }, request.device_label),
            absoluteExpiresAt,
          },
          now,
        );
        const tokens = await issueGeneration(
          tx,
          { sessionId, userId: account.id, generation: 1, absoluteExpiresAt },
          now,
        );
        await audit(
          tx,
          {
            userId: account.id,
            eventType: 'login_succeeded',
            outcome: 'success',
            sessionId,
            ...requestOf(context, request),
          },
          now,
        );
        return { outcome: 'signed_in', tokens };
      });
    },

    async refresh(refreshToken, context) {
      const hash = tokenHash('refresh', refreshToken);
      if (hash === undefined) return undefined;
      const now = deps.clock.now();

      return inTransaction(deps.db, async (tx) => {
        const used = await lockGenerationByRefreshHash(tx, hash);
        if (used === undefined) return undefined;
        await setUserContext(tx, used.userId);
        if (used.rotatedAt !== null) {
          // R-AUTH-04: a rotated token came back, so two parties hold this session — end it for both.
          await revokeSessions(tx, [used.sessionId], 'refresh_reuse', now);
          await audit(
            tx,
            {
              userId: used.userId,
              eventType: 'refresh_reuse_detected',
              outcome: 'failure',
              ipPrefix: context.ipPrefix,
              client: null,
              sessionId: used.sessionId,
            },
            now,
          );
          return undefined;
        }
        const session = await findLiveSession(tx, used.sessionId, now);
        if (session === undefined || used.refreshExpiresAt.getTime() <= now.getTime()) return undefined;
        await markGenerationRotated(tx, used.id, now);
        await touchSession(tx, session.id, now);
        return issueGeneration(
          tx,
          {
            sessionId: session.id,
            userId: session.userId,
            generation: used.generation + 1,
            absoluteExpiresAt: session.absoluteExpiresAt,
          },
          now,
        );
      });
    },
  };
}

const requestOf = (context: RequestContext, request: LoginRequest) => ({
  ipPrefix: context.ipPrefix,
  client: request.client,
});
