import { randomUUID } from 'node:crypto';
import { emailBlindIndex } from '../../platform/crypto/blind-index.ts';
import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { decryptText, encryptText } from '../../platform/crypto/field-cipher.ts';
import { issueToken, tokenHash } from '../../platform/crypto/tokens.ts';
import { inTransaction, setUserContext, type Database, type Transaction } from '../../platform/db/database.ts';
import { enqueueEmail } from '../../platform/email/outbox-repository.ts';
import type { Clock } from '../../platform/time/clock.ts';
import type { RequestContext } from '../audit/context.ts';
import { recordAuditEvent, type AuditEvent } from '../audit/repository.ts';
import { hasRecentReauth, type Principal } from '../sessions/guard.ts';
import { emailField, ONE_TIME_TOKEN_LIFETIME_MS, withAccountKey } from './account-mail.ts';
import {
  changeEmail,
  consumeOneTimeToken,
  deleteUnusedOneTimeTokens,
  findAccountByBlindIndex,
  findAccountById,
  replaceOneTimeToken,
  type AccountRecord,
} from './repository.ts';

/** Two-step email change (A-12, R-AUTH-06, R-AUTH-07, threats S-08 and I-06). */

export interface EmailChangeServiceDependencies {
  readonly db: Database;
  readonly clock: Clock;
  readonly blindIndexKey: Uint8Array;
  readonly dataKeys: DataKeys;
}

export type RequestEmailChangeResult = 'accepted' | 'reauthentication_required';
export type ConfirmEmailChangeResult = 'changed' | 'invalid_token' | 'email_taken';

export interface EmailChangeService {
  /** Sends a confirmation link to the new address; the answer never says whether that address is registered. */
  request(principal: Principal, newEmail: string, context: RequestContext): Promise<RequestEmailChangeResult>;
  /** Moves the account to the confirmed address and notifies the old one. */
  confirm(token: string, context: RequestContext): Promise<ConfirmEmailChangeResult>;
}

/** The new address was registered by someone else after the request: nothing may change. */
class EmailTakenError extends Error {
  override readonly name = 'EmailTakenError';
}

export function createEmailChangeService(deps: EmailChangeServiceDependencies): EmailChangeService {
  const audit = async (tx: Transaction, event: AuditEvent, now: Date): Promise<void> => {
    if (event.userId !== null) await setUserContext(tx, event.userId);
    await recordAuditEvent(tx, event, now);
  };

  /** The address belongs to another active account: its owner learns about the attempt (I-06). */
  const notifyOwner = async (tx: Transaction, owner: AccountRecord, now: Date): Promise<void> => {
    await withAccountKey(tx, deps.dataKeys, owner.id, async (dataKey) => {
      const to = decryptText(dataKey, emailField(owner.id), owner.emailEnc);
      await enqueueEmail(
        tx,
        dataKey,
        { userId: owner.id, template: 'registration_notice', payload: { to, locale: owner.locale } },
        now,
      );
    });
  };

  /** Emails a link to the new address; the address itself is kept only encrypted until it is confirmed. */
  const sendConfirmation = async (
    tx: Transaction,
    userId: string,
    newEmail: { readonly address: string; readonly blindIndex: Buffer },
    now: Date,
  ): Promise<void> => {
    const account = await findAccountById(tx, userId);
    if (account === undefined) return;
    await withAccountKey(tx, deps.dataKeys, userId, async (dataKey) => {
      const id = randomUUID();
      const { token, hash } = issueToken('verification');
      await replaceOneTimeToken(
        tx,
        {
          id,
          userId,
          purpose: 'change_email',
          tokenHash: hash,
          expiresAt: new Date(now.getTime() + ONE_TIME_TOKEN_LIFETIME_MS),
          newEmailEnc: encryptText(dataKey, { userId, recordId: id, field: 'new_email_enc' }, newEmail.address),
          newEmailBlindIndex: newEmail.blindIndex,
        },
        now,
      );
      await enqueueEmail(
        tx,
        dataKey,
        { userId, template: 'email_change_verify', payload: { to: newEmail.address, locale: account.locale, token } },
        now,
      );
    });
  };

  return {
    async request(principal, newEmail, context) {
      const now = deps.clock.now();
      if (!hasRecentReauth(principal, now)) return 'reauthentication_required';
      const blindIndex = emailBlindIndex(deps.blindIndexKey, newEmail);

      await inTransaction(deps.db, async (tx) => {
        const owner = await findAccountByBlindIndex(tx, blindIndex);
        if (owner === undefined) {
          await sendConfirmation(tx, principal.userId, { address: newEmail, blindIndex }, now);
        } else if (owner.id !== principal.userId && owner.deactivatedAt === null) {
          await notifyOwner(tx, owner, now);
        }
        await audit(
          tx,
          {
            userId: principal.userId,
            eventType: 'email_change_requested',
            outcome: 'success',
            ipPrefix: context.ipPrefix,
            client: null,
            sessionId: principal.sessionId,
          },
          now,
        );
      });
      return 'accepted';
    },

    async confirm(token, context) {
      const hash = tokenHash('verification', token);
      if (hash === undefined) return 'invalid_token';
      const now = deps.clock.now();

      try {
        return await inTransaction(deps.db, async (tx) => {
          const consumed = await consumeOneTimeToken(tx, 'change_email', hash, now);
          if (consumed === undefined || consumed.newEmailEnc === null || consumed.newEmailBlindIndex === null) {
            return 'invalid_token';
          }
          const { userId, newEmailEnc, newEmailBlindIndex } = consumed;
          const account = await findAccountById(tx, userId);
          if (account === undefined) return 'invalid_token';

          await withAccountKey(tx, deps.dataKeys, userId, async (dataKey) => {
            const oldEmail = decryptText(dataKey, emailField(userId), account.emailEnc);
            const newEmail = decryptText(
              dataKey,
              { userId, recordId: consumed.id, field: 'new_email_enc' },
              newEmailEnc,
            );
            const emailEnc = encryptText(dataKey, emailField(userId), newEmail);
            if (!(await changeEmail(tx, userId, { emailEnc, blindIndex: newEmailBlindIndex }, now))) {
              throw new EmailTakenError();
            }
            // Links sent to the old address (a password reset, a verification) must not outlive the change (S-08).
            await deleteUnusedOneTimeTokens(tx, userId);
            await enqueueEmail(
              tx,
              dataKey,
              { userId, template: 'email_change_notice', payload: { to: oldEmail, locale: account.locale } },
              now,
            );
          });
          await audit(
            tx,
            { userId, eventType: 'email_changed', outcome: 'success', ipPrefix: context.ipPrefix, client: null },
            now,
          );
          return 'changed';
        });
      } catch (error) {
        // Thrown to roll back the whole transaction, so the link stays unused (409, nothing changed).
        if (error instanceof EmailTakenError) return 'email_taken';
        throw error;
      }
    },
  };
}
