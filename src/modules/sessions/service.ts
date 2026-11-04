import { randomUUID } from 'node:crypto';
import { emailBlindIndex, normalizeEmail } from '../../platform/crypto/blind-index.ts';
import { constantTimeEqual } from '../../platform/crypto/compare.ts';
import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { decryptText, encryptText } from '../../platform/crypto/field-cipher.ts';
import type { PasswordHasher } from '../../platform/crypto/password.ts';
import { issueToken, tokenHash } from '../../platform/crypto/tokens.ts';
import { inTransaction, setUserContext, type Database, type Transaction } from '../../platform/db/database.ts';
import type { WebAuthnConfig } from '../../platform/config/config.ts';
import type { Clock } from '../../platform/time/clock.ts';
import {
  challengeHash,
  claimedAssertion,
  issueChallenge as issueWebauthnChallenge,
  requestOptions,
  WEBAUTHN_TIMEOUT_MS,
  type PasskeyRequestOptions,
} from '../../platform/webauthn/webauthn.ts';
import { emailField, withAccountKey } from '../accounts/account-mail.ts';
import { findAccountById, requireWrappedKey } from '../accounts/repository.ts';
import type { RequestContext } from '../audit/context.ts';
import { recordAuditEvent, type AuditEvent, type AuditEventType } from '../audit/repository.ts';
import { queueSignInMethodsNotice } from '../sign-in-methods/notice.ts';
import { checkPasskeyAssertion } from '../sign-in-methods/passkey-assertion.ts';
import {
  consumeAuthenticationChallenge,
  hasEnabledTotp,
  insertWebauthnChallenge,
} from '../sign-in-methods/repository.ts';
import type { PasskeyAssertion } from '../sign-in-methods/schemas.ts';
import {
  checkSecondFactor,
  secondFactorMethods,
  type SecondFactor,
  type SecondFactorCheck,
  type SecondFactorMethod,
} from '../sign-in-methods/second-factor.ts';
import type { Authenticator, Principal } from './guard.ts';
import {
  countSecondFactorFailure,
  deleteSecondFactorChallenge,
  findAccessToken,
  findLiveSession,
  findLoginAccount,
  findPasswordHash,
  findSecondFactorChallenge,
  insertSecondFactorChallenge,
  insertSession,
  insertTokenGeneration,
  listActiveSessions,
  liveSessionsByLeastRecentUse,
  lockGenerationByRefreshHash,
  lockLoginAccount,
  markGenerationRotated,
  markReauthenticated,
  reactivateAccount,
  replacePasswordHash,
  revokeAllSessions,
  revokeLiveSession,
  revokeSessions,
  touchSession,
  type AuthMethod,
  type LoginAccount,
} from './repository.ts';
import type { LoginRequest, PasskeyLoginRequest, SecondFactorLoginRequest, StepUp } from './schemas.ts';

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
  /** The passkey relying party (ADR-0019, Q-51). */
  readonly webauthn: WebAuthnConfig;
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
  | { readonly outcome: 'second_factor_required'; readonly challenge: IssuedSecondFactorChallenge }
  | { readonly outcome: 'invalid_credentials' }
  | { readonly outcome: 'email_not_verified' };

/** The first login step's answer with TOTP on (ADR-0019): a token for the second step, handed out once. */
export interface IssuedSecondFactorChallenge {
  readonly token: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly methods: readonly SecondFactorMethod[];
}

export type SecondFactorLoginResult =
  | { readonly outcome: 'signed_in'; readonly tokens: IssuedTokens }
  /** Unknown, expired, used up, or void since: the password changed, TOTP was turned off, the account is gone. */
  | { readonly outcome: 'invalid_token' }
  | { readonly outcome: 'invalid_code' };

export type PasskeyLoginResult =
  { readonly outcome: 'signed_in'; readonly tokens: IssuedTokens } | { readonly outcome: 'invalid_credentials' };

export type PasswordStepUp = Extract<StepUp, { readonly method: 'password' }>;

/** `second_factor_required`: TOTP is on and no code came, so the step-up checked nothing and nothing counts. */
export type ReauthResult = 'reauthenticated' | 'invalid_credentials' | 'second_factor_required';

export interface SessionsService extends Authenticator {
  login(request: LoginRequest, context: RequestContext): Promise<LoginResult>;
  /** The backoff subject of a usable second-factor token: its account's normalised address, as the login keys it. */
  secondFactorSubject(token: string): Promise<string | undefined>;
  /** Request options with a fresh challenge for a passkey sign-in or step-up; they name no account. */
  passkeyOptions(): Promise<PasskeyRequestOptions>;
  /** Signs in with a passkey of the account its user handle names (ADR-0019); every failure looks the same. */
  loginWithPasskey(request: PasskeyLoginRequest, context: RequestContext): Promise<PasskeyLoginResult>;
  /** Completes a login with TOTP on (ADR-0019); a wrong code counts against the token (at most 5) and is audited. */
  loginSecondFactor(request: SecondFactorLoginRequest, context: RequestContext): Promise<SecondFactorLoginResult>;
  /** A new token pair for the session, or `undefined` for an unknown, expired, reused or foreign token. */
  refresh(refreshToken: string, context: RequestContext): Promise<IssuedTokens | undefined>;
  /** Ends the principal's session (R-AUTH-05). */
  logout(principal: Principal, context: RequestContext): Promise<void>;
  /** Ends every session of the principal's user, the current one included (R-AUTH-05). */
  logoutAll(principal: Principal, context: RequestContext): Promise<void>;
  /** The user's active sessions, newest first (R-AUTH-05). */
  listSessions(principal: Principal): Promise<SessionView[]>;
  /** Ends one of the user's active sessions; false when there is no such session (→ 404). */
  revokeSession(principal: Principal, sessionId: string, context: RequestContext): Promise<boolean>;
  /**
   * The password entered again unlocks sensitive operations for 10 minutes (R-AUTH-06); with TOTP on only with the
   * app's code or a recovery code (ADR-0019), whose absence is named before the password is checked.
   */
  reauthenticate(principal: Principal, stepUp: PasswordStepUp, context: RequestContext): Promise<ReauthResult>;
  /** A passkey of the principal's own account unlocks them as well, with no code (ADR-0019); false for any failure. */
  reauthenticateWithPasskey(
    principal: Principal,
    credential: PasskeyAssertion,
    context: RequestContext,
  ): Promise<boolean>;
}

export interface SessionView {
  readonly id: string;
  readonly client: 'ios' | 'android';
  readonly deviceLabel: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  /** How it signed in (ADR-0019). */
  readonly authMethod: AuthMethod;
  readonly current: boolean;
}

const INVALID_CREDENTIALS = Object.freeze({ outcome: 'invalid_credentials' as const });
const INVALID_TOKEN = Object.freeze({ outcome: 'invalid_token' as const });

/** ADR-0019: the second login step's token lives 5 minutes and takes at most 5 wrong codes. */
export const SECOND_FACTOR_LIFETIME_MS = 5 * MINUTE_MS;
export const MAX_SECOND_FACTOR_FAILURES = 5;

/**
 * From 30 days after its deletion request on, an account counts as deleted even before the purge job ran: no login
 * and no password reset brings it back (R-PRIV-06, Q-48).
 */
export const isPastDeletionDeadline = (deactivatedAt: Date | null, now: Date): boolean =>
  deactivatedAt !== null && deactivatedAt.getTime() <= now.getTime() - DELETION_GRACE_MS;

const isGone = (account: LoginAccount | undefined, now: Date): boolean =>
  isPastDeletionDeadline(account?.deactivatedAt ?? null, now);

export function createSessionsService(deps: SessionsServiceDependencies): SessionsService {
  const audit = async (tx: Transaction, event: AuditEvent, now: Date): Promise<void> => {
    if (event.userId !== null) await setUserContext(tx, event.userId);
    await recordAuditEvent(tx, event, now);
  };

  /** Checks a code and uses it up; a used recovery code changes the sign-in methods, so the owner hears of it. */
  const useSecondFactor = async (
    tx: Transaction,
    userId: string,
    factor: SecondFactor,
    now: Date,
  ): Promise<SecondFactorCheck> =>
    deps.dataKeys.withKey(userId, await requireWrappedKey(tx, userId), async (dataKey) => {
      const result = await checkSecondFactor(tx, dataKey, userId, factor, now);
      if (result === 'recovery_code') await queueSignInMethodsNotice(tx, dataKey, userId, now);
      return result;
    });

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

  /**
   * Opens the device session of a completed login — by password, a second factor or a passkey — in the transaction
   * that holds the account row: reactivates an account pending deletion (R-PRIV-06), makes room under the session
   * limit (Q-29), issues the first token generation and audits the login.
   */
  const signIn = async (
    tx: Transaction,
    account: LoginAccount,
    device: { readonly client: 'ios' | 'android'; readonly deviceLabel: string | undefined },
    authMethod: AuthMethod,
    context: RequestContext,
    now: Date,
  ): Promise<IssuedTokens> => {
    const userId = account.id;
    if (account.deactivatedAt !== null) {
      await reactivateAccount(tx, userId, now);
      await audit(
        tx,
        { userId, eventType: 'account_reactivated', outcome: 'success', ...requestOf(context, device) },
        now,
      );
    }
    await enforceSessionLimit(tx, userId, context, now);
    const sessionId = randomUUID();
    const absoluteExpiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    await insertSession(
      tx,
      {
        id: sessionId,
        userId,
        client: device.client,
        deviceLabelEnc: await encryptDeviceLabel(tx, { userId, sessionId }, device.deviceLabel),
        absoluteExpiresAt,
        authMethod,
      },
      now,
    );
    const tokens = await issueGeneration(tx, { sessionId, userId, generation: 1, absoluteExpiresAt }, now);
    await audit(
      tx,
      { userId, eventType: 'login_succeeded', outcome: 'success', sessionId, ...requestOf(context, device) },
      now,
    );
    return tokens;
  };

  /** The token of the second login step, stored as its hash only (ADR-0019). */
  const issueChallenge = async (
    tx: Transaction,
    userId: string,
    methods: readonly SecondFactorMethod[],
    now: Date,
  ): Promise<IssuedSecondFactorChallenge> => {
    const { token, hash } = issueToken('secondFactor');
    const expiresAt = new Date(now.getTime() + SECOND_FACTOR_LIFETIME_MS);
    await insertSecondFactorChallenge(tx, { userId, tokenHash: hash, expiresAt }, now);
    return { token, issuedAt: now, expiresAt, methods };
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
        const unchanged =
          current !== undefined &&
          constantTimeEqual(Buffer.from(current.passwordHash), Buffer.from(account.passwordHash));
        if (!unchanged || isGone(current, now)) return INVALID_CREDENTIALS;
        if (rehash !== undefined) {
          await replacePasswordHash(tx, account.id, { previous: account.passwordHash, next: rehash }, now);
        }
        // TOTP on: no session yet, and no reactivation either — both wait for the second step (ADR-0019).
        const methods = await secondFactorMethods(tx, account.id);
        if (methods !== undefined) {
          return { outcome: 'second_factor_required', challenge: await issueChallenge(tx, account.id, methods, now) };
        }
        const device = { client: request.client, deviceLabel: request.device_label };
        return { outcome: 'signed_in', tokens: await signIn(tx, current, device, 'password', context, now) };
      });
    },

    async passkeyOptions() {
      const now = deps.clock.now();
      const { challenge, hash } = issueWebauthnChallenge();
      await inTransaction(deps.db, (tx) =>
        insertWebauthnChallenge(
          tx,
          {
            challengeHash: hash,
            purpose: 'authentication',
            userId: null,
            expiresAt: new Date(now.getTime() + WEBAUTHN_TIMEOUT_MS),
          },
          now,
        ),
      );
      return requestOptions(deps.webauthn, challenge);
    },

    async loginWithPasskey(request, context) {
      const now = deps.clock.now();
      const claim = claimedAssertion(request.credential);
      const hash = claim === undefined ? undefined : challengeHash(claim.challenge);
      if (claim === undefined || hash === undefined) return INVALID_CREDENTIALS;
      const device = { client: request.client, deviceLabel: request.device_label };

      return inTransaction(deps.db, async (tx): Promise<PasskeyLoginResult> => {
        // Used up whatever follows; committed with the answer, also a refusal.
        if (!(await consumeAuthenticationChallenge(tx, hash, now))) return INVALID_CREDENTIALS;
        // The user handle names the account; under its context another account's credential is not found.
        await setUserContext(tx, claim.userId);
        const account = await lockLoginAccount(tx, claim.userId);
        const usable = account !== undefined && !isGone(account, now) && account.emailVerifiedAt !== null;
        const check = usable
          ? await checkPasskeyAssertion(tx, deps.webauthn, request.credential, claim, now)
          : 'invalid';
        if (account === undefined || check !== 'verified') {
          await audit(
            tx,
            {
              userId: account?.id ?? null,
              eventType: check === 'counter_not_increased' ? 'passkey_clone_suspected' : 'login_failed',
              outcome: 'failure',
              ...requestOf(context, device),
              ...(check === 'counter_not_increased' ? {} : { metadata: BY_PASSKEY }),
            },
            now,
          );
          return INVALID_CREDENTIALS;
        }
        return { outcome: 'signed_in', tokens: await signIn(tx, account, device, 'passkey', context, now) };
      });
    },

    async secondFactorSubject(token) {
      const hash = tokenHash('secondFactor', token);
      if (hash === undefined) return undefined;
      const now = deps.clock.now();
      return inTransaction(deps.db, async (tx) => {
        const challenge = await findSecondFactorChallenge(tx, hash, now, MAX_SECOND_FACTOR_FAILURES);
        if (challenge === undefined) return undefined;
        const account = await findAccountById(tx, challenge.userId);
        if (account === undefined) return undefined;
        const address = await withAccountKey(tx, deps.dataKeys, challenge.userId, (dataKey) =>
          Promise.resolve(decryptText(dataKey, emailField(challenge.userId), account.emailEnc)),
        );
        return normalizeEmail(address);
      });
    },

    async loginSecondFactor(request, context) {
      const hash = tokenHash('secondFactor', request.second_factor_token);
      if (hash === undefined) return INVALID_TOKEN;
      const now = deps.clock.now();
      const factor: SecondFactor =
        request.totp_code === undefined
          ? { recoveryCode: request.recovery_code ?? '' }
          : { totpCode: request.totp_code };

      return inTransaction(deps.db, async (tx): Promise<SecondFactorLoginResult> => {
        const pending = await findSecondFactorChallenge(tx, hash, now, MAX_SECOND_FACTOR_FAILURES);
        if (pending === undefined) return INVALID_TOKEN;
        const { userId } = pending;
        await setUserContext(tx, userId);
        // The account row serialises the second steps of one account; the token is read again under it, so a
        // token another request just used or used up is seen as such.
        const current = await lockLoginAccount(tx, userId);
        const challenge = await findSecondFactorChallenge(tx, hash, now, MAX_SECOND_FACTOR_FAILURES);
        if (challenge === undefined) return INVALID_TOKEN;
        // A password changed since the first step makes the token void, like a login with the old password.
        if (
          current === undefined ||
          isGone(current, now) ||
          current.passwordChangedAt.getTime() > challenge.createdAt.getTime()
        ) {
          await deleteSecondFactorChallenge(tx, challenge.id);
          return INVALID_TOKEN;
        }
        const check = await useSecondFactor(tx, userId, factor, now);
        if (check === 'not_enabled') {
          await deleteSecondFactorChallenge(tx, challenge.id);
          return INVALID_TOKEN;
        }
        if (check === 'wrong') {
          await countSecondFactorFailure(tx, challenge.id);
          await audit(
            tx,
            { userId, eventType: 'second_factor_failed', outcome: 'failure', ...requestOf(context, request) },
            now,
          );
          return { outcome: 'invalid_code' };
        }
        await deleteSecondFactorChallenge(tx, challenge.id);
        if (check === 'recovery_code') {
          await audit(
            tx,
            { userId, eventType: 'recovery_code_used', outcome: 'success', ...requestOf(context, request) },
            now,
          );
        }
        const device = { client: request.client, deviceLabel: request.device_label };
        const method = check === 'totp' ? 'password_totp' : 'password_recovery_code';
        return { outcome: 'signed_in', tokens: await signIn(tx, current, device, method, context, now) };
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

    async authenticate(accessToken) {
      const hash = tokenHash('access', accessToken);
      if (hash === undefined) return undefined;
      const now = deps.clock.now();

      return inTransaction(deps.db, async (tx) => {
        const token = await findAccessToken(tx, hash, now);
        if (token === undefined) return undefined;
        await setUserContext(tx, token.userId);
        const session = await findLiveSession(tx, token.sessionId, now);
        return session === undefined
          ? undefined
          : { userId: session.userId, sessionId: session.id, lastReauthAt: session.lastReauthAt };
      });
    },

    async logout(principal, context) {
      const now = deps.clock.now();
      await inTransaction(deps.db, async (tx) => {
        await setUserContext(tx, principal.userId);
        await revokeSessions(tx, [principal.sessionId], 'logout', now);
        await audit(tx, logoutEvent(principal, context), now);
      });
    },

    async logoutAll(principal, context) {
      const now = deps.clock.now();
      await inTransaction(deps.db, async (tx) => {
        await setUserContext(tx, principal.userId);
        await revokeAllSessions(tx, principal.userId, 'logout_all', now);
        await audit(tx, { ...logoutEvent(principal, context), metadata: { scope: 'all' } }, now);
      });
    },

    async listSessions(principal) {
      const now = deps.clock.now();
      return inTransaction(deps.db, async (tx) => {
        await setUserContext(tx, principal.userId);
        const rows = await listActiveSessions(tx, principal.userId, now);
        const wrapped = await requireWrappedKey(tx, principal.userId);
        return deps.dataKeys.withKey(principal.userId, wrapped, (dataKey) =>
          Promise.resolve(
            rows.map((row) => ({
              id: row.id,
              client: row.client,
              deviceLabel:
                row.deviceLabelEnc === null
                  ? null
                  : decryptText(
                      dataKey,
                      { userId: principal.userId, recordId: row.id, field: 'device_label_enc' },
                      row.deviceLabelEnc,
                    ),
              createdAt: row.createdAt,
              lastUsedAt: row.lastUsedAt,
              authMethod: row.authMethod,
              current: row.id === principal.sessionId,
            })),
          ),
        );
      });
    },

    async revokeSession(principal, sessionId, context) {
      const now = deps.clock.now();
      return inTransaction(deps.db, async (tx) => {
        await setUserContext(tx, principal.userId);
        const revoked = await revokeLiveSession(tx, { userId: principal.userId, sessionId }, 'user_revoked', now);
        if (revoked) {
          await audit(
            tx,
            {
              userId: principal.userId,
              eventType: 'session_revoked',
              outcome: 'success',
              ipPrefix: context.ipPrefix,
              client: null,
              sessionId,
              metadata: { reason: 'user_revoked' },
            },
            now,
          );
        }
        return revoked;
      });
    },

    async reauthenticate(principal, stepUp, context) {
      const now = deps.clock.now();
      const { userId } = principal;
      const { storedHash, totpOn } = await inTransaction(deps.db, async (tx) => {
        await setUserContext(tx, userId);
        return { storedHash: await findPasswordHash(tx, userId), totpOn: await hasEnabledTotp(tx, userId) };
      });
      // The session can see whether TOTP is on (`GET /me`): a missing code is named before the password is checked.
      if (totpOn && stepUp.secondFactor === undefined) return 'second_factor_required';
      const valid = await deps.hasher.verify(storedHash, stepUp.password);

      return inTransaction(deps.db, async (tx): Promise<ReauthResult> => {
        await setUserContext(tx, userId);
        // The account row first, as the deletion cascade takes it; it also serialises the account's step-ups.
        await lockLoginAccount(tx, userId);
        if (!valid) {
          await audit(tx, stepUpEvent(principal, context, 'reauth_failed', 'failure'), now);
          return 'invalid_credentials';
        }
        let check: SecondFactorCheck;
        if (stepUp.secondFactor !== undefined) check = await useSecondFactor(tx, userId, stepUp.secondFactor, now);
        // TOTP turned on while the password was checked: asked for after all.
        else if (await hasEnabledTotp(tx, userId)) return 'second_factor_required';
        else check = 'not_enabled';
        if (check === 'wrong') {
          await audit(tx, stepUpEvent(principal, context, 'second_factor_failed', 'failure'), now);
          return 'invalid_credentials';
        }
        if (check === 'recovery_code') {
          await audit(tx, stepUpEvent(principal, context, 'recovery_code_used', 'success'), now);
        }
        await markReauthenticated(tx, principal.sessionId, now);
        await audit(tx, stepUpEvent(principal, context, 'reauth_succeeded', 'success'), now);
        return 'reauthenticated';
      });
    },

    async reauthenticateWithPasskey(principal, credential, context) {
      const now = deps.clock.now();
      const claim = claimedAssertion(credential);
      const hash = claim === undefined ? undefined : challengeHash(claim.challenge);

      return inTransaction(deps.db, async (tx) => {
        await setUserContext(tx, principal.userId);
        await lockLoginAccount(tx, principal.userId);
        // Used up whatever follows, as at sign-in. The session's account is the one to prove: its passkeys are
        // searched, and a user handle naming anyone else is refused, even with a passkey of this account.
        const consumed = hash !== undefined && (await consumeAuthenticationChallenge(tx, hash, now));
        const check =
          consumed && claim?.userId === principal.userId
            ? await checkPasskeyAssertion(tx, deps.webauthn, credential, { ...claim, userId: principal.userId }, now)
            : 'invalid';
        if (check === 'counter_not_increased') {
          await audit(tx, stepUpEvent(principal, context, 'passkey_clone_suspected', 'failure'), now);
          return false;
        }
        if (check === 'invalid') {
          await audit(tx, stepUpEvent(principal, context, 'reauth_failed', 'failure', BY_PASSKEY), now);
          return false;
        }
        await markReauthenticated(tx, principal.sessionId, now);
        await audit(tx, stepUpEvent(principal, context, 'reauth_succeeded', 'success', BY_PASSKEY), now);
        return true;
      });
    },
  };
}

/** The audit metadata of a passkey sign-in or step-up that failed, or of a passkey step-up. */
const BY_PASSKEY = Object.freeze({ method: 'passkey' });

const stepUpEvent = (
  principal: Principal,
  context: RequestContext,
  eventType: AuditEventType,
  outcome: AuditEvent['outcome'],
  metadata?: AuditEvent['metadata'],
): AuditEvent => ({
  userId: principal.userId,
  eventType,
  outcome,
  ipPrefix: context.ipPrefix,
  client: null,
  sessionId: principal.sessionId,
  ...(metadata === undefined ? {} : { metadata }),
});

const logoutEvent = (principal: Principal, context: RequestContext): AuditEvent => ({
  userId: principal.userId,
  eventType: 'logout',
  outcome: 'success',
  ipPrefix: context.ipPrefix,
  client: null,
  sessionId: principal.sessionId,
});

const requestOf = (context: RequestContext, request: { readonly client: 'ios' | 'android' }) => ({
  ipPrefix: context.ipPrefix,
  client: request.client,
});
