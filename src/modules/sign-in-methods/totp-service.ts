import type { FieldContext } from '../../platform/crypto/aead.ts';
import { base32 } from '../../platform/crypto/base32.ts';
import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { decryptText, encryptText } from '../../platform/crypto/field-cipher.ts';
import { issueRecoveryCodes } from '../../platform/crypto/recovery-codes.ts';
import { acceptTotp, newTotpSecret, otpauthUri } from '../../platform/crypto/totp.ts';
import { inTransaction, type Database, type Transaction } from '../../platform/db/database.ts';
import type { Clock } from '../../platform/time/clock.ts';
import { emailField, withAccountKey } from '../accounts/account-mail.ts';
import { findAccountById } from '../accounts/repository.ts';
import type { RequestContext } from '../audit/context.ts';
import { recordAuditEvent, type AuditEventType } from '../audit/repository.ts';
import { hasRecentReauth, type Principal } from '../sessions/guard.ts';
import { queueSignInMethodsNotice } from './notice.ts';
import {
  deleteEnabledTotpSecret,
  deleteRecoveryCodes,
  enableTotp,
  lockTotpSecret,
  replaceRecoveryCodes,
  storePendingTotpSecret,
} from './repository.ts';

/**
 * Turning two-factor authentication (TOTP, RFC 6238) on and off and replacing its recovery codes (ADR-0019), each after
 * the password was entered within 10 minutes (R-AUTH-06). The secret is encrypted with the user's data key; recovery
 * codes are stored as digests and shown once.
 */

/** Q-53: a secret not confirmed within a day was abandoned; the hourly purge deletes it. */
export const PENDING_TOTP_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface TotpServiceDependencies {
  readonly db: Database;
  readonly clock: Clock;
  readonly dataKeys: DataKeys;
}

export interface TotpEnrolment {
  /** RFC 4648 base32, as authenticator apps take it. */
  readonly secret: string;
  readonly otpauthUri: string;
}

interface ReauthenticationRequired {
  readonly outcome: 'reauthentication_required';
}

export type StartTotpResult =
  | { readonly outcome: 'started'; readonly enrolment: TotpEnrolment }
  | { readonly outcome: 'totp_enabled' }
  | ReauthenticationRequired;

export type ConfirmTotpResult =
  | { readonly outcome: 'enabled'; readonly recoveryCodes: readonly string[] }
  | { readonly outcome: 'invalid_code' | 'totp_enabled' | 'totp_not_started' }
  | ReauthenticationRequired;

export type ReplaceRecoveryCodesResult =
  | { readonly outcome: 'replaced'; readonly recoveryCodes: readonly string[] }
  | { readonly outcome: 'totp_not_enabled' }
  | ReauthenticationRequired;

export type DisableTotpResult = { readonly outcome: 'disabled' | 'totp_not_enabled' } | ReauthenticationRequired;

export interface TotpService {
  /** A new secret for the app, shown once; replaces an unconfirmed one. */
  start(principal: Principal): Promise<StartTotpResult>;
  /** A current code from the app turns TOTP on and yields 10 recovery codes. */
  confirm(principal: Principal, code: string, context: RequestContext): Promise<ConfirmTotpResult>;
  /** 10 new recovery codes; the old ones stop working. */
  replaceRecoveryCodes(principal: Principal, context: RequestContext): Promise<ReplaceRecoveryCodesResult>;
  /** Deletes the secret and the recovery codes. */
  disable(principal: Principal, context: RequestContext): Promise<DisableTotpResult>;
}

const REAUTHENTICATION_REQUIRED: ReauthenticationRequired = Object.freeze({ outcome: 'reauthentication_required' });

/** Where `totp_secrets.secret_enc` is bound: AD record id = user id (one secret per account). */
const secretField = (userId: string): FieldContext => ({ userId, recordId: userId, field: 'secret_enc' });

export function createTotpService(deps: TotpServiceDependencies): TotpService {
  /** In one transaction bound to the account, with its data key. */
  const inAccount = <T>(userId: string, work: (tx: Transaction, dataKey: Uint8Array) => Promise<T>): Promise<T> =>
    inTransaction(deps.db, (tx) => withAccountKey(tx, deps.dataKeys, userId, (dataKey) => work(tx, dataKey)));

  /** The change's audit event and the owner's notice, committed with it (R-LOG-03). */
  const record = async (
    tx: Transaction,
    dataKey: Uint8Array,
    principal: Principal,
    change: { readonly eventType: AuditEventType; readonly context: RequestContext },
    now: Date,
  ): Promise<void> => {
    await recordAuditEvent(
      tx,
      {
        userId: principal.userId,
        eventType: change.eventType,
        outcome: 'success',
        ipPrefix: change.context.ipPrefix,
        client: null,
        sessionId: principal.sessionId,
      },
      now,
    );
    await queueSignInMethodsNotice(tx, dataKey, principal.userId, now);
  };

  /** Issues 10 recovery codes in place of the account's; the plain codes leave only in the response. */
  const issueCodes = async (tx: Transaction, userId: string, now: Date): Promise<readonly string[]> => {
    const codes = issueRecoveryCodes();
    await replaceRecoveryCodes(
      tx,
      userId,
      codes.map((code) => code.hash),
      now,
    );
    return codes.map((code) => code.code);
  };

  return {
    async start(principal) {
      const now = deps.clock.now();
      if (!hasRecentReauth(principal, now)) return REAUTHENTICATION_REQUIRED;
      return inAccount(principal.userId, async (tx, dataKey): Promise<StartTotpResult> => {
        const { userId } = principal;
        const secret = newTotpSecret();
        const secretEnc = encryptText(dataKey, secretField(userId), secret.toString('base64'));
        if (!(await storePendingTotpSecret(tx, userId, secretEnc, now))) return { outcome: 'totp_enabled' };
        const account = await findAccountById(tx, userId);
        if (account === undefined) throw new Error('the signed-in account is gone');
        const address = decryptText(dataKey, emailField(userId), account.emailEnc);
        return { outcome: 'started', enrolment: { secret: base32(secret), otpauthUri: otpauthUri(secret, address) } };
      });
    },

    async confirm(principal, code, context) {
      const now = deps.clock.now();
      if (!hasRecentReauth(principal, now)) return REAUTHENTICATION_REQUIRED;
      return inAccount(principal.userId, async (tx, dataKey): Promise<ConfirmTotpResult> => {
        const { userId } = principal;
        // Locked: a secret replaced by another request meanwhile is never turned on unconfirmed.
        const stored = await lockTotpSecret(tx, userId);
        if (stored === undefined) return { outcome: 'totp_not_started' };
        if (stored.enabledAt !== null) return { outcome: 'totp_enabled' };
        if (stored.createdAt.getTime() <= now.getTime() - PENDING_TOTP_LIFETIME_MS) {
          return { outcome: 'totp_not_started' };
        }
        const secret = Buffer.from(decryptText(dataKey, secretField(userId), stored.secretEnc), 'base64');
        const step = acceptTotp(secret, code, now, stored.lastUsedStep);
        if (step === undefined) return { outcome: 'invalid_code' };
        await enableTotp(tx, userId, step, now);
        const recoveryCodes = await issueCodes(tx, userId, now);
        await record(tx, dataKey, principal, { eventType: 'totp_enabled', context }, now);
        return { outcome: 'enabled', recoveryCodes };
      });
    },

    async replaceRecoveryCodes(principal, context) {
      const now = deps.clock.now();
      if (!hasRecentReauth(principal, now)) return REAUTHENTICATION_REQUIRED;
      return inAccount(principal.userId, async (tx, dataKey): Promise<ReplaceRecoveryCodesResult> => {
        // Locked, so turning TOTP off at the same time cannot leave new codes behind.
        const stored = await lockTotpSecret(tx, principal.userId);
        if (stored?.enabledAt == null) return { outcome: 'totp_not_enabled' };
        const recoveryCodes = await issueCodes(tx, principal.userId, now);
        await record(tx, dataKey, principal, { eventType: 'recovery_codes_generated', context }, now);
        return { outcome: 'replaced', recoveryCodes };
      });
    },

    async disable(principal, context) {
      const now = deps.clock.now();
      if (!hasRecentReauth(principal, now)) return REAUTHENTICATION_REQUIRED;
      return inAccount(principal.userId, async (tx, dataKey): Promise<DisableTotpResult> => {
        if (!(await deleteEnabledTotpSecret(tx, principal.userId))) return { outcome: 'totp_not_enabled' };
        await deleteRecoveryCodes(tx, principal.userId);
        await record(tx, dataKey, principal, { eventType: 'totp_disabled', context }, now);
        return { outcome: 'disabled' };
      });
    },
  };
}
