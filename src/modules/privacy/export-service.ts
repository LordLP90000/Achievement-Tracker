import { recordAuditEvent, auditEventTimes } from '../audit/repository.ts';
import type { RequestContext } from '../audit/context.ts';
import { changingAchievements } from '../goals/evaluation-repository.ts';
import { syncAchievement, withGoals, type GoalDependencies } from '../goals/engine.ts';
import { slidingWindowWait, type SlidingWindow } from '../rate-limit/policy.ts';
import { hasRecentReauth, type Principal } from '../sessions/guard.ts';
import { exportText } from './export-document.ts';
import { exportSource } from './export-source.ts';

/**
 * R-PRIV-05 (access and portability): every stored field of the account as one JSON document, after the password was
 * entered within 10 minutes (R-AUTH-06), at most twice in any 24 hours (D-09), audit-logged (R-LOG-03).
 */

/** A rolling window, not the daily-keyed buckets: a day boundary must not allow a third export (D-09). */
export const EXPORT_LIMIT: SlidingWindow = { limit: 2, windowMs: 24 * 60 * 60 * 1000 };

export type ExportResult =
  /** The contract's `ExportDocument` as JSON text, in pieces; it is read as it is taken (`exportText`). */
  | { readonly outcome: 'exported'; readonly document: AsyncIterable<string> }
  | { readonly outcome: 'reauthentication_required' }
  | { readonly outcome: 'rate_limited'; readonly retryAfterSeconds: number };

export interface ExportService {
  export(principal: Principal, context: RequestContext): Promise<ExportResult>;
}

export function createExportService(deps: GoalDependencies): ExportService {
  return {
    async export(principal, context) {
      if (!hasRecentReauth(principal, deps.clock.now())) return { outcome: 'reauthentication_required' };
      // Under the user's goal lock, so two requests at once cannot both pass the count. The document is read
      // afterwards, in parts and without the lock (`exportSource`).
      const admitted = await withGoals(deps, principal.userId, async (scope) => {
        const { tx, userId, now } = scope;
        const since = new Date(now.getTime() - EXPORT_LIMIT.windowMs);
        const waitMs = slidingWindowWait(
          EXPORT_LIMIT,
          await auditEventTimes(tx, userId, 'export_requested', since),
          now,
        );
        if (waitMs > 0) return { retryAfterSeconds: Math.ceil(waitMs / 1000) };
        // Before the document is read, so it shows its own export. It stays if the document then fails to arrive:
        // the export was asked for, and it counts.
        await recordAuditEvent(
          tx,
          {
            userId,
            eventType: 'export_requested',
            outcome: 'success',
            ipPrefix: context.ipPrefix,
            client: null,
            sessionId: principal.sessionId,
          },
          now,
        );
        // As of now, as every read (A-21): what time alone changed — a reset, a lost gamble — is stored first.
        for (const achievementId of await changingAchievements(tx, userId)) await syncAchievement(scope, achievementId);
        return { generatedAt: now };
      });
      if ('retryAfterSeconds' in admitted)
        return { outcome: 'rate_limited', retryAfterSeconds: admitted.retryAfterSeconds };
      return {
        outcome: 'exported',
        document: exportText(exportSource(deps, principal.userId), admitted.generatedAt),
      };
    },
  };
}
