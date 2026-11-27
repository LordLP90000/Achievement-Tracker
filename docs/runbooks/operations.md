# Operations runbook: running Questline day to day

Status: M6, 2026-11-05. Written for the local Compose stack and a generic host; the host-specific commands (deploy,
scaling, backups, alerting) follow with the hosting option (O-01). The other runbooks: restore
(`docs/runbooks/restore.md`), key rotation (`docs/runbooks/key-rotation.md`), breach notification
(`docs/runbooks/breach.md`). Architecture: §4.1 (configuration), §4.7 (background work), §8 (deployment).

## 1. The processes

One image per commit (`docker/Dockerfile`, distroless, non-root, read-only root filesystem), five ways to start it:

| Process | Command | Database role | Runs |
|---------|---------|---------------|------|
| Bootstrap | `dist/bootstrap-db.js` | administrator | Once per database, and after a restore (idempotent): roles, grants |
| Migration | `dist/migrate.js` | `questline_migrator` | Before every release, as a one-off job |
| API | `dist/server.js` | `questline_app` | Always; any number of instances |
| Worker | `dist/worker.js` | `questline_worker` | Always; one is enough, more are safe (jobs take an advisory lock, emails `SKIP LOCKED`) |
| Maintenance | `dist/maintenance.js <command>` | `questline_migrator` | By hand: ADR-0020's commands with the API and the worker stopped; the incident notice while they run (ADR-0021, breach runbook §7) |

Every process validates its configuration at start and refuses to start with a list of the variables at fault,
never their values; production refuses development settings such as `KEK_SOURCE=env` or `RATE_LIMIT_SCALE`
(architecture §4.1, E-08). The API and the worker fetch the KEK from 1Password Connect once at start and refuse to
start without it; the error names a class only (`connect_http_401`, `connect_timeout`, `connect_unreachable`,
`invalid_item`, `invalid_kek`).

## 2. Releasing a version

1. CI is green for the commit, all jobs; the image is pinned by its digest.
2. Run the migration with the new image. Migrations only expand while the old version still runs (expand/contract),
   so the running version keeps working.
3. Roll out the worker, then the API. A new API instance takes traffic once `/health/ready` answers 200.
4. Check: `/health/ready` on every instance, the worker's `worker ready` line, a sign-in with a test account.
5. Going back: deploy the previous image digest. Migrations are not rolled back; the next one contracts, once no
   running version needs the old shape.

## 3. Health and what to watch

- `/health/live`: the process runs. `/health/ready`: the database answers and the KEK's wrap/unwrap self-test passed;
  503 otherwise, with the reason in the log. Successful probes are not logged (Q-28). The API asks the database once
  for all probes that arrive together and gives that answer for one second (D-10): an answer is at most a second
  old, and the warning of a failed check appears once a second, not once per probe.
- Logs are JSON, one line per request (`method`, `route`, `status`, `duration_ms`; no addresses, tokens, bodies or
  IDs other than `request_id`, R-LOG-02). Until the host's monitoring exists (O-01), alert on these messages:

| Message | Process | Meaning, first step |
|---------|---------|---------------------|
| `job failed`, `scheduled jobs failed` | worker | A job rolled back; `error_code` gives the class (`pg_57014`: a statement timeout). It is retried after its interval. Repeated: §4 |
| `email delivery paused: the relay failed` | worker | The relay refused or is unreachable; delivery pauses 60 s each time (D-07). Repeated: the relay's status and the SMTP credentials |
| `email dead-lettered` | worker | An email was given up: after 8 attempts, or at once on a permanent refusal or an unreadable payload. Check the class (§4) |
| `email delivery off: no SMTP settings, emails stay queued` | worker | Outside production only: no relay configured |
| `readiness check failed`, `readiness check timed out` | API | The database is unreachable or slow |
| `password hashing saturated` | API | More sign-ins than Argon2id can take: they get 429 with `Retry-After: 1` (D-01). Sustained: a flood, or too little CPU |
| `rate limited` | API | A client hit a limit; only the scope is logged (`ip-auth`, `email-mail`, `user-mail`, `user`, `email-login`, `user-password`). Many at once: abuse, or a client bug |
| `rate limits scaled: development and test only (Q-60)` | API | Never in production (refused at start). Seen anywhere but the DAST stack: find out why |
| `export interrupted` | API | A data export failed after its first part was sent, so the connection was cut and the user got an incomplete file (ADR-0022); the error's class is logged, never data. The export counted as one of the user's two a day. A client that breaks its download off leaves no such line. `DecryptionError`: a record of that account does not open with its key — find out why before anything else (key-rotation runbook). A database error: see `job failed` |
| `maintenance refused` | maintenance | A command was started while an API or a worker was connected |
| `shutdown timed out`, `shutdown failed` | API, worker | A process did not stop cleanly within its grace period |

## 4. Background work

The worker sends the outbox every 5 s and runs its jobs every 60 s when due: `evaluate_goals` (every minute, the
users whose local midnight has come) and 14 retention jobs (hourly; R-PRIV-07): `purge_unverified_accounts`,
`purge_deleted_accounts`, `purge_one_time_tokens`, `purge_session_tokens`, `purge_sessions`,
`purge_webauthn_challenges`, `purge_second_factor_challenges`, `purge_pending_totp_secrets`, `purge_audit_events`,
`purge_rate_limit_buckets`, `purge_idempotency_keys`, `purge_dead_letters`, `purge_tombstones`, `purge_job_runs`.
Nothing needs starting by hand.

Status, as the database administrator, counts only:

```sql
-- The last run of every job, and failures in the last day.
select distinct on (job_name) job_name, status, started_at, finished_at, processed, error_code
from job_runs order by job_name, started_at desc;
select job_name, error_code, count(*) from job_runs
where status = 'failed' and started_at > now() - interval '1 day' group by 1, 2;

-- The outbox: queued, overdue by more than 10 minutes, and dead letters by class.
select count(*) filter (where dead_at is null) as queued,
       count(*) filter (where dead_at is null and next_attempt_at < now() - interval '10 minutes') as overdue,
       count(*) filter (where dead_at is not null) as dead
from email_outbox;
select template, last_error_code, count(*) from email_outbox where dead_at is not null group by 1, 2;
```

- A **dead letter** is not sent again: it keeps its encrypted payload for 7 days, then `purge_dead_letters` deletes
  it. The user asks again (a new verification or reset link); security notices are lost, which is why a dead letter
  of `password_changed_notice`, `email_change_notice` or `sign_in_methods_changed_notice` deserves a look at the
  relay. Classes such as `smtp_eenvelope_550` are the recipient's server refusing; `payload_unreadable` means the
  data key could not open it; if many, check the KEK (key-rotation runbook, §3).
- **A job that keeps failing** with the same class: its rows stay until it succeeds; nothing is lost, but retention
  falls behind. Look at the database's load and locks first.

## 5. Routine

| When | What |
|------|------|
| Daily | The nightly CI run: fresh vulnerability databases (Trivy, osv-scanner) and the load and DAST job `perf` (`npm run test:load`, `npm run test:dast`); a red run is fixed or put to the PM the same day |
| Weekly | The job and outbox queries (§4); dependency and image updates under the 7-day rule (ADR-0016); the Node.js releases since the last look, its security releases first (both below) |
| Yearly | The KEK rotation with a new Connect token (Q-63, key-rotation runbook §3) |
| On their dates | Expiring exceptions: `.trivyignore.yaml` (empty since 2026-11-19) and `osv-scanner.toml`; deleting an old KEK item or blind-index key 30 days after a rotation (key-rotation runbook); re-pinning the ZAP image (Q-59) |
| Monthly, once staging exists | A restore drill on staging (restore runbook; the e2e suite rehearses it on every push already) |

**Image updates.** A new base is a new digest in `docker/Dockerfile`, adopted when it is 7 days old and the image
built on it passes Trivy. Take the newest digest that is old enough, which is often not the newest image: the
registry lists every digest with its upload time (`https://gcr.io/v2/distroless/nodejs26-debian13/tags/list`). The
tag of the build image is rebuilt now and then and points at a younger digest afterwards; the rule goes by the age
of the digest. The build takes three Debian packages out of the distroless image, because nothing in the
image uses them: the system OpenSSL and the zstd and zlib that only it needs (ADR-0017 as amended). If a build on a
new digest stops with `cannot remove libssl3t64, libzstd1, zlib1g: …`, the new base needs one of them, and the
message names what needs which library. That package then stays: take its name out of the `RUN` line of the
Dockerfile, and its name and libraries out of what `test/e2e/smoke.test.ts` expects to be gone, and report the
change. The check itself is never removed or bypassed.

**Node.js releases.** No scanner in CI sees Node.js or the OpenSSL, zlib, zstd and undici it bundles: they are in no
package list (threat T-10). So someone reads its release notes and security announcements
(`https://nodejs.org/en/blog/vulnerability`) every week. A security release is adopted with the distroless image
that carries it, in one step: the build image, the runtime digest and `.nvmrc`. Two checks fail when the three
disagree: `test/supply-chain/node-version.test.ts` on the files, and `test/e2e/smoke.test.ts` on the built image.

## 6. Secrets

`DATABASE_URL_*` (one role per process), `OP_CONNECT_TOKEN` and the KEK item in 1Password, `BLIND_INDEX_KEY`,
`RATE_LIMIT_KEY` (API) and `SMTP_PASSWORD` (worker) come from the secret store as environment variables, never from
a file in the image or a command line. The keys rotate by the key-rotation runbook. A database password: change it
with `ALTER ROLE` as the administrator, then in the secret store, then restart the processes that use it. The SMTP
password: in the relay, then in the secret store, then restart the worker.

## 7. When something is wrong

- Personal data may be exposed, lost or altered: the breach-notification runbook, at once.
- The database is lost or corrupted: the restore runbook.
- A key may be exposed: the key-rotation runbook, and the breach runbook.
- Everything else: the log lines of §3, the queries of §4, then the code; record what happened in the incident
  record.