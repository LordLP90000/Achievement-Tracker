import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createDatabase, inUserTransaction, type Database } from '../../src/platform/db/database.ts';
import { afterPosition } from '../../src/platform/db/expressions.ts';
import { achievements, users } from '../../src/platform/db/schema/index.ts';
import { decodeCursor, pageOf } from '../../src/platform/http/pagination.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';

const T0 = new Date('2026-10-29T12:00:00.000Z');
const SECOND = 1000;

interface Listed {
  readonly id: string;
  readonly createdAt: Date;
}

const newestFirst = (left: Listed, right: Listed) =>
  right.createdAt.getTime() - left.createdAt.getTime() || (right.id < left.id ? -1 : right.id > left.id ? 1 : 0);

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an item at index ${String(index)}`);
  return item;
}

/** Keyset pagination over `(created_at, id)` with the HTTP cursor in between, as every list endpoint does it. */
describe('cursor pagination against PostgreSQL [R-IN-01]', () => {
  let database: TestDatabase;
  let client: DatabaseClient;
  let db: Database;

  async function createUser(): Promise<string> {
    const userId = randomUUID();
    await inUserTransaction(db, userId, (tx) =>
      tx.insert(users).values({
        id: userId,
        emailEnc: randomBytes(48),
        emailBlindIndex: randomBytes(32),
        passwordHash: 'placeholder-hash',
        timezone: 'Europe/Zurich',
        locale: 'de-CH',
        ageConfirmed: true,
        privacyPolicyVersion: '2026-10',
        passwordChangedAt: T0,
        createdAt: T0,
        updatedAt: T0,
      }),
    );
    return userId;
  }

  async function addAchievements(userId: string, createdAt: readonly Date[]): Promise<Listed[]> {
    const rows = createdAt.map((at) => ({ id: randomUUID(), createdAt: at }));
    await inUserTransaction(db, userId, (tx) =>
      tx.insert(achievements).values(
        rows.map((row) => ({
          ...row,
          userId,
          titleEnc: randomBytes(48),
          status: 'active',
          dekVersion: 1,
          updatedAt: row.createdAt,
        })),
      ),
    );
    return rows;
  }

  /** One page as a list endpoint reads it: `limit + 1` rows after the cursor, newest first. */
  async function readPage(userId: string, limit: number, cursor: string | null) {
    const position = cursor === null ? null : decodeCursor(cursor);
    if (cursor !== null && position === null) throw new Error('the server issued an unreadable cursor');
    const rows = await inUserTransaction(db, userId, (tx) =>
      tx
        .select({ id: achievements.id, createdAt: achievements.createdAt })
        .from(achievements)
        .where(
          and(
            eq(achievements.userId, userId),
            position === null ? undefined : afterPosition(achievements.createdAt, achievements.id, position),
          ),
        )
        .orderBy(desc(achievements.createdAt), desc(achievements.id))
        .limit(limit + 1),
    );
    return pageOf(rows, limit, (row) => row);
  }

  async function readAll(userId: string, limit: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await readPage(userId, limit, cursor);
      seen.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return seen;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    client = createDatabaseClient({ url: database.urls.app, applicationName: 'questline-test' });
    db = createDatabase(client);
  });

  afterAll(async () => {
    await client.close();
    await database.drop();
  });

  it.each([1, 3, 4, 7, 25, 26, 100])(
    'returns every row exactly once, newest first, with page size %i — also when rows share a timestamp',
    async (limit) => {
      const userId = await createUser();
      // Groups of four share one creation time, so only the ID orders them.
      const rows = await addAchievements(
        userId,
        Array.from({ length: 25 }, (_, index) => new Date(T0.getTime() - Math.floor(index / 4) * SECOND)),
      );
      const other = await createUser();
      await addAchievements(other, [T0, T0]);

      expect(await readAll(userId, limit)).toEqual([...rows].sort(newestFirst).map((row) => row.id));
    },
  );

  it('neither repeats nor skips rows when newer ones are created between two pages', async () => {
    const userId = await createUser();
    const rows = await addAchievements(
      userId,
      Array.from({ length: 10 }, (_, index) => new Date(T0.getTime() - index * SECOND)),
    );
    const first = await readPage(userId, 4, null);

    await addAchievements(userId, [new Date(T0.getTime() + SECOND), new Date(T0.getTime() + 2 * SECOND)]);
    const rest = await readPage(userId, 100, first.nextCursor);

    expect([...first.items, ...rest.items].map((row) => row.id)).toEqual(
      [...rows].sort(newestFirst).map((row) => row.id),
    );
  });

  it('continues after a cursor whose row was deleted in the meantime', async () => {
    const userId = await createUser();
    const rows = [...(await addAchievements(userId, [T0, T0, T0, T0, T0]))].sort(newestFirst);
    const first = await readPage(userId, 2, null);
    const cursorRow = nth(first.items, 1);
    expect(cursorRow.id).toBe(nth(rows, 1).id);

    await inUserTransaction(db, userId, (tx) => tx.delete(achievements).where(eq(achievements.id, cursorRow.id)));
    const rest = await readPage(userId, 100, first.nextCursor);

    expect(rest.items.map((row) => row.id)).toEqual(rows.slice(2).map((row) => row.id));
  });
});
