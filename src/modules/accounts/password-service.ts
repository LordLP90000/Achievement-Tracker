import { emailBlindIndex } from '../../platform/crypto/blind-index.ts';
import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { decryptText } from '../../platform/crypto/field-cipher.ts';
import type { PasswordHasher } from '../../platform/crypto/password.ts';
import { tokenHash } from '../../platform/crypto/tokens.ts';
import { inTransaction, setUserContext, type Database, type Transaction } from '../../platform/db/database.ts';
import { enqueueEmail } from '../../platform/email/outbox-repository.ts';
import type { Clock } from '../../platform/time/clock.ts';
import type { RequestContext } from '../audit/context.ts';
import { recordAuditEvent, type AuditEvent } from '../audit/repository.ts';
import { hasRecentReauth, type Principal } from '../sessions/guard.ts';
import { revokeAllSessions } from '../sessions/repository.ts';
import { emailField, RESET_PASSWORD, sendTokenEmail, withAccountKey } from './account-mail.ts';
import { checkPassword, type BreachedPasswordFilter } from './password-policy.ts';
import {
  changePasswordHash,
  consumeOneTimeToken,
  findAccountByBlindIndex,
  findAccountById,
  isOneTimeTokenUsable,
  markEmailVerified,
} from './repository.ts';

/** Password change, forgot-password and reset (R-AUTH-02, -03, -05, -06, -07). */

export interface PasswordsServiceDependencies {
  readonly db: Database;
  readonly clock: Clock;
  readonly hasher: PasswordHasher;
  readonly breachedPasswords: BreachedPasswordFilter;
  readonly blindIndexKey: Uint8Array;
  readonly dataKeys: DataKeys;
}

export type ChangePasswordResult = 'changed' | 'reauthentication_required' | 'wrong_password' | 'weak_password';
export type ResetPasswordResult = 'reset' | 'invalid_token' | 'weak_password';

export interface PasswordsService {
  /** Needs a re-authentication within 10 minutes and the current password; ends every other session. */
  change(
    principal: Principal,
    passwords: { readonly current: string; readonly next: string },
    context: RequestContext,
  ): Promise<ChangePasswordResult>;
  /** Emails a reset link to a registered, active address; answers nothing either way (R-AUTH-07). */
  requestReset(email: string, context: RequestContext): Promise<void>;
  /** Sets a new password with a reset token; ends every session. */
  reset(token: string, password: string, context: RequestContext): Promise<ResetPasswordResult>;
}

export function createPasswordsService(deps: PasswordsServiceDependencies): PasswordsService {
  const isWeak = (password: string) => checkPassword(deps.breachedPasswords, password) !== 'ok';

  const audit = async (tx: Transaction, event: AuditEvent, now: Date): Promise<void> => {
    if (event.userId !== null) await setUserContext(tx, event.userId);
    await recordAuditEvent(tx, event, now);
  };

  /** Security notice to the account's address: the password was changed (by the owner, one hopes). */
  const notifyPasswordChanged = async (tx: Transaction, userId: string, now: Date): Promise<void> => {
    const account = await findAccountById(tx, userId);
    if (account === undefined) return;
    await withAccountKey(tx, deps.dataKeys, userId, async (dataKey) => {
      const to = decryptText(dataKey, emailField(userId), account.emailEnc);
      await enqueueEmail(
        tx,
        dataKey,
        { userId, template: 'password_changed_notice', payload: { to, locale: account.locale } },
        now,
      );
    });
  };

  return {
    async change(principal, passwords, context) {
      const now = deps.clock.now();
      if (!hasRecentReauth(principal, now)) return 'reauthentication_required';
      const account = await inTransaction(deps.db, (tx) => findAccountById(tx, principal.userId));
      const valid = await deps.hasher.verify(account?.passwordHash, passwords.current);
      const event = {
        userId: principal.userId,
        eventType: 'password_changed',
        ipPrefix: context.ipPrefix,
        client: null,
        sessionId: principal.sessionId,
      } as const;
      if (account === undefined || !valid) {
        await inTransaction(deps.db, (tx) => audit(tx, { ...event, outcome: 'failure' }, now));
        return 'wrong_password';
      }
      if (isWeak(passwords.next)) return 'weak_password';
      const next = await deps.hasher.hash(passwords.next);

      return inTransaction(deps.db, async (tx) => {
        await setUserContext(tx, principal.userId);
        // The verified password must still be the current one: a concurrent change wins.
        const changed = await changePasswordHash(tx, principal.userId, { previous: account.passwordHash, next }, now);
        if (!changed) return 'wrong_password';
        await revokeAllSessions(tx, principal.userId, 'password_changed', now, principal.sessionId);
        await audit(tx, { ...event, outcome: 'success' }, now);
        await notifyPasswordChanged(tx, principal.userId, now);
        return 'changed';
      });
    },

    async requestReset(email, context) {
      const blindIndex = emailBlindIndex(deps.blindIndexKey, email);
      const now = deps.clock.now();

      await inTransaction(deps.db, async (tx) => {
        const account = await findAccountByBlindIndex(tx, blindIndex);
        // Unknown or pending deletion: nothing, and the same answer (R-AUTH-07, A-22). Unverified accounts do get the
        // link: it proves control of the address, so a completed reset also verifies it.
        if (account?.deactivatedAt !== null) return;
        await withAccountKey(tx, deps.dataKeys, account.id, async (dataKey) => {
          const to = decryptText(dataKey, emailField(account.id), account.emailEnc);
          await sendTokenEmail(tx, dataKey, { userId: account.id, to, locale: account.locale }, RESET_PASSWORD, now);
        });
        await audit(
          tx,
          {
            userId: account.id,
            eventType: 'password_reset_requested',
            outcome: 'success',
            ipPrefix: context.ipPrefix,
            client: null,
          },
          now,
        );
      });
    },

    async reset(token, password, context) {
      // A weak password does not use up the token: the user just picks another one.
      if (isWeak(password)) return 'weak_password';
      const hash = tokenHash('passwordReset', token);
      if (hash === undefined) return 'invalid_token';
      const now = deps.clock.now();
      // Check before hashing, so invalid tokens cost no Argon2id work (D-01).
      if (!(await inTransaction(deps.db, (tx) => isOneTimeTokenUsable(tx, 'reset_password', hash, now)))) {
        return 'invalid_token';
      }
      const next = await deps.hasher.hash(password);

      return inTransaction(deps.db, async (tx) => {
        const userId = await consumeOneTimeToken(tx, 'reset_password', hash, now);
        if (userId === undefined) return 'invalid_token';
        await setUserContext(tx, userId);
        await changePasswordHash(tx, userId, { next }, now);
        if (await markEmailVerified(tx, userId, now)) {
          await audit(
            tx,
            { userId, eventType: 'email_verified', outcome: 'success', ipPrefix: context.ipPrefix, client: null },
            now,
          );
        }
        await revokeAllSessions(tx, userId, 'password_reset', now);
        await audit(
          tx,
          {
            userId,
            eventType: 'password_reset_completed',
            outcome: 'success',
            ipPrefix: context.ipPrefix,
            client: null,
          },
          now,
        );
        await notifyPasswordChanged(tx, userId, now);
        return 'reset';
      });
    },
  };
}
