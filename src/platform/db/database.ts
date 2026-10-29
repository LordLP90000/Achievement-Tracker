import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { DatabaseClient } from './client.ts';

/** Drizzle over the pooled postgres.js client; every query is parameterized (ADR-0003). */
export type Database = PostgresJsDatabase;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

export function createDatabase(client: DatabaseClient): Database {
  return drizzle({ client: client.sql });
}

/** Binds row-level security to `userId` for the rest of this transaction only (ADR-0003, data-model §4). */
export async function setUserContext(tx: Transaction, userId: string): Promise<void> {
  if (!UUID_V4.test(userId)) throw new TypeError('user id must be a UUID');
  await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
}

/** A transaction without a user: RLS tables show no rows, so only the RLS-exempt lookups by hash work. */
export function inTransaction<T>(db: Database, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(work);
}

/** A transaction in which row-level security shows and accepts only `userId`'s rows. */
export function inUserTransaction<T>(db: Database, userId: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await setUserContext(tx, userId);
    return work(tx);
  });
}
