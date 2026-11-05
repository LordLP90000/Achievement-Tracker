# Restore runbook: the database from a backup, with tombstone replay

Status: M6, 2026-11-05. Rehearsed on the local Compose stack and automated: the e2e suite runs this drill on every
CI run (`test/e2e/smoke.test.ts`, "rehearses a restore"). The staging rehearsal waits for the hosting option (O-01).
Controls: Q-13, Q-57, ADR-0006, ADR-0020; threats I-18 and RR-4; DPIA R-8. The replay also re-applies what a restore loses
besides deletions (§6).

## 1. When

- Restore only when the live database is lost, or its data is wrong (corruption, a failed migration, an operator's
  mistake) and cannot be repaired in place. Everything after the restore point is lost (§6). So choose the latest
  point before the incident: point-in-time recovery where the host offers it (H-2).
- Losing or corrupting personal data is a personal data breach (availability, integrity): start the
  breach-notification runbook (`docs/runbooks/breach.md`) at the same time.

## 2. Before you start

- [ ] The backup is at most 30 days old. Backups expire after 30 days, tombstones after 35 (Q-13). So the database
      the restore replaces holds a tombstone for every account deleted since any backup that can still be restored.
- [ ] **Keep the current database, the one the restore replaces.** Never drop or overwrite it before the replay
      (step 7): it holds the tombstones of every account deleted after the backup. If it is damaged, copy at least
      its `deleted_user_tombstones` table first.
- [ ] The 1Password item of the KEK that wrapped the backup's data keys still exists. After a key rotation, the old
      item is kept until the last backup from before the rotation has expired (ADR-0020).
- [ ] Note the time and announce the downtime: the API and the worker stay stopped until step 8.

## 3. Steps

The commands are those of the local stack, as rehearsed (`docker compose -f docker/compose.yml …`, shortened to
`compose`). In production each step is the host's equivalent (O-01).

1. **Stop the API and the worker**: `compose stop api worker`. Production: scale both to zero.
2. **Restore the backup into a new database**:
   `compose exec -T db psql -U postgres -c 'create database questline_restored owner questline_migrator'`, then
   `compose exec -T db pg_restore -U postgres -d questline_restored -e <dump>`. Production: the host's restore or
   point-in-time recovery into a new database or instance.
3. **Swap the databases**: the restored one takes the live name, the replaced one is kept:
   `alter database questline rename to questline_replaced`, then
   `alter database questline_restored rename to questline` (as an administrator, connected to `postgres`).
   Production: point the database URLs at the restored database instead.
4. **Access rights**: run the bootstrap again, which is idempotent: `compose run --rm --no-deps db-init`. Without it,
   every role can connect to the restored database (PUBLIC's default `CONNECT`).
5. **Migrations**: `compose run --rm --no-deps migrate`. This is needed when the backup predates a migration of the
   running image; otherwise it does nothing.
6. **Keys rotated since the backup** (ADR-0020): the restored database holds the data keys and blind indexes of the
   backup's day. Bring them under the current keys before the replay, in this order, with the commands of the
   key-rotation runbook (`docs/runbooks/key-rotation.md`):
   - `rewrap-data-keys`, with the KEK that wrapped the backup's data keys as the previous KEK (its item is named in
     `user_keys.kek_id`);
   - then `reindex-email-blind-index`, with the blind-index key of the backup's day as `PREVIOUS_BLIND_INDEX_KEY`.
     It reads the addresses with the current KEK, so the re-wrap comes first.
   - Why before the replay: the replay compares addresses by their blind index. Under two keys every address looks
     moved, and an account holding a moved address under the old key is missed: an unverified account the replaced
     database purged then stays, and its re-index fails on the clash (`test/integration/restore-replay.test.ts`).
   - No rotation since the backup: skip this step.
7. **Replay what happened since the restore point** (ADR-0020, Q-13, Q-57), with the migrator's role on both
   databases. It reads the replaced database only in read-only transactions, which refuse any change, DDL included:
   `compose run --rm --no-deps -T -e REPLACED_DATABASE_URL=postgres://questline_migrator:<password>@db:5432/questline_replaced migrate dist/maintenance.js replay-after-restore`.
   In this order it:
   - takes over the replaced database's tombstones with their dates and deletes every account they name;
   - for every account both databases hold, takes over its deletion state (requests with their dates, and
     reactivations), a newer password, an address verified since, and a changed address. Accounts that swapped
     addresses are included. An unverified account the replaced database purged is deleted when another account
     took its address. It also takes over the account's passkeys, TOTP secret and recovery codes, and its consents;
     a consent withdrawn since deletes the goal content again;
   - deletes every session with its tokens: every user signs in again.
   - Expected: exit code 0 and one log line `replayed after restore` with counts only: `imported`, `deleted`,
     `deletionStates`, `passwords`, `verifications`, `addresses`, `addressConflicts`, `unverifiedDeleted`,
     `signInMethods`, `consents`, `goalContentDeleted`, `sessions`. Run it a second time: every count is 0.
   - Exit code 1 with `MaintenanceIncompleteError: address_conflicts`: some addresses stayed as restored. Each is held
     by a verified account the replaced database lacks without a tombstone, or by an account whose own move was held
     back. Everything else was replayed. Compare `users.email_blind_index` in both databases for those accounts,
     decide with the PM which account keeps each address, set it by hand, and run the command again.
   - Exit code 1 with `MaintenanceRefusedError: processes_connected`: an API or a worker is still connected to one
     of the two databases. Stop it (step 1) and run again.
   - In production the password comes from the secret store as an environment variable, never on a command line.
   - The replaced database cannot be read at all: run it without the variable. Then it replays only the restored
     database's own tombstones and deletes every session, which is enough only for a restore to the latest point.
8. **Start the worker and the API**: `compose up --detach --wait --no-deps api worker`. Check `/health/ready`, the
   worker's `worker ready` line, and a sign-in with a test account.
9. **What is lost for good** (§6): accounts and data created after the restore point. Record in the incident record
   what the period contained, as far as the replaced database shows it: the breach assessment needs it.
10. **The replaced database** is a copy of personal data: keep it only as long as the investigation needs it, and at
    most 30 days, like a backup (data inventory C14). Then drop it.
11. **Record the restore** in the incident record: the restore point, the replay's counts, the duration.

## 4. Drill record

| Date | Where | Result |
|------|-------|--------|
| 2026-11-05 | Local Compose stack, automated in the e2e suite (every CI run) | Two accounts signed up, a dump taken, then one account hard-deleted by the worker's job, its deletion request moved 30 days back, and the other account's password changed. After the restore the deleted account was back and the old password worked; the replay deleted the account again and took over the new password, and deleted every session (`imported` 1, `deleted` 1, `passwords` 1; a second run all 0). Its tombstone kept its date. The other account signed in with its new password only; the deleted one got 401. PUBLIC had no access to the restored database after the bootstrap. The command refused while the API ran. No password, address or account ID appeared in any output. The whole drill, its two sign-ups included, took about 22 s on a database with a handful of accounts |
| – | Staging | Waits for the hosting option (O-01) |

## 5. Timing

A real restore takes as long as the host's restore of a database of that size, plus the replay. The replay deletes
100 accounts per transaction with everything they own, as the hourly hard delete does: it is bounded by the
accounts deleted since the restore point, not by the database's size. The staging drill measures both (O-01).

## 6. What a restore to an earlier point loses, and what the replay takes over (Q-57)

Without the replay, everything that happened between the restore point and the incident is lost, including changes
users made for their privacy or security:

- **Deletion requests**: the accounts are active again, and their hard delete after 30 days never comes.
- **Consent withdrawals**: the goal content that was deleted is back (R-PRIV-04).
- **Password changes and resets**: the old password works again, even if it was the reason for the change.
- **Revoked sessions, removed passkeys, TOTP turned on, used recovery codes**: each works again, or is off again.
- **Email changes**: the old address is back.
- **New accounts, goals, check-ins and audit events** are gone. The owners are not told.

The PM decided (Q-57) that the replay re-applies all of these but the new data, and revokes every session (ADR-0020,
amendment), and it does (step 7). It also takes over an address verified since: unverified, the account would be
purged after its 7 days. New data stays lost: choose the latest possible restore point, and record what the period
contained (step 9).
