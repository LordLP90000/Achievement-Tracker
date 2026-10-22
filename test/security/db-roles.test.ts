import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';

const INSUFFICIENT_PRIVILEGE = { code: '42501' };

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
});
