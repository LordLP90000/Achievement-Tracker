import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import * as schema from '../../src/platform/db/schema/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';

const tables = Object.values(schema) as PgTable[];

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

  it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
    'matches the migrated table %s column by column',
    async (tableName, table) => {
      const columns = await migrator.sql<{ name: string; nullable: boolean }[]>`
        select column_name as name, is_nullable = 'YES' as nullable
        from information_schema.columns where table_schema = 'public' and table_name = ${tableName}
        order by column_name`;

      const expected = getTableConfig(table)
        .columns.map((column) => ({ name: column.name, nullable: !column.notNull }))
        .sort((left, right) => left.name.localeCompare(right.name));
      expect(columns.map((column) => ({ ...column }))).toEqual(expected);
    },
  );
});
