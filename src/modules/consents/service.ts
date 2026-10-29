import { inTransaction, setUserContext, type Database } from '../../platform/db/database.ts';
import { isUniqueViolation } from '../../platform/db/errors.ts';
import type { Clock } from '../../platform/time/clock.ts';
import type { RequestContext } from '../audit/context.ts';
import { recordAuditEvent } from '../audit/repository.ts';
import type { Principal } from '../sessions/guard.ts';
import { insertConsent, listConsents, withdrawConsent, type ConsentRecord, type ConsentType } from './repository.ts';

/**
 * Explicit, versioned consent for goal content (R-PRIV-04, A-14). Withdrawing `goal_content` must also hard-delete
 * all goal content (Q-10): those tables arrive in M3, which adds the deletion to this transaction.
 */

export interface ConsentsServiceDependencies {
  readonly db: Database;
  readonly clock: Clock;
}

export type GrantConsentResult =
  { readonly outcome: 'granted'; readonly consent: ConsentRecord } | { readonly outcome: 'already_granted' };

export interface ConsentsService {
  list(principal: Principal): Promise<ConsentRecord[]>;
  grant(principal: Principal, type: ConsentType, version: string, context: RequestContext): Promise<GrantConsentResult>;
  /** False when no consent of the type is active (→ 404). */
  withdraw(principal: Principal, type: ConsentType, context: RequestContext): Promise<boolean>;
}

export function createConsentsService(deps: ConsentsServiceDependencies): ConsentsService {
  return {
    async list(principal) {
      return inTransaction(deps.db, async (tx) => {
        await setUserContext(tx, principal.userId);
        return listConsents(tx, principal.userId);
      });
    },

    async grant(principal, type, version, context) {
      const now = deps.clock.now();
      try {
        const consent = await inTransaction(deps.db, async (tx) => {
          await setUserContext(tx, principal.userId);
          const granted = await insertConsent(tx, { userId: principal.userId, type, version }, now);
          await recordAuditEvent(
            tx,
            {
              userId: principal.userId,
              eventType: 'consent_granted',
              outcome: 'success',
              ipPrefix: context.ipPrefix,
              client: null,
              sessionId: principal.sessionId,
              metadata: { type, version },
            },
            now,
          );
          return granted;
        });
        return { outcome: 'granted', consent };
      } catch (error) {
        // The partial unique index allows one active consent per type, also against simultaneous grants.
        if (isUniqueViolation(error)) return { outcome: 'already_granted' };
        throw error;
      }
    },

    async withdraw(principal, type, context) {
      const now = deps.clock.now();
      return inTransaction(deps.db, async (tx) => {
        await setUserContext(tx, principal.userId);
        if (!(await withdrawConsent(tx, principal.userId, type, now))) return false;
        await recordAuditEvent(
          tx,
          {
            userId: principal.userId,
            eventType: 'consent_withdrawn',
            outcome: 'success',
            ipPrefix: context.ipPrefix,
            client: null,
            sessionId: principal.sessionId,
            metadata: { type },
          },
          now,
        );
        return true;
      });
    },
  };
}
