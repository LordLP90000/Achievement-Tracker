import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';

const INSUFFICIENT_PRIVILEGE = { code: '42501' };

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;

/**
 * Least privilege per table and role (docs/data-model.md §4). A new table fails this test until its grants are
 * reviewed and listed here; nobody gets TRUNCATE, REFERENCES or TRIGGER.
 */
const EXPECTED_GRANTS: Readonly<Record<string, { readonly app: string[]; readonly worker: string[] }>> = {
  achievements: { app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: [] },
  audit_events: { app: ['INSERT'], worker: ['SELECT', 'DELETE'] },
  badges: { app: ['SELECT', 'INSERT', 'DELETE'], worker: [] },
  check_ins: { app: ['SELECT', 'INSERT', 'DELETE'], worker: [] },
  consents: { app: ['SELECT', 'INSERT', 'UPDATE'], worker: [] },
  deleted_user_tombstones: { app: [], worker: ['SELECT', 'INSERT', 'DELETE'] },
  email_outbox: { app: ['INSERT'], worker: ['SELECT', 'UPDATE', 'DELETE'] },
  gambles: { app: ['SELECT', 'INSERT', 'UPDATE'], worker: [] },
  job_runs: { app: [], worker: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  one_time_tokens: { app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT', 'DELETE'] },
  quests: { app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: [] },
  rate_limit_buckets: { app: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT', 'DELETE'] },
  session_tokens: { app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT', 'DELETE'] },
  sessions: { app: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT', 'DELETE'] },
  user_keys: { app: ['SELECT', 'INSERT'], worker: ['SELECT'] },
  users: { app: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT', 'DELETE'] },
  xp_events: { app: ['SELECT', 'INSERT', 'DELETE'], worker: [] },
};

describe('database roles [R-ENC-03, T-12, E-05, ADR-0003]', () => {
  let database: TestDatabase;
  let app: DatabaseClient;
  let worker: DatabaseClient;
  let migrator: DatabaseClient;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = createDatabaseClient({ url: database.urls.app, applicationName: 'questline-test' });
    worker = createDatabaseClient({ url: database.urls.worker, applicationName: 'questline-test' });
    migrator = createDatabaseClient({ url: database.urls.migrator, applicationName: 'questline-test' });
  });

  afterAll(async () => {
    await Promise.all([app.close(), worker.close(), migrator.close()]);
    await database.drop();
  });

  it.each(['app', 'worker'] as const)('the %s role cannot create tables', async (role) => {
    const client = role === 'app' ? app : worker;

    await expect(client.sql`create table intruder (id integer)`).rejects.toMatchObject(INSUFFICIENT_PRIVILEGE);
  });

  it('the app role cannot read, alter or truncate the worker-only job_runs table', async () => {
    await expect(app.sql`select count(*) from job_runs`).rejects.toMatchObject(INSUFFICIENT_PRIVILEGE);
    await expect(app.sql`alter table job_runs add column intruder integer`).rejects.toMatchObject(
      INSUFFICIENT_PRIVILEGE,
    );
    await expect(app.sql`truncate job_runs`).rejects.toMatchObject(INSUFFICIENT_PRIVILEGE);
  });

  it('the worker role can write job_runs but cannot alter or truncate it', async () => {
    await worker.sql`insert into job_runs (id, job_name, started_at, status) values (${randomUUID()}, 'probe', now(), 'running')`;

    await expect(worker.sql`update job_runs set status = 'succeeded'`).resolves.toBeDefined();
    await expect(worker.sql`delete from job_runs`).resolves.toBeDefined();
    await expect(worker.sql`alter table job_runs add column intruder integer`).rejects.toMatchObject(
      INSUFFICIENT_PRIVILEGE,
    );
    await expect(worker.sql`truncate job_runs`).rejects.toMatchObject(INSUFFICIENT_PRIVILEGE);
  });

  it('no application role is privileged', async () => {
    const roles = await migrator.sql`
      select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
      from pg_roles where rolname in ('questline_app', 'questline_migrator', 'questline_worker') order by rolname`;

    expect(roles.map((role) => ({ ...role }))).toEqual(
      ['questline_app', 'questline_migrator', 'questline_worker'].map((rolname) => ({
        rolname,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
      })),
    );
  });

  it('PUBLIC cannot create objects in the public schema', async () => {
    const [row] = await migrator.sql<{ allowed: boolean }[]>`
      select has_schema_privilege('public', 'public', 'CREATE') as allowed`;

    expect(row?.allowed).toBe(false);
  });

  it('grants each role exactly the documented privileges on every table (least privilege)', async () => {
    const rows = await migrator.sql<{ table: string; role: string; privilege: string }[]>`
      select c.relname as table, r.role, p.privilege
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join (values ('questline_app'), ('questline_worker')) as r (role)
      cross join unnest(${[...PRIVILEGES]}::text[]) as p (privilege)
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
        and has_table_privilege(r.role, c.oid, p.privilege)`;
    const tables = await migrator.sql<{ table: string }[]>`
      select c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') order by c.relname`;

    const actual = Object.fromEntries(
      tables.map(({ table }) => {
        const held = (role: string) =>
          PRIVILEGES.filter((privilege) =>
            rows.some((row) => row.table === table && row.role === role && row.privilege === privilege),
          );
        return [table, { app: held('questline_app'), worker: held('questline_worker') }];
      }),
    );
    const expected = Object.fromEntries(
      Object.entries(EXPECTED_GRANTS).map(([table, grants]) => [
        table,
        {
          app: PRIVILEGES.filter((privilege) => grants.app.includes(privilege)),
          worker: PRIVILEGES.filter((privilege) => grants.worker.includes(privilege)),
        },
      ]),
    );
    expect(actual).toEqual(expected);
  });
});
