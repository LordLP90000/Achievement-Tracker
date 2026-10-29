import { randomUUID } from 'node:crypto';
import { emailBlindIndex } from '../../platform/crypto/blind-index.ts';
import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { decryptText, encryptText } from '../../platform/crypto/field-cipher.ts';
import type { PasswordHasher } from '../../platform/crypto/password.ts';
import { tokenHash } from '../../platform/crypto/tokens.ts';
import { inTransaction, setUserContext, type Database, type Transaction } from '../../platform/db/database.ts';
import { enqueueEmail } from '../../platform/email/outbox-repository.ts';
import { DEFAULT_LOCALE } from '../../platform/i18n/locales.ts';
import type { Clock } from '../../platform/time/clock.ts';
import { DEFAULT_TIME_ZONE } from '../../platform/time/time-zones.ts';
import type { RequestContext } from '../audit/context.ts';
import { recordAuditEvent } from '../audit/repository.ts';
import { emailField, sendTokenEmail, VERIFY_EMAIL, withAccountKey } from './account-mail.ts';
import { checkPassword, type BreachedPasswordFilter } from './password-policy.ts';
import {
  consumeOneTimeToken,
  findAccountByBlindIndex,
  insertAccount,
  insertUserKey,
  isOneTimeTokenUsed,
  markEmailVerified,
  type AccountRecord,
} from './repository.ts';
import type { RegisterRequest } from './schemas.ts';

/** Registration and email verification (R-AUTH-02, -03, -07, -09, -11; R-ENC-01, -02). */

export interface AccountsServiceDependencies {
  readonly db: Database;
  readonly clock: Clock;
  readonly hasher: PasswordHasher;
  readonly breachedPasswords: BreachedPasswordFilter;
  readonly blindIndexKey: Uint8Array;
  readonly dataKeys: DataKeys;
}

export type RegisterResult = 'accepted' | 'weak_password';
export type VerifyEmailResult = 'verified' | 'invalid_token';

export interface AccountsService {
  register(request: RegisterRequest): Promise<RegisterResult>;
  verifyEmail(token: string, context: RequestContext): Promise<VerifyEmailResult>;
  resendVerification(email: string): Promise<void>;
}

export function createAccountsService(deps: AccountsServiceDependencies): AccountsService {
  /** The address is registered already: its owner learns about the attempt, the requester learns nothing. */
  const notifyOwner = async (tx: Transaction, account: AccountRecord | undefined, now: Date): Promise<void> => {
    // Gone meanwhile, or pending deletion: no email (A-22).
    if (account?.deactivatedAt !== null) return;
    await withAccountKey(tx, deps.dataKeys, account.id, async (dataKey) => {
      const to = decryptText(dataKey, emailField(account.id), account.emailEnc);
      await enqueueEmail(
        tx,
        dataKey,
        { userId: account.id, template: 'registration_notice', payload: { to, locale: account.locale } },
        now,
      );
    });
  };

  return {
    async register(request) {
      // The answer depends on the password only, never on the address (R-AUTH-07).
      if (checkPassword(deps.breachedPasswords, request.password) !== 'ok') return 'weak_password';
      // Exactly one hash for new and existing addresses alike, so timing does not tell them apart.
      const passwordHash = await deps.hasher.hash(request.password);
      const blindIndex = emailBlindIndex(deps.blindIndexKey, request.email);
      const now = deps.clock.now();
      const userId = randomUUID();
      const locale = request.locale ?? DEFAULT_LOCALE;

      await inTransaction(deps.db, async (tx) => {
        const created = await deps.dataKeys.withNewKey(userId, async (dataKey, wrapped) => {
          const account = {
            id: userId,
            emailEnc: encryptText(dataKey, emailField(userId), request.email),
            emailBlindIndex: blindIndex,
            passwordHash,
            timezone: request.timezone ?? DEFAULT_TIME_ZONE,
            locale,
            privacyPolicyVersion: request.privacy_policy_version,
          };
          if (!(await insertAccount(tx, account, now))) return false;
          await setUserContext(tx, userId);
          await insertUserKey(tx, userId, wrapped, now);
          await sendTokenEmail(tx, dataKey, { userId, to: request.email, locale }, VERIFY_EMAIL, now);
          return true;
        });
        if (!created) await notifyOwner(tx, await findAccountByBlindIndex(tx, blindIndex), now);
      });
      return 'accepted';
    },

    async verifyEmail(token, context) {
      const hash = tokenHash('verification', token);
      if (hash === undefined) return 'invalid_token';
      const now = deps.clock.now();

      return inTransaction(deps.db, async (tx) => {
        const userId = (await consumeOneTimeToken(tx, 'verify_email', hash, now))?.userId;
        if (userId === undefined) {
          // A replayed token changes nothing and is answered like the first use (contract: 204).
          return (await isOneTimeTokenUsed(tx, 'verify_email', hash)) ? 'verified' : 'invalid_token';
        }
        if (await markEmailVerified(tx, userId, now)) {
          await setUserContext(tx, userId);
          await recordAuditEvent(
            tx,
            { userId, eventType: 'email_verified', outcome: 'success', ipPrefix: context.ipPrefix, client: null },
            now,
          );
        }
        return 'verified';
      });
    },

    async resendVerification(email) {
      const blindIndex = emailBlindIndex(deps.blindIndexKey, email);
      const now = deps.clock.now();

      await inTransaction(deps.db, async (tx) => {
        const account = await findAccountByBlindIndex(tx, blindIndex);
        // Unknown, verified and deactivated addresses get nothing, and the same answer (R-AUTH-07, A-22).
        if (account?.emailVerifiedAt !== null || account.deactivatedAt !== null) return;
        await withAccountKey(tx, deps.dataKeys, account.id, async (dataKey) => {
          const to = decryptText(dataKey, emailField(account.id), account.emailEnc);
          await sendTokenEmail(tx, dataKey, { userId: account.id, to, locale: account.locale }, VERIFY_EMAIL, now);
        });
      });
    },
  };
}
