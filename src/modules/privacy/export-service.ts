import { recordAuditEvent, auditEventTimes } from '../audit/repository.ts';
import type { RequestContext } from '../audit/context.ts';
import { changingAchievements } from '../goals/evaluation-repository.ts';
import { syncAchievement, withGoals, type GoalDependencies } from '../goals/engine.ts';
import { slidingWindowWait, type SlidingWindow } from '../rate-limit/policy.ts';
import { hasRecentReauth, type Principal } from '../sessions/guard.ts';
import { exportedRows, type ExportedRecord, type ExportedRows } from './export-repository.ts';

/**
 * R-PRIV-05 (access and portability): every stored field of the account as one JSON document, after the password was
 * entered within 10 minutes (R-AUTH-06), at most twice in any 24 hours (D-09), audit-logged (R-LOG-03).
 */

/** A rolling window, not the daily-keyed buckets: a day boundary must not allow a third export (D-09). */
export const EXPORT_LIMIT: SlidingWindow = { limit: 2, windowMs: 24 * 60 * 60 * 1000 };

/** `ExportDocument` of the contract. */
export interface ExportDocument {
  readonly format: 'questline-export';
  readonly version: 1;
  readonly generated_at: string;
  readonly account: ExportedRecord;
  readonly consents: readonly ExportedRecord[];
  readonly sessions: readonly ExportedRecord[];
  readonly achievements: readonly ExportedRecord[];
  readonly xp_events: readonly ExportedRecord[];
  readonly badges: readonly ExportedRecord[];
  readonly audit_events: readonly ExportedRecord[];
}

export type ExportResult =
  | { readonly outcome: 'exported'; readonly document: ExportDocument }
  | { readonly outcome: 'reauthentication_required' }
  | { readonly outcome: 'rate_limited'; readonly retryAfterSeconds: number };

export interface ExportService {
  export(principal: Principal, context: RequestContext): Promise<ExportResult>;
}

const groupedBy = (records: readonly ExportedRecord[], key: string) => Map.groupBy(records, (record) => record[key]);

/** Gambles and quests inside their achievement, check-ins inside their quest. */
function documentOf(rows: ExportedRows, now: Date): ExportDocument {
  const gambles = groupedBy(rows.gambles, 'achievement_id');
  const quests = groupedBy(rows.quests, 'achievement_id');
  const checkIns = groupedBy(rows.checkIns, 'quest_id');
  return {
    format: 'questline-export',
    version: 1,
    generated_at: now.toISOString(),
    account: rows.account,
    consents: rows.consents,
    sessions: rows.sessions,
    achievements: rows.achievements.map((achievement) => ({
      ...achievement,
      gambles: gambles.get(achievement['id']) ?? [],
      quests: (quests.get(achievement['id']) ?? []).map((quest) => ({
        ...quest,
        check_ins: checkIns.get(quest['id']) ?? [],
      })),
    })),
    xp_events: rows.xpEvents,
    badges: rows.badges,
    audit_events: rows.auditEvents,
  };
}

export function createExportService(deps: GoalDependencies): ExportService {
  return {
    async export(principal, context) {
      if (!hasRecentReauth(principal, deps.clock.now())) return { outcome: 'reauthentication_required' };
      // Under the user's goal lock: two requests at once cannot both pass the count, and no goal changes meanwhile.
      return withGoals(deps, principal.userId, async (scope): Promise<ExportResult> => {
        const { tx, userId, now } = scope;
        const since = new Date(now.getTime() - EXPORT_LIMIT.windowMs);
        const waitMs = slidingWindowWait(
          EXPORT_LIMIT,
          await auditEventTimes(tx, userId, 'export_requested', since),
          now,
        );
        if (waitMs > 0) return { outcome: 'rate_limited', retryAfterSeconds: Math.ceil(waitMs / 1000) };
        // First, so the document shows its own export; it commits only together with the export.
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
        return { outcome: 'exported', document: documentOf(await exportedRows(tx, userId, scope.dataKey), now) };
      });
    },
  };
}
