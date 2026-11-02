import { eq } from 'drizzle-orm';
import type { Transaction } from '../../platform/db/database.ts';
import { increment } from '../../platform/db/expressions.ts';
import { users } from '../../platform/db/schema/index.ts';

/** The account row during a deletion request (R-PRIV-06, data-model §5). */

/** What the notice to the owner needs: the stored address, encrypted, and the language. */
export interface DeletingAccount {
  readonly emailEnc: Buffer;
  readonly locale: string;
}

/**
 * Locks the account row for the rest of the transaction, as a login does: deletion requests from several devices
 * and a reactivating login of one user run one after the other.
 */
export async function lockAccount(tx: Transaction, userId: string): Promise<DeletingAccount | undefined> {
  const [account] = await tx
    .select({ emailEnc: users.emailEnc, locale: users.locale })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  return account;
}

/** Pending deletion from `now` on: the retention job deletes the account 30 days later unless the owner logs in. */
export async function deactivateAccount(tx: Transaction, userId: string, now: Date): Promise<void> {
  await tx
    .update(users)
    .set({ deactivatedAt: now, updatedAt: now, version: increment(users.version) })
    .where(eq(users.id, userId));
}
