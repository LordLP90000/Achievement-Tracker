import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import {
  bootstrapDatabase,
  createDatabaseFromTemplate,
  databaseUrl,
  DATABASE_ROLES,
  dropDatabase,
} from '../../src/platform/db/bootstrap.ts';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';

describe('database bootstrap [ADR-0003, R-ENC-03]', () => {
  const server = inject('database');
  const name = `bootstrap_${randomUUID().replaceAll('-', '')}`;
  let admin: DatabaseClient;

  beforeAll(async () => {
    await bootstrapDatabase(server.adminUrl, { database: name, passwords: server.passwords });
    await bootstrapDatabase(server.adminUrl, { database: name, passwords: server.passwords });
    admin = createDatabaseClient({ url: databaseUrl(server.adminUrl, name), applicationName: 'questline-test' });
  });

  afterAll(async () => {
    await admin.close();
    await dropDatabase(server.adminUrl, name);
  });

  it('is idempotent and makes the migrator the owner of the database and of schema public', async () => {
    const [row] = await admin.sql<{ database_owner: string; schema_owner: string }[]>`
      select pg_get_userbyid(d.datdba) as database_owner, pg_get_userbyid(n.nspowner) as schema_owner
      from pg_database d, pg_namespace n where d.datname = ${name} and n.nspname = 'public'`;

    expect(row).toEqual({ database_owner: DATABASE_ROLES.migrator, schema_owner: DATABASE_ROLES.migrator });
  });

  it('lets only the three application roles connect', async () => {
    const rows = await admin.sql<{ role: string; allowed: boolean }[]>`
      select r as role, has_database_privilege(r, ${name}, 'CONNECT') as allowed
      from unnest(array['public', 'questline_migrator', 'questline_app', 'questline_worker']) as r`;

    expect(Object.fromEntries(rows.map((row) => [row.role, row.allowed]))).toEqual({
      public: false,
      questline_migrator: true,
      questline_app: true,
      questline_worker: true,
    });
  });

  it.each(['Bad-Name', 'drop; table', 'UPPER', '9starts_with_digit', 'x'.repeat(64)])(
    'refuses %s as a database name',
    async (invalid) => {
      await expect(createDatabaseFromTemplate(server.adminUrl, invalid, server.template)).rejects.toThrow(
        /lower-case PostgreSQL identifiers/,
      );
    },
  );
});
