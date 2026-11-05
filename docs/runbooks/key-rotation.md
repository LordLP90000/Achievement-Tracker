# Key-rotation runbook: the KEK, the blind-index key and the rate-limit key

Status: M6, 2026-11-05. Rehearsed on the local Compose stack and automated: the e2e suite runs both drills on every
CI run (`test/e2e/smoke.test.ts`, "rehearses a KEK rotation" and "rehearses a blind-index key rotation"). The staging
rehearsal waits for the hosting option (O-01) and a real 1Password Connect server (O-03). Controls: ADR-0013,
ADR-0020, Q-56; threats E-11, I-09, RR-3; R-ENC-01, R-ENC-02, R-ENC-05.

## 1. When

- **A key may be exposed**: rotate it at once. Whoever holds the KEK and a copy of the database reads every
  account's data; whoever holds the blind-index key and a copy of the database can test guessed addresses (RR-3).
  A possible exposure is a security incident: start the breach-notification runbook (`docs/runbooks/breach.md`) at the same time.
- **Someone with access leaves**: an operator who could read the KEK vault or the secret store.
- **Planned rotations**: no schedule is set yet. A question for the PM in the M6 review.

## 2. Before you start

- [ ] Announce the maintenance window: the API and the worker stay stopped from the first step of a rotation to its
      last (§7).
- [ ] A backup of the database from the last day exists.
- [ ] The new key comes from a CSPRNG, in base64: 32 bytes for the KEK, 32 to 64 bytes for the blind-index and
      rate-limit keys (`openssl rand -base64 32`). Never reuse a key, and never use one key for two purposes: the
      configuration refuses the blind-index and rate-limit keys if they are equal to each other or to a local KEK, and a
      previous key equal to the current one.
- [ ] The commands run as a one-off job of the running image with the migrator's role (`DATABASE_URL_MIGRATOR`), like
      the migration: `node dist/maintenance.js <command>`. On the local stack:
      `compose run --rm --no-deps -T -e … migrate dist/maintenance.js <command>` (`compose` is
      `docker compose -f docker/compose.yml`). In production every key comes from the secret store as an environment
      variable, never on a command line.

## 3. KEK rotation: `rewrap-data-keys`

1. **Create the new KEK item** in the KEK's vault (`OP_KEK_VAULT_ID`): a new item, with the new key in a concealed
   field labelled `kek`. Never change the key of the existing item: its old key would be gone, and with it every
   data key it wrapped (ADR-0020). Note both item IDs.
2. **Issue a new Connect token** with read access to that vault only (E-11: the token is rotated with the KEK). Keep
   the old token until step 6.
3. **Stop the API and the worker**: `compose stop api worker`. Production: scale both to zero.
4. **Re-wrap every data key** with `OP_KEK_ITEM_ID=<new item>`, `OP_PREVIOUS_KEK_ITEM_ID=<old item>` and the new
   token. On the local stack, as in the drill: `-e KEK_SOURCE=env -e LOCAL_KEK=<new key> -e PREVIOUS_LOCAL_KEK=<old key>`.
   The AEAD decides which KEK opens a data key, never its label.
   - Expected: exit code 0 and one log line `data keys re-wrapped` with counts only: `current`, `rewrapped`,
     `unknown` (0). Run it a second time: `rewrapped` 0.
   - Exit code 1 with `MaintenanceIncompleteError: unknown_data_keys`: some data keys open with neither KEK. They were
     left as they are; everything else was re-wrapped. Their `user_keys.kek_id` names the item that wrapped them: run
     the command again with that item as the previous KEK. If no item opens them, those accounts' data is lost: a
     breach of availability (`docs/runbooks/breach.md`).
   - Exit code 1 with `MaintenanceRefusedError: processes_connected`: an API or a worker is still connected. Stop it
     (step 3) and run again.
   - Any other failure: run it again. It works in batches of 1 000 keys, is idempotent and resumes where it stopped.
5. **Start the worker and the API with the new item and token**: `compose up --detach --wait --no-deps api worker`.
   Check `/health/ready` (the KEK's wrap/unwrap self-test), the worker's `worker ready` line, and a sign-in with a test
   account followed by `GET /v1/me`: its address only decrypts with a data key the new KEK opens.
6. **Revoke the old Connect token, and archive the old item**: do not delete it yet. Restoring a backup taken before
   the rotation needs it (restore runbook, step 6). Delete it once the last such backup has expired, 30 days after
   the rotation (ADR-0020).
7. **Record the rotation**: the date, both item IDs, the counts, the duration, the day the old item may go.

## 4. Blind-index key rotation: `reindex-email-blind-index`

1. **Generate the new key** and put it in the secret store next to the current one. The API keeps the current key
   until step 4.
2. **Stop the API and the worker** (§3, step 3). The API must be stopped: with the old key it would let a second
   account register an address that is already taken.
3. **Index every address again** with `BLIND_INDEX_KEY=<new key>`, `PREVIOUS_BLIND_INDEX_KEY=<current key>` and the
   current KEK's settings: the command decrypts every address, and every pending new address of an email change, with
   the account's data key. On the local stack, as in the drill:
   `-e KEK_SOURCE=env -e LOCAL_KEK=… -e BLIND_INDEX_KEY=<new key> -e PREVIOUS_BLIND_INDEX_KEY=<current key>`.
   - Expected: exit code 0 and one log line `blind indexes re-indexed` with counts only: `current`, `reindexed`,
     `unknown` (0). Run it a second time: `reindexed` 0.
   - Exit code 1 with `MaintenanceIncompleteError: unknown_blind_indexes`: some indexes are under neither key, or an
     account's data key does not open with the KEK. They were left as they are; everything else was re-indexed. Those
     accounts cannot sign in with the new key. An index under an older key means an earlier rotation was not finished:
     run the command again with that key as the previous one. A data key the KEK does not open: finish the KEK
     rotation first (§3).
   - Exit code 1 with `MaintenanceRefusedError: processes_connected`: stop them (step 2) and run again.
   - Any other failure: run it again. It works in batches of 500 accounts, is idempotent and resumes where it stopped.
4. **Start the worker, and the API with the new key** as `BLIND_INDEX_KEY` (the worker holds no blind-index key).
   Check a sign-in with a test account, and that registering its address again adds no account.
5. **Keep the old key** in the secret store, out of every running process, until the last backup taken before the
   rotation has expired (30 days): restoring such a backup needs it (restore runbook, step 6). Then delete it.
6. **Record the rotation**: the date, the counts, the duration, the day the old key may go.

## 5. The rate-limit key and the Connect token

- **Rate-limit key** (`RATE_LIMIT_KEY`, the API only): no command. Set the new key and restart the API. The buckets,
  which live 24 hours, start empty (ADR-0020, Q-14). Nothing needs keeping.
- **The Connect token alone** (E-11): issue a new token with read access to the KEK vault only, set it for the API,
  the worker and the maintenance job, restart the API and the worker, then revoke the old token. No command.

## 6. After a restore

A backup taken before a rotation holds the data keys and blind indexes of its day. After restoring it, run
`rewrap-data-keys` and then `reindex-email-blind-index`, each with the old key as the previous one, before the replay:
restore runbook, step 6, which explains the order.

## 7. Drill record and timing

| Date | Where | Result |
|------|-------|--------|
| 2026-11-05 | Local Compose stack, automated in the e2e suite (every CI run) | **KEK**: an account signed up; the API and the worker stopped; `rewrap-data-keys` with a new local KEK and the old one as previous (`rewrapped` above 0, `current` 0, `unknown` 0; a second run `rewrapped` 0); the API and the worker started with the new KEK; the account signed in and `GET /v1/me` returned its address. **Blind index**: an account signed up; `reindex-email-blind-index` with a new key (`reindexed` above 0, `unknown` 0; a second run `reindexed` 0); the API started with it; the account signed in, and registering its address again answered 202 and added no account. No key appeared in any output, nor the address in the re-index's |
| – | Staging, with a real 1Password Connect server | Waits for the hosting option (O-01) and Connect (O-03) |

Both commands are bounded by the number of accounts, not by their data: one key or one or two addresses per
account. The staging drill measures the window on a database of realistic size (O-01).