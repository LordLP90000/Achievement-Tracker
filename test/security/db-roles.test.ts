import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, withUserContext, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';

const INSUFFICIENT_PRIVILEGE = { code: '42501' };

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;

/**
 * Least privilege per table and role (docs/data-model.md §4). A new table fails this test until its grants are
 * reviewed and listed here; nobody gets TRUNCATE, REFERENCES or TRIGGER.
 */
const EXPECTED_GRANTS: Readonly<Record<string, { readonly app: string[]; readonly worker: string[] }>> = {
  achievements: { app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT', 'UPDATE'] },
  audit_events: { app: ['SELECT', 'INSERT'], worker: ['SELECT', 'DELETE'] },
  badges: { app: ['SELECT', 'INSERT', 'DELETE'], worker: ['SELECT', 'INSERT', 'DELETE'] },
  check_ins: { app: ['SELECT', 'INSERT', 'DELETE'], worker: ['SELECT'] },
  consents: { app: ['SELECT', 'INSERT', 'UPDATE'], worker: [] },
  deleted_user_tombstones: { app: [], worker: ['SELECT', 'INSERT', 'DELETE'] },
  email_outbox: { app: ['INSERT'], worker: ['SELECT', 'UPDATE', 'DELETE'] },
  gambles: { app: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT', 'UPDATE'] },
  goal_evaluations: { app: [], worker: ['SELECT', 'INSERT', 'UPDATE'] },
  idempotency_keys: { app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT', 'DELETE'] },
  job_runs: { app: [], worker: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  one_time_tokens: { app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT', 'DELETE'] },
  passkeys: { app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: [] },
  quests: { app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT', 'UPDATE'] },
  rate_limit_buckets: { app: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT', 'DELETE'] },
  recovery_codes: { app: ['SELECT', 'INSERT', 'DELETE'], worker: [] },
  second_factor_challenges: { app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT', 'DELETE'] },
  session_tokens: { app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT', 'DELETE'] },
  sessions: { app: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT', 'DELETE'] },
  totp_secrets: { app: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], worker: ['SELECT', 'DELETE'] },
  user_keys: { app: ['SELECT', 'INSERT'], worker: ['SELECT'] },
  users: { app: ['SELECT', 'INSERT', 'UPDATE'], worker: ['SELECT', 'DELETE'] },
  webauthn_challenges: { app: ['SELECT', 'INSERT', 'DELETE'], worker: ['SELECT', 'DELETE'] },
  xp_events: { app: ['SELECT', 'INSERT', 'DELETE'], worker: ['SELECT', 'INSERT'] },
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

  it('lets the app role read only the audit events of the user in context, for the export, and change none [R-PRIV-05, R-LOG-03]', async () => {
    const [owner, other] = [randomUUID(), randomUUID()];
    for (const userId of [owner, other]) {
      await migrator.sql`
        insert into users (id, email_enc, email_blind_index, password_hash, timezone, locale, age_confirmed,
                           privacy_policy_version, password_changed_at, created_at, updated_at)
        values (${userId}, ${Buffer.from([0])}, ${randomBytes(32)}, 'x', 'Europe/Zurich', 'de-CH', true, '1', now(), now(),
                now())`;
      await withUserContext(
        app,
        userId,
        (tx) => tx`
          insert into audit_events (id, user_id, event_type, outcome, created_at)
          values (${randomUUID()}, ${userId}, 'login_succeeded', 'success', now())`,
      );
    }

    const seen = await withUserContext(app, owner, (tx) => tx<{ user_id: string }[]>`select user_id from audit_events`);
    const [unbound] = await app.sql<{ count: string }[]>`select count(*) from audit_events`;
    expect(seen.map((row) => row.user_id)).toEqual([owner]);
    expect(unbound?.count).toBe('0');
    await expect(
      withUserContext(app, owner, (tx) => tx`update audit_events set outcome = 'failure'`),
    ).rejects.toMatchObject(INSUFFICIENT_PRIVILEGE);
    await expect(withUserContext(app, owner, (tx) => tx`delete from audit_events`)).rejects.toMatchObject(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('lets the worker see and delete only unconfirmed TOTP secrets, so no job can turn off a second factor [Q-53]', async () => {
    const [pending, enabled] = [randomUUID(), randomUUID()];
    for (const userId of [pending, enabled]) {
      await migrator.sql`
        insert into users (id, email_enc, email_blind_index, password_hash, timezone, locale, age_confirmed,
                           privacy_policy_version, password_changed_at, created_at, updated_at)
        values (${userId}, ${Buffer.from([0])}, ${randomBytes(32)}, 'x', 'Europe/Zurich', 'de-CH', true, '1', now(), now(),
                now())`;
      await withUserContext(
        app,
        userId,
        (tx) => tx`
          insert into totp_secrets (user_id, secret_enc, enabled_at, created_at)
          values (${userId}, ${randomBytes(73)}, ${userId === enabled ? new Date('2026-11-04T12:01:00Z') : null},
                  ${new Date('2026-11-04T12:00:00Z')})`,
      );
    }

    const seen = await worker.sql<{ user_id: string }[]>`select user_id from totp_secrets`;
    const deleted = await worker.sql<{ user_id: string }[]>`delete from totp_secrets returning user_id`;

    expect(seen.map((row) => row.user_id)).toEqual([pending]);
    expect(deleted.map((row) => row.user_id)).toEqual([pending]);
    const left = await withUserContext(
      app,
      enabled,
      (tx) => tx<{ user_id: string }[]>`select user_id from totp_secrets`,
    );
    expect(left.map((row) => row.user_id)).toEqual([enabled]);
  });

  it('lets the migrator reach every account’s rows in the tables its maintenance commands change, and no others [ADR-0020]', async () => {
    const userId = randomUUID();
    await migrator.sql`
      insert into users (id, email_enc, email_blind_index, password_hash, timezone, locale, age_confirmed,
                         privacy_policy_version, password_changed_at, created_at, updated_at)
      values (${userId}, ${Buffer.from([0])}, ${randomBytes(32)}, 'x', 'Europe/Zurich', 'de-CH', true, '1', now(), now(),
              now())`;
    await withUserContext(app, userId, async (tx) => {
      await tx`insert into user_keys (user_id, wrapped_dek, kek_id, kek_version, created_at)
               values (${userId}, ${randomBytes(73)}, 'local', 1, now())`;
      await tx`insert into consents (id, user_id, type, version, granted_at)
               values (${randomUUID()}, ${userId}, 'goal_content', '2026-10-01', now())`;
      await tx`insert into audit_events (id, user_id, event_type, outcome, created_at)
               values (${randomUUID()}, ${userId}, 'login_succeeded', 'success', now())`;
    });
    const seen = async (table: string) =>
      (
        await migrator.sql<{ count: number }[]>`
          select count(*)::int as count from ${migrator.sql(table)} where user_id = ${userId}`
      )[0]?.count;

    expect({
      user_keys: await seen('user_keys'),
      consents: await seen('consents'),
      audit_events: await seen('audit_events'),
    }).toEqual({ user_keys: 1, consents: 1, audit_events: 0 });
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
