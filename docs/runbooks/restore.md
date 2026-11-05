# Restore runbook: the database from a backup, with tombstone replay

Status: M6, 2026-11-05. Rehearsed on the local Compose stack and automated: the e2e suite runs this drill on every
CI run (`test/e2e/smoke.test.ts`, "rehearses a restore"). The staging rehearsal waits for the hosting option (O-01).
Controls: Q-13, ADR-0006, ADR-0020; threats I-18 and RR-4; DPIA R-8. Being built: re-applying what a restore loses
besides deletions (§6, Q-57).

## 1. When

- Restore only when the live database is lost, or its data is wrong (corruption, a failed migration, an operator's
  mistake) and cannot be repaired in place. Everything after the restore point is lost (§6). So choose the latest
  point before the incident: point-in-time recovery where the host offers it (H-2).
- Losing or corrupting personal data is a personal data breach (availability, integrity): start the
  breach-notification runbook (M6, to come) at the same time.

## 2. Before you start

- [ ] The backup is at most 30 days old. Backups expire after 30 days, tombstones after 35 (Q-13). So the database
      the restore replaces holds a tombstone for every account deleted since any backup that can still be restored.
- [ ] **Keep the current database, the one the restore replaces.** Never drop or overwrite it before the replay
      (step 6): it holds the tombstones of every account deleted after the backup. If it is damaged, copy at least
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
6. **Replay the tombstones** (ADR-0020), with the migrator's role and the replaced database read only, through the
   worker's role:
   `compose run --rm --no-deps -T -e TOMBSTONE_SOURCE_DATABASE_URL=postgres://questline_worker:<password>@db:5432/questline_replaced migrate dist/maintenance.js replay-tombstones`.
   - Expected: exit code 0 and one log line `tombstones replayed` with `imported` (tombstones taken over, each with
     its date) and `deleted` (accounts deleted again, with everything they owned). Run it a second time: `imported`
     and `deleted` are 0.
   - Exit code 1 with `MaintenanceRefusedError: processes_connected`: an API or a worker is still connected to one
     of the two databases. Stop it (step 1) and run again.
   - In production the password comes from the secret store as an environment variable, never on a command line.
   - The replaced database cannot be read at all: run it without the variable. Then it replays only the restored
     database's own tombstones, which is enough only for a restore to the latest point.
7. **Keys rotated since the backup**: run the key-rotation runbook's commands (`rewrap-data-keys`,
   `reindex-email-blind-index`, ADR-0020, M6, to come) before the API starts.
8. **Start the worker and the API**: `compose up --detach --wait --no-deps api worker`. Check `/health/ready`, the
   worker's `worker ready` line, and a sign-in with a test account.
9. **Changes lost after the restore point** (§6): until the re-apply of Q-57 is built, list in the incident record what the
   period contained, as far as the replaced database shows it.
10. **The replaced database** is a copy of personal data: keep it only as long as the investigation needs it, and at
    most 30 days, like a backup (data inventory C14). Then drop it.
11. **Record the restore** in the incident record: the restore point, the replay's counts, the duration.

## 4. Drill record

| Date | Where | Result |
|------|-------|--------|
| 2026-11-05 | Local Compose stack, automated in the e2e suite (every CI run) | Two accounts signed up, a dump taken, then one account hard-deleted by the worker's job, its deletion request moved 30 days back. After the restore the account was back; the replay deleted it again (`imported` 1, `deleted` 1; a second run 0 and 0). Its tombstone kept its date. The other account signed in; the deleted one got 401. PUBLIC had no access to the restored database after the bootstrap. The command refused while the API ran. No password, address or account ID appeared in any output. The whole drill, its two sign-ups included, took about 22 s on a database with a handful of accounts |
| – | Staging | Waits for the hosting option (O-01) |

## 5. Timing

A real restore takes as long as the host's restore of a database of that size, plus the replay. The replay deletes
100 accounts per transaction with everything they own, as the hourly hard delete does: it is bounded by the
accounts deleted since the restore point, not by the database's size. The staging drill measures both (O-01).

## 6. What a restore to an earlier point does not recover (decided: Q-57, being built)

The replay restores completed deletions only. Everything else that happened between the restore point and the
incident is lost, including changes users made for their privacy or security:

- **Deletion requests**: the accounts are active again, and their hard delete after 30 days never comes.
- **Consent withdrawals**: the goal content that was deleted is back (R-PRIV-04).
- **Password changes and resets**: the old password works again, even if it was the reason for the change.
- **Revoked sessions, removed passkeys, TOTP turned on, used recovery codes**: each works again, or is off again.
- **Email changes**: the old address is back.
- **New accounts, goals, check-ins and audit events** are gone. The owners are not told.

The PM decided (Q-57) that the replay re-applies all of these but the new data, and revokes every session (ADR-0020,
amendment). Until that is built in M6, choose the latest possible restore point, and record what the period
contained (step 9).
