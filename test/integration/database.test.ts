import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseClient,
  databaseReadiness,
  withUserContext,
  type DatabaseClient,
} from '../../src/platform/db/client.ts';
import { runMigrations } from '../../src/platform/db/migrate.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';

describe('database client [ADR-0003]', () => {
  let database: TestDatabase;
  let app: DatabaseClient;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = createDatabaseClient({ url: database.urls.app, applicationName: 'questline-test' });
  });

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  it('reports ready while the database answers', async () => {
    await expect(databaseReadiness(app)()).resolves.toBe(true);
  });

  it('fails readiness when the database is unreachable', async () => {
    const unreachable = createDatabaseClient({
      url: 'postgres://nobody:nothing@127.0.0.1:1/none',
      applicationName: 'questline-test',
      connectTimeoutSeconds: 2,
    });

    await expect(databaseReadiness(unreachable)()).rejects.toThrow();
    await unreachable.close();
  });

  it('scopes app.user_id to exactly one transaction', async () => {
    const userId = randomUUID();

    const inside = await withUserContext(app, userId, async (tx) => {
      const [row] = await tx<{ id: string | null }[]>`select app_current_user_id() as id`;
      return row?.id;
    });
    const [after] = await app.sql<{ id: string | null }[]>`select app_current_user_id() as id`;

    expect(inside).toBe(userId);
    expect(after?.id).toBeNull();
  });

  it('rejects a user id that is not a UUID before running any SQL', async () => {
    await expect(withUserContext(app, "x'; drop table job_runs; --", () => Promise.resolve(1))).rejects.toThrow(
      /user id must be a UUID/,
    );
  });

  it('cancels statements that exceed the statement timeout [D-06]', async () => {
    const impatient = createDatabaseClient({
      url: database.urls.app,
      applicationName: 'questline-test',
      statementTimeoutMs: 200,
    });

    await expect(impatient.sql`select pg_sleep(2)`).rejects.toMatchObject({ code: '57014' });
    await impatient.close();
  });

  it('identifies its connections with the application name', async () => {
    const [row] = await app.sql<{ name: string }[]>`select current_setting('application_name') as name`;

    expect(row?.name).toBe('questline-test');
  });

  it('swallows server notices instead of printing them outside the logger', async () => {
    const printed = vi.spyOn(console, 'log');

    await app.sql`drop table if exists table_that_does_not_exist`;

    expect(printed).not.toHaveBeenCalled();
  });
});

describe('migrations', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('are idempotent', async () => {
    await expect(runMigrations(database.urls.migrator)).resolves.toBeUndefined();
    await expect(runMigrations(database.urls.migrator)).resolves.toBeUndefined();
  });

  it('create job_runs with a status constraint', async () => {
    const worker = createDatabaseClient({ url: database.urls.worker, applicationName: 'questline-test' });
    const insert = (status: string) =>
      worker.sql`insert into job_runs (id, job_name, started_at, status) values (${randomUUID()}, 'probe', now(), ${status})`;

    await expect(insert('running')).resolves.toBeDefined();
    await expect(insert('exploded')).rejects.toMatchObject({ code: '23514' });
    await worker.close();
  });
});
