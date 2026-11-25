import { and, asc, eq, getTableColumns, inArray, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { decryptText } from '../../platform/crypto/field-cipher.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { afterPositionOldestFirst } from '../../platform/db/expressions.ts';
import {
  achievements,
  auditEvents,
  badges,
  checkIns,
  consents,
  gambles,
  passkeys,
  quests,
  recoveryCodes,
  sessions,
  totpSecrets,
  users,
  xpEvents,
} from '../../platform/db/schema/index.ts';
import type { UserDataKey } from '../accounts/data-key.ts';
import type { Child, ExportedAchievement, ExportedRecord, ListSection, Position } from './export-document.ts';

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
    'auth_method',
  ],
  passkeys: ['id', 'name_enc', 'transports', 'backed_up', 'created_at', 'last_used_at'],
  totp_secrets: ['enabled_at', 'created_at'],
  recovery_codes: ['id', 'created_at'],
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

type Opener = (recordId: string, field: string, blob: Uint8Array) => string;

/** A row as the query builder returns it for any table: property names to values. */
type Row = Readonly<Record<string, unknown>>;

const propertyOf = (table: PgTable, column: PgColumn): string => {
  const found = Object.entries(getTableColumns(table)).find(([, candidate]) => candidate === column);
  if (found === undefined) throw new Error(`the export reads an unknown column ${column.name}`);
  return found[0];
};

function textOf(row: Row, property: string): string {
  const value = row[property];
  if (typeof value !== 'string') throw new Error(`the export expects text in ${property}`);
  return value;
}

/** Rows of the table as the export shows them: the listed columns, decrypted, instants in RFC 3339. */
function exporter(table: PgTable, columns: readonly string[], open: Opener): (row: Row) => ExportedRecord {
  const propertyByName = new Map(
    Object.entries(getTableColumns(table)).map(([property, column]) => [column.name, property] as const),
  );
  const fields = columns.map((name) => {
    const property = propertyByName.get(name);
    if (property === undefined) throw new Error(`the export lists an unknown column ${name}`);
    return { name, property, encrypted: name.endsWith('_enc') };
  });
  return (row) => {
    // A table keyed by the account (one row each) has no `id` of its own.
    const recordId = String(row['id'] ?? row['userId']);
    return Object.fromEntries(
      fields.map(({ name, property, encrypted }) => {
        const value = row[property];
        if (encrypted) {
          return [name.slice(0, -'_enc'.length), value instanceof Uint8Array ? open(recordId, name, value) : null];
        }
        return [name, value instanceof Date ? value.toISOString() : (value ?? null)];
      }),
    );
  };
}

/** A table read in its order by time, then ID: the order of the document, and of an index (migration 0012). */
interface Ordered {
  readonly table: PgTable;
  readonly columns: readonly string[];
  /** The account's ID: every read names it, and row-level security checks it again. */
  readonly owner: PgColumn;
  readonly time: PgColumn;
  readonly id: PgColumn;
}

const ACHIEVEMENTS: Ordered = {
  table: achievements,
  columns: EXPORTED.achievements,
  owner: achievements.userId,
  time: achievements.createdAt,
  id: achievements.id,
};

/** The lists of the account's own records. */
const LISTS: Readonly<Record<ListSection, Ordered>> = {
  consents: {
    table: consents,
    columns: EXPORTED.consents,
    owner: consents.userId,
    time: consents.grantedAt,
    id: consents.id,
  },
  sessions: {
    table: sessions,
    columns: EXPORTED.sessions,
    owner: sessions.userId,
    time: sessions.createdAt,
    id: sessions.id,
  },
  passkeys: {
    table: passkeys,
    columns: EXPORTED.passkeys,
    owner: passkeys.userId,
    time: passkeys.createdAt,
    id: passkeys.id,
  },
  recovery_codes: {
    table: recoveryCodes,
    columns: EXPORTED.recovery_codes,
    owner: recoveryCodes.userId,
    time: recoveryCodes.createdAt,
    id: recoveryCodes.id,
  },
  xp_events: {
    table: xpEvents,
    columns: EXPORTED.xp_events,
    owner: xpEvents.userId,
    time: xpEvents.createdAt,
    id: xpEvents.id,
  },
  badges: { table: badges, columns: EXPORTED.badges, owner: badges.userId, time: badges.awardedAt, id: badges.id },
  audit_events: {
    table: auditEvents,
    columns: EXPORTED.audit_events,
    owner: auditEvents.userId,
    time: auditEvents.createdAt,
    id: auditEvents.id,
  },
};

/** The records listed inside another one: gambles in their achievement, check-ins in their quest. */
const CHILDREN = {
  gambles: {
    table: gambles,
    columns: EXPORTED.gambles,
    owner: gambles.userId,
    time: gambles.placedAt,
    id: gambles.id,
    parent: gambles.achievementId,
  },
  check_ins: {
    table: checkIns,
    columns: EXPORTED.check_ins,
    owner: checkIns.userId,
    time: checkIns.createdAt,
    id: checkIns.id,
    parent: checkIns.questId,
  },
} as const satisfies Readonly<Record<string, Ordered & { readonly parent: PgColumn }>>;
export type ChildSection = keyof typeof CHILDREN;

/** Records with the place to go on from; null after the last one. */
export interface Page<T> {
  readonly records: readonly T[];
  readonly next: Position | null;
}

/** The export's reads: each takes a bounded number of rows, whatever the account holds (D-09). */
export interface ExportReads {
  account(): Promise<{ readonly account: ExportedRecord; readonly totp: ExportedRecord | null }>;
  /** The next `limit` records of a list. */
  list(section: ListSection, after: Position | null, limit: number): Promise<Page<ExportedRecord>>;
  /** The next `limit` achievements, each with its quests: at most 50 (R-IN-01). */
  achievements(after: Position | null, limit: number): Promise<Page<ExportedAchievement>>;
  /** The first `limit` children of the parents together, oldest first. */
  childrenOfParents(section: ChildSection, parentIds: readonly string[], limit: number): Promise<Child[]>;
  /** The next `limit` children of one parent. */
  childrenOfParent(
    section: ChildSection,
    parentId: string,
    after: Position | null,
    limit: number,
  ): Promise<Page<ExportedRecord>>;
}

/**
 * The export's reads in the caller's transaction, which is bound to the user (RLS). Every list is read in the
 * document's order — by time, then ID — a page at a time; an index serves each order (migration 0012).
 */
export function exportReads(tx: Transaction, userId: string, dataKey: UserDataKey): ExportReads {
  const open: Opener = (recordId, field, blob) => decryptText(dataKey.key, { userId, recordId, field }, blob);
  const from = ({ time, id }: Ordered, after: Position | null) =>
    after === null ? undefined : afterPositionOldestFirst(time, id, after);

  /** Where a full page was left; a page with fewer rows than asked for was the last one. */
  function nextOf(ordered: Ordered, rows: readonly Row[], limit: number): Position | null {
    const last = rows.at(-1);
    if (last === undefined || rows.length < limit) return null;
    const at = last[propertyOf(ordered.table, ordered.time)];
    if (!(at instanceof Date)) throw new Error('the export cannot tell where a page ended');
    return { at, id: textOf(last, propertyOf(ordered.table, ordered.id)) };
  }

  /** The next `limit` rows of the user's — within `among`, if given — in the table's order. */
  async function pageOf(ordered: Ordered, among: SQL | undefined, after: Position | null, limit: number) {
    const rows: Row[] = await tx
      .select()
      .from(ordered.table)
      .where(and(eq(ordered.owner, userId), among, from(ordered, after)))
      .orderBy(asc(ordered.time), asc(ordered.id))
      .limit(limit);
    return { records: rows.map(exporter(ordered.table, ordered.columns, open)), next: nextOf(ordered, rows, limit) };
  }

  return {
    async account() {
      const [account] = await tx.select().from(users).where(eq(users.id, userId));
      if (account === undefined) throw new Error('the exported account is gone');
      const [totp] = await tx.select().from(totpSecrets).where(eq(totpSecrets.userId, userId));
      return {
        account: exporter(users, EXPORTED.users, open)(account),
        totp: totp === undefined ? null : exporter(totpSecrets, EXPORTED.totp_secrets, open)(totp),
      };
    },

    list(section, after, limit) {
      return pageOf(LISTS[section], undefined, after, limit);
    },

    async achievements(after, limit) {
      const rows = await tx
        .select()
        .from(achievements)
        .where(and(eq(achievements.userId, userId), from(ACHIEVEMENTS, after)))
        .orderBy(asc(achievements.createdAt), asc(achievements.id))
        .limit(limit);
      const questRows =
        rows.length === 0
          ? []
          : await tx
              .select()
              .from(quests)
              .where(
                and(
                  eq(quests.userId, userId),
                  inArray(
                    quests.achievementId,
                    rows.map((row) => row.id),
                  ),
                ),
              )
              .orderBy(asc(quests.position), asc(quests.createdAt), asc(quests.id));
      const questsOf = Map.groupBy(questRows, (quest) => quest.achievementId);
      const toAchievement = exporter(achievements, EXPORTED.achievements, open);
      const toQuest = exporter(quests, EXPORTED.quests, open);
      return {
        records: rows.map((row) => ({
          record: toAchievement(row),
          quests: (questsOf.get(row.id) ?? []).map(toQuest),
        })),
        next: nextOf(ACHIEVEMENTS, rows, limit),
      };
    },

    async childrenOfParents(section, parentIds, limit) {
      const children = CHILDREN[section];
      const rows: Row[] = await tx
        .select()
        .from(children.table)
        .where(and(eq(children.owner, userId), inArray(children.parent, [...parentIds])))
        .orderBy(asc(children.time), asc(children.id))
        .limit(limit);
      const parent = propertyOf(children.table, children.parent);
      const toRecord = exporter(children.table, children.columns, open);
      return rows.map((row) => ({ parentId: textOf(row, parent), record: toRecord(row) }));
    },

    childrenOfParent(section, parentId, after, limit) {
      const children = CHILDREN[section];
      return pageOf(children, eq(children.parent, parentId), after, limit);
    },
  };
}
