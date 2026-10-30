import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import * as schema from '../../src/platform/db/schema/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';

const tables = (Object.values(schema) as PgTable[]).map((table) => [getTableConfig(table).name, table] as const);

/** pg_constraint.confdeltype for each Drizzle `onDelete` action. */
const ON_DELETE: Readonly<Record<string, string>> = {
  'no action': 'a',
  restrict: 'r',
  cascade: 'c',
  'set null': 'n',
  'set default': 'd',
};

interface ForeignKey {
  columns: string[];
  target: string;
  target_columns: string[];
  on_delete: string;
}

const byColumns = (left: ForeignKey, right: ForeignKey) => left.columns.join().localeCompare(right.columns.join());

/** The Drizzle schema (source of generated migrations) must describe exactly what the migrations create. */
describe('schema drift', () => {
  let database: TestDatabase;
  let migrator: DatabaseClient;

  beforeAll(async () => {
    database = await createTestDatabase();
    migrator = createDatabaseClient({ url: database.urls.migrator, applicationName: 'questline-test' });
  });

  afterAll(async () => {
    await migrator.close();
    await database.drop();
  });

  it.each(tables)('matches the migrated table %s column by column: name, nullability and type', async (name, table) => {
    const columns = await migrator.sql<{ name: string; nullable: boolean; type: string }[]>`
      select a.attname::text as name, not a.attnotnull as nullable, format_type(a.atttypid, a.atttypmod) as type
      from pg_attribute a
      where a.attrelid = ${`public.${name}`}::regclass and a.attnum > 0 and not a.attisdropped
      order by a.attname`;

    const expected = getTableConfig(table)
      .columns.map((column) => ({
        name: column.name,
        nullable: !column.notNull,
        // Drizzle writes `numeric(5, 2)`, PostgreSQL reports `numeric(5,2)`.
        type: column.getSQLType().replaceAll(', ', ','),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    expect(columns.map((column) => ({ ...column }))).toEqual(expected);
  });

  it.each(tables)('matches the foreign keys of %s, including what happens on delete', async (name, table) => {
    const actual = await migrator.sql<ForeignKey[]>`
      select array(select a.attname::text from unnest(con.conkey) with ordinality as k (attnum, position)
                   join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum order by k.position)
               as columns,
             target.relname::text as target,
             array(select a.attname::text from unnest(con.confkey) with ordinality as k (attnum, position)
                   join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum order by k.position)
               as target_columns,
             con.confdeltype::text as on_delete
      from pg_constraint con join pg_class target on target.oid = con.confrelid
      where con.conrelid = ${`public.${name}`}::regclass and con.contype = 'f'`;

    const expected = getTableConfig(table).foreignKeys.map((foreignKey): ForeignKey => {
      const reference = foreignKey.reference();
      return {
        columns: reference.columns.map((column) => column.name),
        target: getTableConfig(reference.foreignTable).name,
        target_columns: reference.foreignColumns.map((column) => column.name),
        on_delete: ON_DELETE[foreignKey.onDelete ?? 'no action'] ?? '?',
      };
    });
    expect(actual.map((row) => ({ ...row })).sort(byColumns)).toEqual(expected.sort(byColumns));
  });
});
