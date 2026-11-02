import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { decryptText } from '../../platform/crypto/field-cipher.ts';
import { inTransaction, setUserContext, type Database } from '../../platform/db/database.ts';
import { enqueueEmail } from '../../platform/email/outbox-repository.ts';
import type { Clock } from '../../platform/time/clock.ts';
import { emailField, withAccountKey } from '../accounts/account-mail.ts';
import { deleteOneTimeTokens } from '../accounts/repository.ts';
import type { RequestContext } from '../audit/context.ts';
import { recordAuditEvent } from '../audit/repository.ts';
import { hasRecentReauth, type Principal } from '../sessions/guard.ts';
import { findLiveSession, revokeAllSessions } from '../sessions/repository.ts';
import { DELETION_GRACE_MS } from '../sessions/service.ts';
import { deactivateAccount, lockAccount } from './deletion-repository.ts';

/**
 * R-PRIV-06 (Q-11): a deletion request deactivates the account at once, after the password was entered within 10
 * minutes (R-AUTH-06). Every session and every emailed link ends, the request is audited (R-LOG-03) and the owner is
 * told the deadline; a password login within 30 days reactivates the account, otherwise the retention job deletes it
 * (data-model §5).
 */

export interface DeletionServiceDependencies {
  readonly db: Database;
  readonly clock: Clock;
  readonly dataKeys: DataKeys;
}

export type DeletionResult =
  | { readonly outcome: 'scheduled'; readonly deletionScheduledFor: Date }
  | { readonly outcome: 'reauthentication_required' }
  /** The session ended meanwhile — e.g. by a deletion from another device — so the request speaks for nobody. */
  | { readonly outcome: 'session_ended' };

export interface DeletionService {
  requestDeletion(principal: Principal, context: RequestContext): Promise<DeletionResult>;
}

export function createDeletionService(deps: DeletionServiceDependencies): DeletionService {
  return {
    async requestDeletion(principal, context) {
      const now = deps.clock.now();
      if (!hasRecentReauth(principal, now)) return { outcome: 'reauthentication_required' };
      const { userId, sessionId } = principal;

      return inTransaction(deps.db, async (tx): Promise<DeletionResult> => {
        await setUserContext(tx, userId);
        const account = await lockAccount(tx, userId);
        // Checked under the lock: of simultaneous requests from several devices, only the first one deletes.
        if (account === undefined || (await findLiveSession(tx, sessionId, now)) === undefined) {
          return { outcome: 'session_ended' };
        }
        await deactivateAccount(tx, userId, now);
        await revokeAllSessions(tx, userId, 'account_deleted', now);
        // Links already emailed — a reset, an email change, a verification — no longer work (E-13).
        await deleteOneTimeTokens(tx, userId);
        await recordAuditEvent(
          tx,
          {
            userId,
            eventType: 'account_deleted',
            outcome: 'success',
            ipPrefix: context.ipPrefix,
            client: null,
            sessionId,
          },
          now,
        );
        // The one email an account pending deletion still gets (A-22): if it was not the owner, they can log in.
        await withAccountKey(tx, deps.dataKeys, userId, async (dataKey) => {
          const to = decryptText(dataKey, emailField(userId), account.emailEnc);
          await enqueueEmail(
            tx,
            dataKey,
            { userId, template: 'account_deleted_notice', payload: { to, locale: account.locale } },
            now,
          );
        });
        return { outcome: 'scheduled', deletionScheduledFor: new Date(now.getTime() + DELETION_GRACE_MS) };
      });
    },
  };
}
