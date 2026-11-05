import { createHash } from 'node:crypto';
import { inBatches } from '../../platform/db/batches.ts';
import { inReadOnlyTransaction, inTransaction, type Database, type Transaction } from '../../platform/db/database.ts';
import { deleteGoalContent } from '../achievements/repository.ts';
import {
  accountIdsAfter,
  accountsHoldingAddresses,
  deleteAccounts,
  deleteSessions,
  readAccountStates,
  readConsents,
  readSignInRows,
  replaceConsents,
  replaceSignInRows,
  setBlindIndex,
  updateAccount,
  type AccountChanges,
  type AccountState,
  type AddressHolder,
  type ConsentRow,
  type SignInRows,
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
  /** Accounts whose passkeys, TOTP secret or recovery codes were taken over. */
  readonly signInMethods: number;
  /** Accounts whose consent records were taken over. */
  readonly consents: number;
  /** Accounts whose goal content was deleted again: their consent was withdrawn after the restore point. */
  readonly goalContentDeleted: number;
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
  signInMethods: 0,
  consents: 0,
  goalContentDeleted: 0,
};

/**
 * Replays after a restore what happened since the restore point (Q-13, Q-57, ADR-0020 as amended): the tombstones of
 * the replaced database first; then, for every account both databases hold, its deletion state, password, address,
 * sign-in methods and consents as the replaced database has them, a withdrawal since deleting the goal content again;
 * then every session of the restored database is deleted. Without the
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

/** What one database holds for a batch of accounts: the account rows, their sign-in methods and consents. */
interface Batch {
  readonly accounts: readonly AccountState[];
  readonly signIn: SignInRows;
  readonly consents: readonly ConsentRow[];
}

async function readBatch(tx: Transaction, ids: readonly string[]): Promise<Batch> {
  return {
    accounts: await readAccountStates(tx, ids),
    signIn: await readSignInRows(tx, ids),
    consents: await readConsents(tx, ids),
  };
}

type Totals = Omit<AccountsResult, 'addresses' | 'addressConflicts' | 'unverifiedDeleted'>;

const NO_TOTALS: Totals = {
  deletionStates: 0,
  passwords: 0,
  verifications: 0,
  signInMethods: 0,
  consents: 0,
  goalContentDeleted: 0,
};

const added = (sum: Totals, more: Totals): Totals => ({
  deletionStates: sum.deletionStates + more.deletionStates,
  passwords: sum.passwords + more.passwords,
  verifications: sum.verifications + more.verifications,
  signInMethods: sum.signInMethods + more.signInMethods,
  consents: sum.consents + more.consents,
  goalContentDeleted: sum.goalContentDeleted + more.goalContentDeleted,
});

async function reapplyAccounts(
  restored: Database,
  replaced: Database,
  batchSize: number,
  now: Date,
): Promise<AccountsResult> {
  let totals = NO_TOTALS;
  let moves: AccountState[] = [];
  for (let after: string | undefined; ;) {
    const ids = await inReadOnlyTransaction(restored, (tx) => accountIdsAfter(tx, after, batchSize));
    after = ids.at(-1);
    if (after === undefined) break;
    const theirs = await inReadOnlyTransaction(replaced, (tx) => readBatch(tx, ids));
    const batch = await inTransaction(restored, (tx) => reapplyBatch(tx, theirs, now));
    totals = added(totals, batch.totals);
    moves = [...moves, ...batch.moves];
  }
  return { ...totals, ...(await moveAddresses(restored, replaced, moves, batchSize, now)) };
}

/** The accounts of a batch that both databases hold, made as the replaced database has them; addresses move later. */
async function reapplyBatch(
  tx: Transaction,
  theirs: Batch,
  now: Date,
): Promise<{ totals: Totals; moves: readonly AccountState[] }> {
  const ids = theirs.accounts.map((state) => state.id);
  const ours = await readBatch(tx, ids);
  const accounts = await reapplyAccountRows(tx, ours.accounts, theirs.accounts, now);
  const signInMethods = await reapplySignInRows(tx, ids, ours.signIn, theirs.signIn);
  const consents = await reapplyConsents(tx, ids, ours.consents, theirs.consents);
  return { totals: { ...accounts.totals, signInMethods, ...consents }, moves: accounts.moves };
}

async function reapplyAccountRows(
  tx: Transaction,
  ours: readonly AccountState[],
  theirs: readonly AccountState[],
  now: Date,
): Promise<{ totals: Pick<Totals, 'deletionStates' | 'passwords' | 'verifications'>; moves: AccountState[] }> {
  const replacedById = new Map(theirs.map((state) => [state.id, state]));
  let totals = { deletionStates: 0, passwords: 0, verifications: 0 };
  let moves: AccountState[] = [];
  for (const own of ours) {
    const replacedState = replacedById.get(own.id);
    if (replacedState === undefined) continue;
    const difference = differenceOf(own, replacedState);
    if (difference.address) moves = [...moves, replacedState];
    if (Object.keys(difference.changes).length === 0) continue;
    await updateAccount(tx, own.id, difference.changes, nextVersion(own.version, replacedState.version), now);
    totals = {
      deletionStates: totals.deletionStates + Number(difference.deletionState),
      passwords: totals.passwords + Number(difference.password),
      verifications: totals.verifications + Number(difference.verification),
    };
  }
  return { totals, moves };
}

const signInRowsOf = (rows: SignInRows, ids: readonly string[]): SignInRows => ({
  passkeys: rows.passkeys.filter((row) => ids.includes(row.userId)),
  totpSecrets: rows.totpSecrets.filter((row) => ids.includes(row.userId)),
  recoveryCodes: rows.recoveryCodes.filter((row) => ids.includes(row.userId)),
});

/** Passkeys, TOTP secret and recovery codes as the replaced database has them: removed, added, used or replaced. */
async function reapplySignInRows(
  tx: Transaction,
  ids: readonly string[],
  ours: SignInRows,
  theirs: SignInRows,
): Promise<number> {
  const changed = ids.filter(
    (id) => JSON.stringify(signInRowsOf(ours, [id])) !== JSON.stringify(signInRowsOf(theirs, [id])),
  );
  await replaceSignInRows(tx, changed, signInRowsOf(theirs, changed));
  return changed.length;
}

/**
 * The consents as the replaced database has them. A withdrawal the restored database lacks deleted the goal content
 * there (Q-10): it is deleted here too, before the consents are taken over.
 */
async function reapplyConsents(
  tx: Transaction,
  ids: readonly string[],
  ours: readonly ConsentRow[],
  theirs: readonly ConsentRow[],
): Promise<Pick<Totals, 'consents' | 'goalContentDeleted'>> {
  const of = (rows: readonly ConsentRow[], id: string) => rows.filter((row) => row.userId === id);
  const withdrawnSince = (id: string) =>
    of(theirs, id).some(
      (row) => row.withdrawnAt !== null && !of(ours, id).some((own) => own.id === row.id && own.withdrawnAt !== null),
    );
  const withdrawn = ids.filter(withdrawnSince);
  for (const id of withdrawn) await deleteGoalContent(tx, id);
  const changed = ids.filter((id) => JSON.stringify(of(ours, id)) !== JSON.stringify(of(theirs, id)));
  await replaceConsents(
    tx,
    changed,
    theirs.filter((row) => changed.includes(row.userId)),
  );
  return { consents: changed.length, goalContentDeleted: withdrawn.length };
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
