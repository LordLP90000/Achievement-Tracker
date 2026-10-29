import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';

/**
 * Inventory tables whose migration comes in a later milestone. Shrink-only: once a table exists, this test fails
 * until it is removed here, so the inventory is checked against the real schema from then on.
 */
const NOT_YET_MIGRATED = ['achievements', 'badges', 'check_ins', 'gambles', 'idempotency_keys', 'quests', 'xp_events'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const deletionSchema = z.enum(['cascade', 'purge-job', 'consent-withdrawal', 'not-applicable']);
const exportSchema = z.enum(['included', 'excluded']);
const approval = {
  approved_by: z.literal('PM').optional(),
  approved_on: z.string().regex(ISO_DATE).optional(),
};
const columnSchema = z.strictObject({
  category: z.string().regex(/^C(?:[1-9]|1[0-5])$/),
  personal: z.boolean(),
  encrypted: z.boolean().optional(),
  export: exportSchema.optional(),
  export_reason: z.string().min(3).optional(),
  deletion: deletionSchema.optional(),
  deletion_reason: z.string().min(3).optional(),
  retention: z.string().min(3).optional(),
  ...approval,
});
const tableSchema = z.strictObject({
  user_relation: z.string().min(1),
  deletion: deletionSchema.optional(),
  deletion_reason: z.string().min(3).optional(),
  retention: z.string().min(3).optional(),
  ...approval,
  columns: z.record(z.string(), columnSchema),
});
/** Strict: a misspelled key (`exprot: excluded`) fails instead of silently dropping a rule. */
const inventorySchema = z.strictObject({
  version: z.number().int(),
  updated: z.string().regex(ISO_DATE),
  defaults: z.strictObject({ export: exportSchema, deletion: deletionSchema, retention: z.string().min(3) }),
  tables: z.record(z.string(), tableSchema),
});

type Inventory = z.infer<typeof inventorySchema>;

const raw: unknown = parse(readFileSync('docs/privacy/data-inventory.yaml', 'utf8'));

/** docs/privacy/data-inventory.md §6: the inventory must describe the real schema exactly [R-PRIV-08]. */
describe('data-inventory guard', () => {
  let database: TestDatabase;
  let migrator: DatabaseClient;
  let inventory: Inventory;
  /** table → column → data type, as migrated. */
  const schema = new Map<string, Map<string, string>>();
  /** Tables reachable from `users` over ON DELETE CASCADE foreign keys. */
  const cascadesFromUsers = new Set<string>(['users']);
  /** Tables with any foreign key to `users`. */
  const referencesUsers = new Set<string>();

  beforeAll(async () => {
    inventory = inventorySchema.parse(raw);
    database = await createTestDatabase();
    migrator = createDatabaseClient({ url: database.urls.migrator, applicationName: 'questline-test' });

    const columns = await migrator.sql<{ table: string; column: string; type: string }[]>`
      select c.table_name as table, c.column_name as column, c.data_type as type
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE'`;
    for (const { table, column, type } of columns) {
      schema.set(table, (schema.get(table) ?? new Map<string, string>()).set(column, type));
    }

    const edges = await migrator.sql<{ referenced: string; referencing: string; cascade: boolean }[]>`
      select ref.relname as referenced, src.relname as referencing, con.confdeltype = 'c' as cascade
      from pg_constraint con
      join pg_class src on src.oid = con.conrelid
      join pg_class ref on ref.oid = con.confrelid
      join pg_namespace n on n.oid = src.relnamespace
      where con.contype = 'f' and n.nspname = 'public'`;
    for (const edge of edges) if (edge.referenced === 'users') referencesUsers.add(edge.referencing);
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of edges) {
        if (edge.cascade && cascadesFromUsers.has(edge.referenced) && !cascadesFromUsers.has(edge.referencing)) {
          cascadesFromUsers.add(edge.referencing);
          grew = true;
        }
      }
    }
  });

  afterAll(async () => {
    await migrator.close();
    await database.drop();
  });

  const migratedTables = () => Object.entries(inventory.tables).filter(([table]) => schema.has(table));

  it('rejects unknown or misspelled keys, so a typo cannot silently drop a rule', () => {
    const typo = { category: 'C1', personal: true, exprot: 'excluded' };
    const result = inventorySchema.safeParse({
      ...inventory,
      tables: { probe: { user_relation: 'none', columns: { value: typo } } },
    });

    expect(result.success).toBe(false);
  });

  it('lists every migrated table and column, and no column that does not exist', () => {
    const problems: string[] = [];
    for (const [table, columns] of schema) {
      const listed = inventory.tables[table]?.columns;
      if (listed === undefined) {
        problems.push(`${table}: table missing from the inventory`);
        continue;
      }
      for (const column of columns.keys()) if (!(column in listed)) problems.push(`${table}.${column}: not listed`);
      for (const column of Object.keys(listed)) if (!columns.has(column)) problems.push(`${table}.${column}: stale`);
    }

    expect(problems).toEqual([]);
  });

  it('names exactly the inventory tables that are not migrated yet', () => {
    const pending = Object.keys(inventory.tables)
      .filter((table) => !schema.has(table))
      .sort();

    expect(pending).toEqual(NOT_YET_MIGRATED);
  });

  it('gives every column an export decision with a reason when excluded, and every non-cascade deletion a reason', () => {
    const problems: string[] = [];
    for (const [table, entry] of Object.entries(inventory.tables)) {
      for (const [column, rules] of Object.entries(entry.columns)) {
        const exported = rules.export ?? inventory.defaults.export;
        const deletion = rules.deletion ?? entry.deletion ?? inventory.defaults.deletion;
        if (exported === 'excluded' && rules.export_reason === undefined) {
          problems.push(`${table}.${column}: excluded from the export without export_reason`);
        }
        const reasons = [rules.deletion_reason, rules.retention, entry.deletion_reason, entry.retention];
        if (deletion !== 'cascade' && reasons.every((reason) => reason === undefined)) {
          problems.push(`${table}.${column}: deletion '${deletion}' without a reason or retention rule`);
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('marks exactly the *_enc columns as encrypted, and stores them as bytea [R-ENC-01]', () => {
    const problems: string[] = [];
    for (const [table, entry] of migratedTables()) {
      for (const [column, rules] of Object.entries(entry.columns)) {
        const named = column.endsWith('_enc');
        if ((rules.encrypted ?? false) !== named) problems.push(`${table}.${column}: encrypted flag vs. name`);
        if (named && schema.get(table)?.get(column) !== 'bytea') problems.push(`${table}.${column}: not bytea`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('deletes every table that belongs to a user together with the account (ON DELETE CASCADE) [R-PRIV-06]', () => {
    const problems: string[] = [];
    for (const [table, entry] of migratedTables()) {
      if (entry.user_relation === 'none') {
        if (referencesUsers.has(table) || cascadesFromUsers.has(table)) problems.push(`${table}: tied to users`);
        if (entry.deletion !== 'not-applicable')
          problems.push(`${table}: no user relation but deletion is not 'not-applicable'`);
        continue;
      }
      if (!schema.get(table)?.has(entry.user_relation)) problems.push(`${table}: no column ${entry.user_relation}`);
      if (!cascadesFromUsers.has(table)) problems.push(`${table}: not deleted with the account`);
    }

    expect(problems).toEqual([]);
  });

  it('records PM approval for every table whose personal data is not deleted with an account', () => {
    const unapproved = Object.entries(inventory.tables)
      .filter(([, entry]) => entry.deletion === 'not-applicable')
      .filter(([, entry]) => Object.values(entry.columns).some((rules) => rules.personal))
      .filter(([, entry]) => entry.approved_by !== 'PM' || entry.approved_on === undefined)
      .map(([table]) => table);

    expect(unapproved).toEqual([]);
  });
});
