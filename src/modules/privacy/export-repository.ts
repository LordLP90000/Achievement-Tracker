import { and, asc, eq, getTableColumns, inArray, type Table } from 'drizzle-orm';
import { decryptText } from '../../platform/crypto/field-cipher.ts';
import { inBatches } from '../../platform/db/batches.ts';
import type { Transaction } from '../../platform/db/database.ts';
import {
  achievements,
  auditEvents,
  badges,
  checkIns,
  consents,
  gambles,
  quests,
  sessions,
  users,
  xpEvents,
} from '../../platform/db/schema/index.ts';
import type { UserDataKey } from '../accounts/data-key.ts';

/**
 * What the export reads (R-PRIV-05): of each table the columns the data inventory marks `included` — the account's
 * own `user_id` aside, which is `account.id` — under their names without `_enc`, encrypted ones decrypted with the
 * user's data key. `test/privacy/export.test.ts` holds this list against `docs/privacy/data-inventory.yaml`.
 */
const EXPORTED = {
  users: [
    'id',
    'email_enc',
    'nickname_enc',
    'timezone',
    'locale',
    'week_start',
    'age_confirmed',
    'privacy_policy_version',
    'email_verified_at',
    'password_changed_at',
    'deactivated_at',
    'created_at',
    'updated_at',
    'version',
  ],
  consents: ['id', 'type', 'version', 'granted_at', 'withdrawn_at'],
  sessions: [
    'id',
    'client',
    'device_label_enc',
    'created_at',
    'last_used_at',
    'last_reauth_at',
    'absolute_expires_at',
    'revoked_at',
    'revoked_reason',
  ],
  achievements: [
    'id',
    'title_enc',
    'description_enc',
    'motivation_enc',
    'category_enc',
    'target_date_enc',
    'deadline_enc',
    'status',
    'is_private',
    'attempt',
    'completed_at',
    'execution_score',
    'rank',
    'created_at',
    'updated_at',
    'version',
  ],
  gambles: ['id', 'achievement_id', 'attempt', 'stake', 'status', 'loss_reason', 'placed_at', 'settled_at'],
  quests: [
    'id',
    'achievement_id',
    'position',
    'type',
    'size',
    'is_required',
    'prerequisite_quest_id',
    'title_enc',
    'notes_enc',
    'unit_enc',
    'start_value_enc',
    'target_value_enc',
    'habit_period',
    'habit_times_per_period',
    'habit_period_count',
    'habit_start_date',
    'habit_week_start',
    'reset_count',
    'habit_best_streak',
    'needs_restart',
    'completed_at',
    'created_at',
    'updated_at',
    'version',
  ],
  check_ins: ['id', 'quest_id', 'local_date', 'attempt', 'counts_for_progress', 'value_enc', 'note_enc', 'created_at'],
  xp_events: ['id', 'kind', 'amount', 'quest_id', 'achievement_id', 'gamble_id', 'local_date', 'created_at'],
  badges: ['id', 'achievement_id', 'kind', 'rank', 'awarded_at'],
  audit_events: ['id', 'event_type', 'session_id', 'ip_prefix', 'client', 'outcome', 'metadata', 'created_at'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** One exported row: column names (without `_enc`) to JSON values. */
export type ExportedRecord = Readonly<Record<string, unknown>>;

export interface ExportedRows {
  readonly account: ExportedRecord;
  readonly consents: readonly ExportedRecord[];
  readonly sessions: readonly ExportedRecord[];
  readonly achievements: readonly ExportedRecord[];
  readonly gambles: readonly ExportedRecord[];
  readonly quests: readonly ExportedRecord[];
  readonly checkIns: readonly ExportedRecord[];
  readonly xpEvents: readonly ExportedRecord[];
  readonly badges: readonly ExportedRecord[];
  readonly auditEvents: readonly ExportedRecord[];
}

type Opener = (recordId: string, field: string, blob: Uint8Array) => string;

/** Rows of the table as the export shows them: the listed columns, decrypted, instants in RFC 3339. */
function exporter(table: Table, columns: readonly string[], open: Opener): (row: object) => ExportedRecord {
  const propertyOf = new Map(
    Object.entries(getTableColumns(table)).map(([property, column]) => [column.name, property] as const),
  );
  const fields = columns.map((name) => {
    const property = propertyOf.get(name);
    if (property === undefined) throw new Error(`the export lists an unknown column ${name}`);
    return { name, property, encrypted: name.endsWith('_enc') };
  });
  return (row) => {
    const values = row as Readonly<Record<string, unknown>>;
    const recordId = String(values['id']);
    return Object.fromEntries(
      fields.map(({ name, property, encrypted }) => {
        const value = values[property];
        if (encrypted) {
          return [name.slice(0, -'_enc'.length), value instanceof Uint8Array ? open(recordId, name, value) : null];
        }
        return [name, value instanceof Date ? value.toISOString() : (value ?? null)];
      }),
    );
  };
}

/**
 * Every exported row of the user, read in the caller's transaction (bound to the user, RLS). The children of the
 * unlimited archive (Q-40) are read by their parents' IDs in batches, so each statement stays bounded.
 */
export async function exportedRows(tx: Transaction, userId: string, dataKey: UserDataKey): Promise<ExportedRows> {
  const open: Opener = (recordId, field, blob) => decryptText(dataKey.key, { userId, recordId, field }, blob);
  const accountRows = await tx.select().from(users).where(eq(users.id, userId));
  const account = accountRows[0];
  if (account === undefined) throw new Error('the exported account is gone');
  const achievementRows = await tx
    .select()
    .from(achievements)
    .where(eq(achievements.userId, userId))
    .orderBy(asc(achievements.createdAt), asc(achievements.id));
  const gambleRows = [];
  const questRows = [];
  for (const batch of inBatches(achievementRows.map((row) => row.id))) {
    gambleRows.push(
      ...(await tx
        .select()
        .from(gambles)
        .where(and(eq(gambles.userId, userId), inArray(gambles.achievementId, batch)))
        .orderBy(asc(gambles.placedAt), asc(gambles.id))),
    );
    questRows.push(
      ...(await tx
        .select()
        .from(quests)
        .where(and(eq(quests.userId, userId), inArray(quests.achievementId, batch)))
        .orderBy(asc(quests.position), asc(quests.createdAt), asc(quests.id))),
    );
  }
  const checkInRows = [];
  for (const batch of inBatches(questRows.map((row) => row.id))) {
    checkInRows.push(
      ...(await tx
        .select()
        .from(checkIns)
        .where(and(eq(checkIns.userId, userId), inArray(checkIns.questId, batch)))
        .orderBy(asc(checkIns.createdAt), asc(checkIns.id))),
    );
  }
  const consentRows = await tx
    .select()
    .from(consents)
    .where(eq(consents.userId, userId))
    .orderBy(asc(consents.grantedAt), asc(consents.id));
  const sessionRows = await tx
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(asc(sessions.createdAt), asc(sessions.id));
  const xpRows = await tx
    .select()
    .from(xpEvents)
    .where(eq(xpEvents.userId, userId))
    .orderBy(asc(xpEvents.createdAt), asc(xpEvents.id));
  const badgeRows = await tx
    .select()
    .from(badges)
    .where(eq(badges.userId, userId))
    .orderBy(asc(badges.awardedAt), asc(badges.id));
  const auditRows = await tx
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.userId, userId))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));

  const all = (table: Table, columns: readonly string[], rows: readonly object[]) =>
    rows.map(exporter(table, columns, open));
  return {
    account: exporter(users, EXPORTED.users, open)(account),
    consents: all(consents, EXPORTED.consents, consentRows),
    sessions: all(sessions, EXPORTED.sessions, sessionRows),
    achievements: all(achievements, EXPORTED.achievements, achievementRows),
    gambles: all(gambles, EXPORTED.gambles, gambleRows),
    quests: all(quests, EXPORTED.quests, questRows),
    checkIns: all(checkIns, EXPORTED.check_ins, checkInRows),
    xpEvents: all(xpEvents, EXPORTED.xp_events, xpRows),
    badges: all(badges, EXPORTED.badges, badgeRows),
    auditEvents: all(auditEvents, EXPORTED.audit_events, auditRows),
  };
}
