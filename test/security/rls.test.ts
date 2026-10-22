import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, withUserContext, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';

const RLS_VIOLATION = { code: '42501' };
const userA = randomUUID();
const userB = randomUUID();

/**
 * Proves the fail-closed RLS pattern of docs/data-model.md §4 on a fixture table that uses exactly the
 * documented policy shape and the `app_current_user_id()` helper from migration 0000.
 */
describe('row-level security fails closed [R-AUTHZ-02, E-05, I-04]', () => {
  let database: TestDatabase;
  let app: DatabaseClient;
  let worker: DatabaseClient;

  beforeAll(async () => {
    database = await createTestDatabase();
    const migrator = createDatabaseClient({ url: database.urls.migrator, applicationName: 'questline-test' });
    await migrator.sql.begin(async (tx) => {
      await tx`create table rls_probe (id uuid primary key, user_id uuid not null, note text not null)`;
      await tx`alter table rls_probe enable row level security`;
      await tx`alter table rls_probe force row level security`;
      await tx`create policy rls_probe_owner on rls_probe to questline_app
                 using (user_id = app_current_user_id()) with check (user_id = app_current_user_id())`;
      await tx`create policy rls_probe_worker on rls_probe to questline_worker using (true) with check (true)`;
      await tx`grant select, insert, update, delete on rls_probe to questline_app, questline_worker`;
    });
    await migrator.close();

    app = createDatabaseClient({ url: database.urls.app, applicationName: 'questline-test' });
    worker = createDatabaseClient({ url: database.urls.worker, applicationName: 'questline-test' });
    for (const owner of [userA, userB]) {
      await withUserContext(app, owner, (tx) => tx`insert into rls_probe values (${randomUUID()}, ${owner}, 'seed')`);
    }
  });

  afterAll(async () => {
    await Promise.all([app.close(), worker.close()]);
    await database.drop();
  });

  it('shows no rows and accepts no writes when the transaction has no user context', async () => {
    const [row] = await app.sql<{ count: string }[]>`select count(*) from rls_probe`;

    expect(row?.count).toBe('0');
    await expect(app.sql`insert into rls_probe values (${randomUUID()}, ${userA}, 'no context')`).rejects.toMatchObject(
      RLS_VIOLATION,
    );
  });

  it("shows only the current user's rows even for a deliberately unfiltered query", async () => {
    const owners = await withUserContext(app, userA, (tx) => tx<{ user_id: string }[]>`select user_id from rls_probe`);

    expect(owners.map((row) => row.user_id)).toEqual([userA]);
  });

  it("refuses to write a row on behalf of another user and leaves the other user's rows untouched", async () => {
    await expect(
      withUserContext(app, userA, (tx) => tx`insert into rls_probe values (${randomUUID()}, ${userB}, 'forged')`),
    ).rejects.toMatchObject(RLS_VIOLATION);

    const updated = await withUserContext(app, userA, (tx) => tx`update rls_probe set note = 'changed'`);
    const deleted = await withUserContext(app, userA, (tx) => tx`delete from rls_probe where user_id = ${userB}`);
    expect(updated.count).toBe(1);
    expect(deleted.count).toBe(0);
  });

  it('lets the worker role see every row (its documented cross-user policy)', async () => {
    const [row] = await worker.sql<{ count: string }[]>`select count(*) from rls_probe`;

    expect(row?.count).toBe('2');
  });

  it('fails closed when the context is not a valid UUID', async () => {
    await expect(
      app.sql.begin(async (tx) => {
        await tx`select set_config('app.user_id', 'not-a-uuid', true)`;
        return tx`select count(*) from rls_probe`;
      }),
    ).rejects.toMatchObject({ code: '22P02' });
  });
});
