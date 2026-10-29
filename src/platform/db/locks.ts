import { sql } from 'drizzle-orm';
import type { Transaction } from './database.ts';

/**
 * Takes the transaction-scoped advisory lock called `name` if no other transaction holds it; it is released at commit
 * or rollback. Scheduled jobs use it so that only one worker instance runs a job at a time (ADR-0009).
 */
export async function tryTransactionLock(tx: Transaction, name: string): Promise<boolean> {
  const rows = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${name}, 0)) as locked`,
  );
  return rows[0]?.locked === true;
}
