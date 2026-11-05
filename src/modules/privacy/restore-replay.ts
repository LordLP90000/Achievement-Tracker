import { createHash } from 'node:crypto';
import { inBatches } from '../../platform/db/batches.ts';
import { inReadOnlyTransaction, inTransaction, type Database } from '../../platform/db/database.ts';
import {
  accountIdsAfter,
  accountsHoldingAddresses,
  deleteAccounts,
  deleteSessions,
  readAccountStates,
  setBlindIndex,
  updateAccount,
  type AccountChanges,
  type AccountState,
  type AddressHolder,
} from './restore-repository.ts';
import { REPLAY_BATCH_SIZE, replayTombstones, type ReplayResult } from './tombstone-replay.ts';

/** Sessions per statement: each takes only its token generations with it. */
const SESSIONS_PER_BATCH = 1000;

export interface AccountsResult {
  /** Accounts whose deletion request or reactivation after the restore point was taken over. */
  readonly deletionStates: number;
  readonly passwords: number;
  /** Addresses verified after the restore point: unverified, the account would be purged after its 7 days. */
  readonly verifications: number;
  readonly addresses: number;
  /** Addresses held in the restored database by an account the replaced one has, or a verified one: left as they were. */
  readonly addressConflicts: number;
  /** Unverified accounts the replaced database had purged, deleted because another account took their address. */
  readonly unverifiedDeleted: number;
}

export interface RestoreReplayResult extends ReplayResult, AccountsResult {
  /** Sessions deleted with their tokens: every user signs in again. */
  readonly sessions: number;
}

export interface RestoreReplayOptions {
  /** `updated_at` of every account row the replay changes. */
  readonly now: Date;
  /** Accounts per transaction (tests). */
  readonly batchSize?: number;
}

const NOTHING_TAKEN_OVER: AccountsResult = {
  deletionStates: 0,
  passwords: 0,
  verifications: 0,
  addresses: 0,
  addressConflicts: 0,
  unverifiedDeleted: 0,
};

/**
 * Replays after a restore what happened since the restore point (Q-13, Q-57, ADR-0020 as amended): the tombstones of
 * the replaced database first; then, for every account both databases hold, its deletion state, password and
 * address as the replaced database has them; then every session of the restored database is deleted. Without the
 * replaced database only the restored one's own tombstones are replayed and the sessions deleted. Run again, it
 * changes nothing.
 */
export async function replayAfterRestore(
  restored: Database,
  replaced: Database | undefined,
  options: RestoreReplayOptions,
): Promise<RestoreReplayResult> {
  const batchSize = options.batchSize ?? REPLAY_BATCH_SIZE;
  const tombstones = await replayTombstones(restored, replaced, { batchSize });
  const accounts =
    replaced === undefined ? NOTHING_TAKEN_OVER : await reapplyAccounts(restored, replaced, batchSize, options.now);
  return { ...tombstones, ...accounts, sessions: await revokeEverySession(restored) };
}

interface Difference {
  readonly changes: AccountChanges;
  readonly deletionState: boolean;
  readonly password: boolean;
  readonly verification: boolean;
  readonly address: boolean;
}

function differenceOf(ours: AccountState, theirs: AccountState): Difference {
  const deletionState = ours.deactivatedAt?.getTime() !== theirs.deactivatedAt?.getTime();
  // Only a newer change: a password rehashed at a login keeps its date and stays as it is.
  const password = theirs.passwordChangedAt.getTime() > ours.passwordChangedAt.getTime();
  const address = !ours.emailBlindIndex.equals(theirs.emailBlindIndex);
  // A moved address takes its verification with it; otherwise only a verification the restored database lacks.
  const verification = !address && ours.emailVerifiedAt === null && theirs.emailVerifiedAt !== null;
  return {
    changes: {
      ...(deletionState ? { deactivatedAt: theirs.deactivatedAt } : {}),
      ...(password ? { passwordHash: theirs.passwordHash, passwordChangedAt: theirs.passwordChangedAt } : {}),
      ...(verification ? { emailVerifiedAt: theirs.emailVerifiedAt } : {}),
    },
    deletionState,
    password,
    verification,
    address,
  };
}

/** Above both databases' versions, so no ETag a client kept from either matches the changed account. */
const nextVersion = (ours: number, theirs: number) => Math.max(ours, theirs) + 1;

async function reapplyAccounts(
  restored: Database,
  replaced: Database,
  batchSize: number,
  now: Date,
): Promise<AccountsResult> {
  let deletionStates = 0;
  let passwords = 0;
  let verifications = 0;
  let moves: AccountState[] = [];
  for (let after: string | undefined; ;) {
    const ids = await inReadOnlyTransaction(restored, (tx) => accountIdsAfter(tx, after, batchSize));
    after = ids.at(-1);
    if (after === undefined) break;
    const theirs = new Map(
      (await inReadOnlyTransaction(replaced, (tx) => readAccountStates(tx, ids))).map((state) => [state.id, state]),
    );
    await inTransaction(restored, async (tx) => {
      for (const ours of await readAccountStates(tx, ids)) {
        const replacedState = theirs.get(ours.id);
        if (replacedState === undefined) continue;
        const difference = differenceOf(ours, replacedState);
        if (difference.address) moves = [...moves, replacedState];
        if (Object.keys(difference.changes).length === 0) continue;
        await updateAccount(tx, ours.id, difference.changes, nextVersion(ours.version, replacedState.version), now);
        deletionStates += Number(difference.deletionState);
        passwords += Number(difference.password);
        verifications += Number(difference.verification);
      }
    });
  }
  return {
    deletionStates,
    passwords,
    verifications,
    ...(await moveAddresses(restored, replaced, moves, batchSize, now)),
  };
}

/** A blind index no address has: an account's address moves in two steps, so addresses can change hands. */
function temporaryBlindIndex(id: string): Buffer {
  return createHash('sha256').update(`questline|restore|address|${id}`).digest();
}

async function moveAddresses(
  restored: Database,
  replaced: Database,
  moves: readonly AccountState[],
  batchSize: number,
  now: Date,
): Promise<Pick<AccountsResult, 'addresses' | 'addressConflicts' | 'unverifiedDeleted'>> {
  const { moving, unverifiedDeleted } = await clearTargets(restored, replaced, moves);
  for (const batch of inBatches(moving, batchSize)) {
    await inTransaction(restored, async (tx) => {
      for (const move of batch) await setBlindIndex(tx, move.id, temporaryBlindIndex(move.id));
    });
  }
  for (const batch of inBatches(moving, batchSize)) {
    await inTransaction(restored, async (tx) => {
      const versions = new Map(
        (
          await readAccountStates(
            tx,
            batch.map((move) => move.id),
          )
        ).map((state) => [state.id, state.version]),
      );
      for (const move of batch) {
        const changes = {
          emailEnc: move.emailEnc,
          emailBlindIndex: move.emailBlindIndex,
          emailVerifiedAt: move.emailVerifiedAt,
        };
        await updateAccount(tx, move.id, changes, nextVersion(versions.get(move.id) ?? 0, move.version), now);
      }
    });
  }
  return { addresses: moving.length, addressConflicts: moves.length - moving.length, unverifiedDeleted };
}

/**
 * Frees the addresses the moves take. An account that holds one and does not move itself is gone from the replaced
 * database: deleted when unverified, as the purge of unverified accounts did there; otherwise it keeps the address and
 * the move is dropped, which may block further moves in turn, until no move meets a holder.
 */
async function clearTargets(
  restored: Database,
  replaced: Database,
  moves: readonly AccountState[],
): Promise<{ moving: readonly AccountState[]; unverifiedDeleted: number }> {
  let moving = moves;
  let unverifiedDeleted = 0;
  for (;;) {
    const movingIds = new Set(moving.map((move) => move.id));
    const targets = moving.map((move) => move.emailBlindIndex);
    const holders = (
      await inReadOnlyTransaction(restored, async (tx) => {
        let found: AddressHolder[] = [];
        for (const batch of inBatches(targets)) found = [...found, ...(await accountsHoldingAddresses(tx, batch))];
        return found;
      })
    ).filter((holder) => !movingIds.has(holder.id));
    if (holders.length === 0) return { moving, unverifiedDeleted };
    const known = new Set(
      (
        await inReadOnlyTransaction(replaced, (tx) =>
          readAccountStates(
            tx,
            holders.map((holder) => holder.id),
          ),
        )
      ).map((state) => state.id),
    );
    const stale = holders.filter((holder) => !known.has(holder.id) && holder.emailVerifiedAt === null);
    const blocking = holders.filter((holder) => known.has(holder.id) || holder.emailVerifiedAt !== null);
    unverifiedDeleted += await inTransaction(restored, (tx) =>
      deleteAccounts(
        tx,
        stale.map((holder) => holder.id),
      ),
    );
    moving = moving.filter((move) => !blocking.some((holder) => holder.emailBlindIndex.equals(move.emailBlindIndex)));
  }
}

async function revokeEverySession(restored: Database): Promise<number> {
  let total = 0;
  let deleted: number;
  do {
    deleted = await inTransaction(restored, (tx) => deleteSessions(tx, SESSIONS_PER_BATCH));
    total += deleted;
  } while (deleted === SESSIONS_PER_BATCH);
  return total;
}
