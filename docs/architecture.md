# Architecture

Status: M0 proposal v2 (2026-10-22, updated for the PM decisions). Implements the requirements in
`docs/requirements.md`; decisions are recorded in `docs/DECISIONS.md` (ADR-0001 … ADR-0015).

## 1. Shape: a modular monolith with a separate worker process

```
 Mobile app (iOS / Android)
   │  HTTPS (TLS 1.2+/1.3, HSTS), JSON, Bearer access token
   ▼
 Edge: provider load balancer (TLS termination, per-IP limits)   ── private network ──┐
   │                                                                                   │
   ▼                                                                                   ▼
 ┌──────────────────────────────┐        ┌──────────────────────────────┐   ┌──────────────────────┐
 │ questline-api (Fastify)      │        │ questline-worker             │   │ 1Password Connect    │
 │  /health, /v1/*              │        │  outbox → SMTP relay         │   │ (self-hosted): KEK   │
 │  role: questline_app (RLS)   │        │  retention, settlement jobs  │   │ read once at startup │
 └──────────────┬───────────────┘        │  role: questline_worker      │   └──────────────────────┘
                │ parameterized SQL      └──────────────┬───────────────┘
                ▼                                       ▼
 ┌─────────────────────────────────────────────────────────────────────┐   ┌──────────────────────┐
 │ PostgreSQL 17 (private, encrypted disk, encrypted backups ≤ 30 d)   │   │ SMTP relay (TLS)     │
 │ migrations by role questline_migrator (separate job)                │   │ approved processor,  │
 └─────────────────────────────────────────────────────────────────────┘   │ operator TBD (O-02)  │
                                                                           └──────────────────────┘
```

- One codebase, two entrypoints (`src/server.ts`, `src/worker.ts`), one container image, started with a
  different command. Both are stateless; all state is in PostgreSQL.
- No Redis, no message queue, no object storage in v1 (ADR-0009). Everything that needs shared state goes
  through PostgreSQL behind small interfaces so it can be swapped later.
- The server never calls user-supplied URLs; its only outbound connections are PostgreSQL, the self-hosted
  1Password Connect server (API process, once at startup to load the KEK — ADR-0013) and the SMTP relay (worker
  only — ADR-0014), allowlisted at the network level in M6.

## 2. Layers inside a module

Each feature module (`src/modules/<feature>/`) is organised the same way; dependencies point inwards.

```
 routes.ts    HTTP: Fastify routes, Zod request/response schemas (strict, allowlisted), problem mapping
    │
 service.ts   Use cases: transactions, authorization context, calls domain functions, writes audit/outbox/XP
    │
 repository.ts  Persistence: Drizzle queries, ALWAYS scoped by user_id (type-enforced), field encryption
    │
 src/domain/*  Pure functions: progress, resets, XP, levels, ranks, gambles, streaks, state machines. No I/O, no Date.now(), no randomness.
```

Rules enforced by lint/tests:

- `src/domain/**` imports nothing from `src/platform` or `src/modules` (dependency-cruiser rule) and has no side
  effects — this is the part covered by Stryker mutation testing. Its tests (`src/domain/*.test.ts`) may import only
  the domain, Vitest and `fast-check` (rule `domain-tests-use-only-the-domain-and-test-tools`); property tests run
  with a fixed seed (`test/helpers/fast-check-setup.ts`).
- Only `src/platform/db` and repository files (`*repository.ts`) use the query builder (`drizzle-orm`); the drivers
  and every SQL fragment stay in `src/platform/db` (dependency-cruiser + ESLint, ADR-0003 amendment). Services and
  routes call repositories.
- Goal-content repositories (M3) are created per request via `repos.forUser(userId)`; there is no API to build one
  without a user ID. Before a user is known (registration, verification, login, password reset) the account
  repositories read only the RLS-exempt tables — `users` by email blind index, `one_time_tokens` and
  `session_tokens` by token hash. Cross-user access exists only in worker-role code: the retention jobs
  (`src/modules/privacy/retention*.ts`) and the outbox delivery (`src/platform/email/delivery.ts`).
- Every transaction is bound to its user with a transaction-local `app.user_id` (RLS, ADR-0003) before it reads or
  writes an RLS table; pre-authentication transactions bind as soon as the account is identified. Worker
  transactions set `app.user_id` to the user being processed, or run as `questline_worker`, whose policies see every
  row, for retention and the outbox.
- Output goes through a Zod response schema (`.strict().parse`) before serialisation, so a new column can never
  leak into a response by accident.

## 3. Request lifecycle (API)

| Step | Component | Behaviour |
|------|-----------|-----------|
| 1 | `request-context` plugin | Generates a random UUID request ID (client-supplied IDs are ignored), attaches a child logger with only `request_id`, `method`, `route` (pattern, not raw URL). |
| 2 | Body parsing | JSON only (`415` otherwise), `bodyLimit` 64 KiB, `onProtoPoisoning: 'error'`, `onConstructorPoisoning: 'error'`. |
| 3 | `security-headers` plugin | HSTS, `X-Content-Type-Options`, CSP `default-src 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Resource-Policy: same-origin`, `X-Frame-Options: DENY`; `Cache-Control: no-store, Pragma: no-cache` when the route is authenticated. Never sets CORS headers. |
| 4 | `rate-limit` (`src/modules/rate-limit`) | Token buckets and failure backoff in PostgreSQL (`rate_limit_buckets`, ADR-0009), keyed by HMAC(key of the UTC day, `scope:subject`) — never a raw address or email (Q-14). After the auth guard, an `onRequest` hook takes the per-client bucket on public routes (IPv4 address, IPv6 /64) and the per-user bucket on every authenticated route (the contract documents `429` on every `/v1` operation, Q-30 — like the guard, nothing to opt into, so no route can be forgotten); handlers add per-address mail limits, login backoff per submitted address and re-auth/password-change backoff per user. Decisions are pure functions (`policy.ts`); the store locks the bucket row. `429` + `Retry-After`, logged with the scope only. Values: A-31. |
| 5 | `auth-guard` (`src/modules/sessions/guard.ts`) | Deny by default: an `onRequest` hook on the `/v1` scope (before body parsing) requires `Authorization: Bearer <access token>` (scheme case-insensitive) on every route whose config is not `public: true` — exactly the operations with `security: []` in the contract, checked by `contract/deny-by-default.test.ts`. Two queries: the token's SHA-256 in `session_tokens` (RLS-exempt, unexpired), then — bound to that user — the session in `sessions` (RLS; not revoked, before its absolute expiry). Attaches `request.principal = { userId, sessionId, lastReauthAt }`. Missing/invalid → `401` `unauthorized` with `WWW-Authenticate: Bearer`. |
| 6 | `reauth-guard` (selected routes) | `requireRecentReauth(principal, now)` (`src/modules/sessions/guard.ts`): the password was entered (login or `POST /v1/auth/reauth`) less than 10 min ago — at exactly 10 min it is not — else `403 urn:questline:problem:reauthentication-required` (R-AUTH-06). |
| 7 | Validation | Zod `strict()` schemas for headers (`Idempotency-Key`, `If-Match`), params, query, body. Failures → `400` problem with `errors[{pointer,message}]`; values are never echoed. |
| 8 | `idempotency` (create routes) | Looks up (user, route, key); replays stored response or rejects body mismatch (ADR-0008). |
| 9 | Handler → service | Runs in one transaction with `SET LOCAL app.user_id`; domain functions compute progress/XP/streaks; writes `xp_events`, `audit_events`, `email_outbox` in the same transaction. |
| 10 | Response | Zod response schema parse → JSON; `ETag` from `version` for mutable resources. |
| 11 | Error handler | Maps known errors to problem types; everything else → `500 urn:questline:problem:internal` (no detail); logs `error.name`, `request_id`, route — never the body. |

## 4. Cross-cutting components (`src/platform`)

### 4.1 Configuration (`platform/config`)

- A single Zod schema parses `process.env` at startup; the process exits with a clear message (no secret values)
  if anything is missing or weak.
- Secret strength checks: base64/hex decodes to ≥ 32 bytes, not all identical bytes, not one of the documented
  example values, not equal to another secret.
- `APP_ENV=production` additionally refuses `KEK_SOURCE=env` (the KEK must come from 1Password Connect, R-ENC-05),
  `LOG_LEVEL=debug|trace`, missing `TRUST_PROXY_HOPS`, any `DATABASE_URL` without `sslmode=verify-full` and any
  SMTP setting without TLS.
- Variables (final list in M1): `APP_ENV`, `PORT`, `LOG_LEVEL`, `TRUST_PROXY_HOPS`, `PUBLIC_LINK_BASE_URL`,
  `DATABASE_URL_APP`, `DATABASE_URL_WORKER`, `DATABASE_URL_MIGRATOR` (migration job only), `KEK_SOURCE`
  (`env` | `onepassword-connect`), `LOCAL_KEK` (dev/test only), `OP_CONNECT_URL`, `OP_CONNECT_TOKEN`,
  `OP_KEK_VAULT_ID`, `OP_KEK_ITEM_ID`, `BLIND_INDEX_KEY`, `RATE_LIMIT_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS`
  (`starttls` | `implicit`), `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`. Secrets are injected as environment
  variables (from 1Password or the host's secret store); only the KEK is fetched from Connect at runtime.
- The worker's email variables (`SMTP_*`, `EMAIL_FROM`, `PUBLIC_LINK_BASE_URL`) are all or none. Outside production,
  none set means email delivery is off and emails stay queued (the local Compose stack has no relay); production
  requires them, a strong `SMTP_PASSWORD` and an `https` `PUBLIC_LINK_BASE_URL` without credentials, query or
  fragment. `SMTP_TLS` has no plaintext value; its port defaults to 587 (`starttls`) or 465 (`implicit`).

### 4.2 Database (`platform/db`)

- Drizzle ORM schema in `platform/db/schema/*.ts`; migrations generated by `drizzle-kit` into
  `platform/db/migrations/` and applied by the migration job (role `questline_migrator`).
- Hand-written SQL only for RLS policies, roles/grants and the token-bucket upsert, each in a migration file
  and always parameterized when executed at runtime.
- Connection pools: small (≤ 10 per instance), statement timeout 5 s, idle-in-transaction timeout 10 s.
- Two drivers' worth of config: `questline_app` for the API, `questline_worker` for the worker.

### 4.3 Cryptography (`platform/crypto`)

| Component | Responsibility |
|-----------|---------------|
| `KeyWrapper` (interface) | `wrap(dek, userId) → {blob, kekId, kekVersion}`, `unwrap(blob, userId, kekId)`. Implementation: `LocalKeyWrapper` (XChaCha20-Poly1305 in-process, AD = `questline|v1|dek|<user_id>`, so a wrapped key never opens as a field value) using the KEK from a `KekSource`; a `KmsKeyWrapper` can be added later if the PM's hosting offers a KMS (ADR-0013). |
| `KekSource` (interface) | Provides the 32-byte KEK once at startup: `EnvKekSource` (dev/test, `LOCAL_KEK`) and `OnePasswordConnectKekSource` (production: `GET /v1/vaults/{vault}/items/{item}` on the self-hosted Connect server with Node's built-in `fetch`; the KEK is the item's field labelled `kek`, base64 of 32 bytes, and the item `version` becomes `kek_version`; redirects refused so the token never leaves for another host, timeout, 64 KiB response limit, vault/item IDs validated as 26-character 1Password IDs). Any failure → the process refuses to start with a `KekSourceError` that carries only a code (`connect_http_401`, `connect_timeout`, `invalid_kek`, …). The KEK lives only in `sodium_malloc` guarded memory and is never logged (R-ENC-05). |
| `KeyService` | `DataKeys` (`data-keys.ts`): creates a user's DEK at registration (the caller stores the wrapped form in `user_keys`) and unwraps a stored DEK into guarded memory for one unit of work, wiping it afterwards even on failure. No plaintext DEK cache while the KEK is local (ADR-0006 as amended); destroyed on account deletion with the `user_keys` row. |
| `FieldCipher` | `encryptText`/`decryptText` (`field-cipher.ts`) over `aead.ts` (`seal`/`open`, one uniform `DecryptionError` for every failure): `0x01‖nonce‖ct‖tag`, AD = user, record, column. Decimals are canonical strings (data-model §1). |
| `PasswordHasher` | Argon2id (ADR-0005) with `needsRehash` for parameter upgrades; NFKC before hashing; at most N hashes at once with a bounded queue (`Semaphore`, D-01 — overflow is refused, not queued forever); `verify(undefined, …)` does the same work against a startup dummy hash, so unknown accounts take as long as known ones. |
| `BlindIndex` | HMAC-SHA256(`BLIND_INDEX_KEY`, NFKC-normalised, lower-cased, trimmed email). |
| `Tokens` | Random tokens with type prefixes, SHA-256 digests, constant-time comparison. `ql_vt_` serves email verification and email-change confirmation; the stored `purpose` keeps them apart. |

### 4.4 HTTP utilities (`platform/http`)

Problem details factory (ADR-0007), security headers, auth guard, re-auth guard, pagination (opaque base64url
cursor `{created_at, id}` validated by Zod), idempotency, optimistic concurrency (`If-Match` ↔ `version`),
content-type enforcement.

### 4.5 Logging (`platform/logging`)

- Pino JSON logs. The default Fastify request/response serializers are replaced by an **allowlist** serializer:
  `request_id`, `method`, `route`, `status`, `duration_ms`, `user_present` (boolean), `client` (enum).
- No headers, no URL query strings, no bodies, no emails, no IDs other than `request_id` are logged. Pino
  `redact` is configured as a second line of defence for common key names (`password`, `token`, `email`, …).
- Successful health probes are not logged (route config `quietOnSuccess`, Q-28): Docker and load balancers call
  them every few seconds. A failed probe logs its `503` request line and a warning with the reason.
- Fastify's own "Server listening at <address>" announcements (one per network interface, with internal IP
  addresses) are dropped by a pino `logMethod` hook; the API logs one `api listening` line with the port (Q-28).
- Audit events are **not** logs: they are rows in `audit_events` with minimal, allowlisted metadata.
- Worker lines carry only `template`, `attempt`, `error_code`, `pause_ms`, `email_delivery`, `job` and `processed`
  besides the message: never an address, token or account ID. A job run that processed nothing logs at `debug`.
- Test harness captures every log line of the whole run (API + worker) and asserts that no seeded secret or
  personal value appears (R-LOG-02).

### 4.6 Time (`platform/time`)

- `Clock` interface (`now(): Date`) injected everywhere; tests use `FakeClock` (`test/helpers/fake-clock.ts`), which
  accepts only instants with `Z` or an explicit offset and moves only through `set`/`advance`. ESLint forbids
  `Date.now()`, `new Date()`, `Date()` and `Temporal.Now` in `src/` outside `platform/time`.
- `time-zones.ts`: `canonicalTimeZone` (A-02) and `localDateOf(instant, timeZone)` — the calendar date of an instant
  in the user's zone, via `Intl` (ADR-0011); all date arithmetic happens on calendar dates in `src/domain/dates.ts`.

### 4.7 Background work (`platform/jobs`)

- `Outbox`: rows inserted inside business transactions; the worker polls every 5 s (`platform/jobs/poller.ts`, a
  round never overlaps the previous one) and claims one due email at a time with `FOR UPDATE SKIP LOCKED`. The claim
  counts the attempt and leases the row for 5 min (`next_attempt_at`), so an email whose worker died is retried when
  the lease ends and a crash loop still reaches the attempt limit. The payload is decrypted with the user's data key
  and rendered from fixed templates (`platform/email/templates.ts`). A link email is sent only while its token still
  works — a replaced, used or expired link is deleted unsent (D-05) — while security notices are always sent. After
  sending, the row is deleted; a failure is retried after 1, 2, 4 … 64 min and dead-lettered after the 8th attempt
  (dead letters keep the encrypted payload for 7 days); a permanent refusal of the recipient or message, or an
  unreadable payload, is dead-lettered at once. A failure of the relay itself pauses all delivery for 60 s, so a
  broken relay or wrong credentials are not hammered (D-07). `last_error_code` holds only a class such as
  `smtp_eenvelope_550`, `payload_unreadable` or `send_failed`.
- `Scheduler` (`platform/jobs/scheduler.ts`, M2): the worker checks every 60 s which jobs are due. A job runs in one
  transaction that first takes `pg_try_advisory_xact_lock` named after the job, so only one worker instance runs it
  at a time, and then reads `job_runs`: the last run of any outcome decides when it is due again, so all instances
  share one schedule and a failing job is retried after its interval instead of every minute. The work and its
  `job_runs` row commit together; a failure rolls the work back and is recorded with an error class only
  (`pg_57014`). Retention jobs (`modules/privacy/retention.ts`, hourly, R-PRIV-07) delete in batches of 1 000 (at
  most 100 per run): unverified accounts after 7 d (cascade), used or expired one-time tokens, session token
  generations whose refresh token expired (rotated ones are kept until then for reuse detection; revocation deletes
  a session's tokens at once), sessions 7 d after revocation, absolute expiry or the end of their refresh lifetime,
  audit events after 90 d, rate-limit buckets untouched for 24 h, dead letters after 7 d, tombstones after 35 d and
  job runs after 30 d. Later milestones add idempotency keys (24 h, M3), daily habit-period closing and gamble
  settlement after local midnight per user timezone (A-20, A-21, M3) and the hard delete of deactivated accounts
  after 30 days with tombstone (R-PRIV-06, M4).
- Email sending is the worker's only outbound call: `SmtpEmailSender` (`nodemailer`, TLS required — STARTTLS on
  587 or implicit TLS on 465, ADR-0014). Tests use `FakeEmailSender`, which exposes delivered messages (so tests
  can extract verification links), and a local SMTP test server for the real sender.

## 5. Domain engine (`src/domain`)

Pure, exhaustively tested functions:

| File | Functions |
|------|-----------|
| `constants.ts` | Every tunable number in one place (ADR-0015): size XP 10/25/50, duration-factor table, level base 100 and factor 3, rank thresholds and multipliers, lateness window 30 d, −10 per lost gamble, back-dating limit 7 d |
| `dates.ts` | Calendar dates `YYYY-MM-DD` as day numbers (proleptic Gregorian, years 0000–9999): `toDayNumber`, `fromDayNumber`, `addDays`, `daysBetween`, `isoWeekday` — no instants, no `Date` |
| `check-in-dating.ts` | `checkInDating(localDate, today)` → `counts` (today), `history` (1–7 days back), `too_old`, `future` (R-CHK-04); "today" comes from `platform/time` (`localDateOf`) |
| `progress.ts` | `oneTimeProgress`, `targetProgress(start, target, current)` (thousandths), `habitProgress(metPeriods, K)`, `achievementProgress(quests)` (weighted by effective XP; exactly 1 only when every required quest is complete — a floating-point sum can never round an incomplete achievement up to 1) |
| `decimal.ts` | `parseDecimal`/`formatDecimal`: target and check-in values as exact integer thousandths, canonical strings (`"80.5"`), ≤ 3 fractional digits, \|value\| ≤ 10^9 (A-05) |
| `habit-reset.ts` | `evaluateHabit(config, countingCheckIns, today)` → met periods, reset on a closed period with < N counting check-ins, `needs_restart`; identical result for lazy (read/write) and daily-job evaluation (A-21) |
| `periods.ts` | `periodKeyFor(localDate, period, weekStart)`, `enumeratePeriods(start, until, period, weekStart)`; weeks start on `monday`, `sunday` or `saturday` (R-QST-09); a habit's first weekly period runs to the end of the first full week (Q-33) and a run keeps the week start it began with (Q-34) |
| `duration.ts` | `durationFactor(quest)` from the habit span in days, `effectiveXp(size, factor)` (R-XP-02) |
| `streak.ts` | `currentStreak(...)` of the current attempt, `bestStreak(...)` across attempts |
| `xp.ts` | `xpThreshold(level)` (`100 × 3^(L−2)`), `levelForXp`, `xpToNextLevel`, safe-integer assertions (R-XP-03/04) |
| `rank.ts` | `executionScore(...)`, `isFlawless(...)`, `rankForScore(score, flawless)`, `rankBonus(requiredXp, rank)` (R-RANK-01…03) |
| `gamble.ts` | `canPlace(...)` guards, `stakeFor(totalXp)`, `settle(gamble, event)` → won / lost / reverted with XP delta (R-GMB-*) |
| `transitions.ts` | Achievement status state machine (`active ↔ paused`, `completed` system-only), quest states (`locked`, `available`, `needs_restart`, `completed`) |
| `effects.ts` | Given previous and next states, derive XP ledger entries (quest, rank bonus, pause revocation, gamble), badge awards/removals, rank and score, gamble settlements and status changes — used by the check-in, undo, pause, edit and delete paths so they are exact inverses |

The service layer loads the (decrypted) state, calls `effects`, and persists the result in one transaction
with `SELECT … FOR UPDATE` on the quest, achievement and pending-gamble rows, which is what makes XP and gamble
settlement exactly-once under concurrency.

## 6. Folder structure

```
.
├── .github/workflows/ci.yml           # every gate on each push + nightly (test-strategy §7)
├── docker/
│   ├── Dockerfile                     # multi-stage; distroless Node 26 runtime (no shell), non-root, read-only FS
│   ├── compose.yml                    # local dev: postgres → db-init → migrate → api + worker
│   └── .env.example                   # placeholders only (copy to docker/.env)
├── docs/                              # see README documentation map
├── openapi/openapi.yaml               # contract (source of truth)
├── scripts/
│   └── build-password-filter.ts       # Bloom filter from pinned list (ADR-0012)
├── src/
│   ├── app.ts                         # buildApp(deps): Fastify instance with all plugins and modules
│   ├── server.ts                      # API entrypoint
│   ├── worker.ts                      # worker entrypoint (also migrate.ts, bootstrap-db.ts; logic in main/)
│   ├── domain/                        # pure functions (see §5), *.test.ts colocated
│   ├── platform/
│   │   ├── config/
│   │   ├── crypto/
│   │   ├── db/{bootstrap.ts, client.ts, migrate.ts, schema/, migrations/}   # roles, grants, RLS helpers
│   │   ├── email/                     # EmailSender, SmtpEmailSender (nodemailer), templates, outbox repository + delivery
│   │   ├── http/
│   │   ├── jobs/                      # poller (outbox, scheduler tick), scheduler with advisory locks and job_runs
│   │   ├── logging/
│   │   └── time/
│   └── modules/
│       ├── health/
│       ├── accounts/                  # register, verify, login, refresh, logout, password, email change, reauth, sessions
│       ├── consents/
│       ├── achievements/
│       ├── quests/
│       ├── check-ins/
│       ├── gambles/
│       ├── stats/
│       ├── audit/
│       └── privacy/                   # export, deactivation and deletion, retention jobs
├── test/
│   ├── helpers/                       # testcontainers harness, app factory, fake clock, fake email, log capture, contract validator
│   ├── integration/                   # API + real PostgreSQL
│   ├── contract/                      # OpenAPI conformance & spec coverage
│   ├── security/                      # authz/BOLA, auth flows, abuse cases, RLS, headers, log leakage
│   ├── supply-chain/                  # dependency allowlist, exact versions, no payment SDK
│   └── e2e/                           # few smoke flows against the built container
├── .semgrep/                          # custom Semgrep rules + annotated rule tests
├── .gitleaksignore · .semgrepignore · .nvmrc · .npmrc · lefthook.yml · commitlint.config.js · osv-scanner.toml
├── .dependency-cruiser.mjs · eslint.config.js · stryker.config.mjs · vitest.config.ts · vitest.unit.config.ts
├── drizzle.config.ts · tsconfig.json · package.json · package-lock.json
```

Unit tests live next to the code they test (`*.test.ts`); integration/contract/security/e2e tests live under
`test/` because they need the shared harness.

## 7. Runtime dependencies (allowlist)

This table is the allowlist: `test/supply-chain/dependency-allowlist.test.ts` fails if `package.json` has a runtime
dependency that is not listed here (T-10, R-SUP-01), if any dependency is not pinned to an exact registry version, or
if a payment SDK appears among the production packages (R-GMB-05). A new runtime dependency needs a row with its
reason here and a line in the next milestone report.

| Package | Version | Why | Alternatives considered |
|---------|---------|-----|------------------------|
| `fastify` | 5.12.7 (M1) | HTTP framework mandated by the stack; schema-driven, fast, plugin encapsulation | – |
| `zod` | 4.6.7 (M1) | Validation mandated by the stack; also used for config and response allowlisting | – |
| `drizzle-orm` | 0.45.4 (M1) | Type-safe, parameterized query layer (ADR-0003) | Kysely (equally good; Drizzle named in the brief) |
| `postgres` (postgres.js) | 3.4.9 (M1) | PostgreSQL driver with zero dependencies, supported by Drizzle | `pg` (more deps) |
| `sodium-native` | 5.2.0 (M2) | Argon2id, XChaCha20-Poly1305, constant-time compare, guarded memory (ADR-0005). Loads its bundled prebuilds through `require-addon` without install scripts; brings 19 further production packages (Holepunch `bare-*` loader, `streamx` family; MIT/Apache-2.0, none with install scripts). The image keeps only its own platform's prebuild (`docker/keep-native-prebuild.mjs`) | `argon2` + `libsodium-wrappers` (two deps); `libsodium-wrappers-sumo` (WASM: no guarded memory, slower Argon2id) |
| `pino` | 10.4.0 (M1) | Structured logging (already a Fastify dependency; used directly by the worker) | – |
| `nodemailer` | 10.2.1 (M2) | SMTP delivery to the PM's relay with mandatory TLS (ADR-0014); mature, no runtime dependencies of its own. Imported only by `platform/email/smtp-sender.ts` (dependency rule) | provider HTTP APIs/SDKs (not chosen: the PM decided on custom SMTP, Q-03) |

No 1Password SDK: the Connect API is called with Node's built-in `fetch` (ADR-0013).

Everything else (`vitest`, `testcontainers`, `drizzle-kit`, `typescript`, `eslint`, `@stryker-mutator/*`, `ajv`,
`ajv-formats`, `yaml`, `@redocly/cli`, `fast-check` (4.10.2 with `pure-rand`, added in M3 for the domain property
tests), `dependency-cruiser`, `@cyclonedx/cyclonedx-npm`,
`@commitlint/*`, `lefthook`, and `smtp-server` 3.21.1 as the local SMTP stand-in, with `punycode.js` and
`ipv6-normalize`, confirmed in M2) is a dev dependency and never ships in the container.

## 8. Deployment & operations view (details in M6 runbook)

- One immutable image per commit, signed digest pinned in deployment config; API and worker are the same image.
- Containers run as non-root with a read-only root filesystem and `tmpfs` for `/tmp`; no secrets baked in;
  secrets injected as environment variables (from 1Password or the host's secret store); the KEK itself is
  fetched from the self-hosted 1Password Connect server at startup (ADR-0013).
- PostgreSQL: private network only, TLS required (`verify-full`), encrypted volume, automated encrypted backups
  with 30-day expiry, point-in-time recovery if the provider offers it.
- Migrations run as a separate job before the new API version starts (expand/contract strategy for zero
  downtime).
- Health: `/health/live` (process up), `/health/ready` (DB reachable, KEK loaded at startup and wrap/unwrap
  self-test passed).
- Observability without personal data: request metrics (count, duration, status by route), job metrics, error
  counts. No third-party APM that receives bodies or identifiers.

## 9. What is deliberately not here

- No admin endpoints, no feature flags service, no caching layer, no GraphQL, no WebSockets, no file storage.
- No multi-tenancy beyond "one user = one tenant"; no sharing of achievements between users (would be a new
  data flow and privacy decision).
