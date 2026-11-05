# Architecture Decision Records

Short ADRs for every significant decision. Status values: `proposed` (made by the lead engineer in M0, becomes
`accepted` with the PM's milestone "go"), `accepted`, `superseded`, `rejected`. Decisions that the PM must take
are **not** recorded here until taken; they live in `docs/requirements.md` (§6 decisions taken, §7 open items).

Format: Context → Decision → Consequences → Tests that enforce it.

---

## ADR-0001 · Repository and workflow conventions

- **Status:** accepted; **amended by the PM on 2026-10-22: trunk-based — all work is pushed directly to `master`**
- **Context:** The PM requires TDD, small Conventional Commits, PROGRESS.md and DECISIONS.md reporting. The original
  proposal (one branch and one PR per milestone) was replaced by the PM after M0 ("why always merge? … straight push").
- **Decision:** Single repository (GitHub `LordLP90000/Achievement-Tracker`, default branch `master`, kept per Q-22).
  Every commit is pushed directly to `master`: no milestone branches, no PRs (`m0-plan` was merged once as `5d41b7d`).
  Conventional Commits (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `build`, `revert`,
  `security`; enforced by commitlint). Every commit
  that changes behaviour contains its tests. Milestone boundaries are the commit ranges in `docs/PROGRESS.md` and the
  milestone reports.
- **Consequences:** Faster flow, but CI can no longer block a commit *before* it lands on `master`. Mitigations: the
  local gates (`npm run check`: format, lint, typecheck, import boundaries, OpenAPI lint, and the unit, integration,
  contract and security tests with coverage — about 25 s, Docker required) run in a lefthook `pre-push` hook, the
  gitleaks secret scan of staged changes in `pre-commit` and commitlint in `commit-msg`; CI runs every gate on each
  push to `master` and nightly; a red pipeline is fixed or reverted before any other work; never `--no-verify`, never
  force-push to `master`.
- **Tests:** CI gate `commitlint` on the pushed range; lefthook hooks (`lefthook.yml`, installed with
  `npx lefthook install`; dependency install scripts stay disabled).

## ADR-0002 · Node.js 26 LTS as runtime target

- **Status:** accepted (2026-10-22, PM "go" for M1)
- **Context:** The stack mandates Node.js LTS. Node 26 enters Active LTS on 2026-10-28; Node 24 moves to
  Maintenance LTS on 2026-10-20. The dev machine currently runs Node 25 (never LTS).
- **Decision:** Target **Node 26 LTS** (pinned via `.nvmrc`/`engines`/Docker tag in M1, once the LTS release is
  out). Fallback to Node 24 only if a vetted native dependency (e.g. `sodium-native`) lacks Node 26 prebuilds;
  that fallback would be reported to the PM.
- **Consequences:** Longest support window (Maintenance until April 2029). `engines.node` is enforced with
  `engine-strict` so non-LTS versions fail fast.
- **Tests:** CI runs on the pinned LTS image; `npm ci` fails on wrong engine.

## ADR-0003 · Drizzle ORM, two database roles, Row-Level Security as defence in depth

- **Status:** accepted (2026-10-22, PM "go" for M1)
- **Context:** Only parameterized queries are allowed; the app role must have no DDL rights; every query must be
  scoped to the authenticated user ("another user's object returns 404").
- **Decision:**
  1. **Drizzle ORM** (`drizzle-orm` + `postgres` driver) for a type-safe query layer; raw `sql` template tags are
     allowed only in `src/platform/db` and are always parameterized (ESLint rule bans `sql.raw` elsewhere).
  2. Two PostgreSQL roles: `questline_migrator` (owner, runs `drizzle-kit` migrations in a separate job) and
     `questline_app` (DML on allowlisted tables only, `REVOKE CREATE ON SCHEMA public`, `NOBYPASSRLS`).
  3. **Row-Level Security** on every table that holds user data: policy `user_id = current_setting('app.user_id')::uuid`.
     The repository layer opens every transaction with `SET LOCAL app.user_id`. Application code still filters by
     `user_id` explicitly; RLS is the safety net that turns a forgotten filter into an empty result (→ 404),
     never into a leak.
  - **Amended in M2 (2026-10-29):** repositories live in their modules (architecture §2), so the query builder is
    allowed in `src/platform/db` **and in repository files** (`*repository.ts`); the drivers (`postgres`,
    `drizzle-kit`) stay in `src/platform/db` (dependency-cruiser), and so does every `sql` fragment (ESLint bans
    importing `sql` from `drizzle-orm` elsewhere — e.g. `increment()` for versions lives in
    `src/platform/db/expressions.ts`). Before a user is known (registration, verification, login, password reset)
    a transaction starts without `app.user_id`, reads only the RLS-exempt tables by blind index or token hash and
    binds itself to the user (`setUserContext`) before touching an RLS table.
- **Consequences:** Slightly more migration work; a second connection role in config. Cross-user maintenance
  jobs (retention, outbox) run in the worker under a third DML-only role `questline_worker`, for which the RLS
  policies grant access explicitly (`TO questline_worker USING (true)`); no role has `BYPASSRLS`.
- **Tests:** `security/rls.test.ts` (query without `app.user_id` returns zero rows; user A's id cannot read B's
  rows even with a deliberately unfiltered query), `security/db-roles.test.ts` (app role cannot `CREATE TABLE`),
  BOLA tests per endpoint (`security/ownership.test.ts`).

## ADR-0004 · Opaque random tokens; no JWTs

- **Status:** accepted (2026-10-22, PM "go" for M1)
- **Context:** The brief prefers opaque tokens; JWTs would need algorithm pinning, claim validation and still a
  revocation list for "revoke session" and "password change revokes all other sessions".
- **Decision:** All tokens (access, refresh, email verification, password reset) are 32 random bytes
  (`crypto.randomBytes`), base64url-encoded, prefixed for secret scanning (`ql_at_`, `ql_rt_`, `ql_vt_`, `ql_pt_`),
  and stored **only as SHA-256 hashes** (sufficient for 256-bit random secrets). Access tokens live ≤ 15 min and are
  looked up by hash on every request (instant revocation). Refresh tokens rotate on every use; presenting an
  already-rotated token revokes the entire session (reuse detection).
- **Consequences:** One indexed DB lookup per authenticated request (acceptable at our scale, and gives exact
  revocation semantics). No crypto-agility problems, no `alg=none`, no clock-skew issues.
- **Tests:** `security/tokens.test.ts` (entropy/length/prefix, hash-only storage, constant-time compare),
  `security/refresh-rotation.test.ts` (rotation, reuse → full session revocation), `security/sessions.test.ts`.

## ADR-0005 · libsodium (`sodium-native`) for password hashing, AEAD and constant-time comparison

- **Status:** accepted (2026-10-22, PM "go" for M1)
- **Context:** Vetted libraries only. Need Argon2id, XChaCha20-Poly1305 (preferred by the brief), constant-time
  comparison and secure memory. Fewer dependencies are better for supply-chain risk.
- **Decision:** `sodium-native` (prebuilt libsodium bindings) provides all of: `crypto_pwhash` (Argon2id13),
  `crypto_aead_xchacha20poly1305_ietf_*`, `sodium_memcmp`, `sodium_malloc`/`sodium_memzero`. Node's built-in
  `crypto` is used for HMAC-SHA256 (blind index), SHA-256 (token hashes), `randomBytes`, `randomUUID`,
  `timingSafeEqual`. No other crypto dependency. Argon2id parameters: **m = 64 MiB, t = 3, p = 1**
  (above OWASP's minimum of 19 MiB / t = 2 / p = 1), re-tuned in M2 so a hash takes 150–300 ms on the production
  instance size. Parameters are encoded in the PHC string so they can be raised later with transparent re-hash on
  login.
- **Consequences:** One native dependency with prebuilds. Verified in M2 (5.2.0): the bundled prebuilds load without
  install scripts on Windows x64, Linux x64 (CI) and in the distroless image, guarded memory included. Version 5
  loads them through Holepunch's `require-addon`, which brings 19 small transitive packages (reported in the M2
  report). If prebuilds are missing, fallback is `libsodium-wrappers-sumo` (WASM, same API family) — reported to the PM.
- **Tests:** `src/platform/crypto/aead.test.ts` (IETF XChaCha20-Poly1305 vector, round-trip, tamper detection, wrong
  AD fails, nonce uniqueness), `compare.test.ts`, `tokens.test.ts`, `blind-index.test.ts`; `password.test.ts`
  (parameters ≥ policy, verify/needs-rehash); e2e check that libsodium loads with guarded memory in the image.

## ADR-0006 · Envelope encryption design and the limits of crypto-shredding

- **Status:** accepted (2026-10-22, PM "go" for M1)
- **Context:** Goal content may be health data. Requirement: per-user data key (DEK) wrapped by a KEK (a KMS in
  the original brief; a KEK from 1Password Connect per ADR-0013), AEAD with AD = user ID + record ID + field name,
  key version for rotation, crypto-shredding on deletion.
- **Decision:**
  - One 32-byte DEK per user, generated at registration, wrapped by the KEK through a `KeyWrapper` interface
    (`LocalKeyWrapper` with a 32-byte KEK: from an env secret in dev/test, from the self-hosted 1Password Connect
    server in production — ADR-0013; a `KmsKeyWrapper` remains possible if the PM's hosting offers a KMS later).
    Wrapped DEKs live in `user_keys` with `kek_id`, `kek_version`, `dek_version`.
  - Field ciphertext format (bytea): `0x01 | nonce(24) | ciphertext+tag`. AD = `questline|v1|<user_id>|<record_id>|<field>`.
    Record IDs are therefore generated application-side (random UUID v4) before the insert.
  - Unwrapped DEKs are cached in process memory (`sodium_malloc` guarded buffers) for at most 5 minutes per user
    and wiped on eviction, to bound unwrap work and latency while limiting how long plaintext DEKs stay in memory.
    **Amended in M2 (2026-10-29):** no cache at all while the KEK is held locally (ADR-0013) — unwrapping costs
    microseconds, so a DEK is unwrapped into guarded memory for one unit of work and wiped right after
    (`src/platform/crypto/data-keys.ts`). The 5-minute bound applies only if a remote KMS is introduced later.
  - **Crypto-shredding scope (honest statement):** deleting a user hard-deletes all rows including the wrapped DEK.
    Backups taken before the deletion still contain the wrapped DEK and the ciphertext; they can be decrypted only
    by a party that has **both** the backup **and** the KEK (1Password vault access or a running app process,
    ADR-0013), and only until the backup expires (30 days). Against a *leaked* backup or DB dump (no KEK) the data
    is unreadable immediately — this is the primary threat this design addresses. To make our own restores safe, a
    `deleted_user_tombstones` table (random user UUID + timestamp, retained 35 days > backup retention) is replayed
    after any restore (approved by the PM, Q-13). Per-user KMS keys (immediate shredding) were evaluated and
    rejected for v1 on cost grounds (≈ USD 0.06–1.00 per user per month).
- **Consequences:** Encrypted fields cannot be searched/aggregated in SQL; all progress maths happens in the domain
  layer (which we want anyway for testability). Key rotation = re-wrap DEKs (cheap) or re-encrypt fields
  (background job, versioned).
- **Tests:** `unit/crypto/envelope.test.ts`, `integration/encryption-at-rest.test.ts` (raw DB rows contain no
  plaintext of seeded goal content; AD mismatch across users/records/fields fails), `integration/key-rotation.test.ts`,
  `integration/account-deletion.test.ts` (DEK destroyed, rows gone, tombstone written).

## ADR-0007 · Error format: RFC 9457 problem details with URN problem types

- **Status:** accepted (2026-10-22, PM "go" for M1)
- **Context:** Errors must be `application/problem+json` without internals. No production domain exists yet.
- **Decision:** `type` is a URN `urn:questline:problem:<slug>` (dereferenceability is not required by RFC 9457);
  switch to `https://<docs-domain>/problems/<slug>` once the PM provides a domain. Every problem carries
  `title`, `status`, optional `detail` (safe, static text), `instance` (request path) and `request_id`.
  Validation failures add `errors: [{pointer, message}]` (JSON Pointer, no raw values echoed).
- **Consequences:** Clients branch on `type`, never on free text. Unknown exceptions map to a generic
  `urn:questline:problem:internal` with no detail.
- **Tests:** `contract/problem-details.test.ts` (schema + no stack/SQL/paths in any error body; fuzzed inputs).

## ADR-0008 · Idempotency keys and optimistic concurrency

- **Status:** accepted (2026-10-22, PM "go" for M1)
- **Context:** Mobile retries; concurrent edits; brief requires idempotency keys on create endpoints and a
  version field with 409 on conflict.
- **Decision:**
  - Create endpoints require an `Idempotency-Key` header (UUID v4). The key is scoped to (user, route).
    First call stores status + response (encrypted with the user's DEK) + a hash of the request body for 24 h;
    a repeat with the same body replays the stored response (header `Idempotency-Replayed: true`); the same key
    with a different body → `422 urn:questline:problem:idempotency-key-reused`.
  - Mutable resources expose `version` (integer) in the body and as `ETag: "<version>"`. `PATCH` and `DELETE`
    require `If-Match`; a mismatch → `409 urn:questline:problem:version-conflict` with the current version in the
    problem body. (HTTP would also allow 412; the brief specifies 409 and we follow it.)
- **Tests:** `integration/idempotency.test.ts` (replay, body mismatch, cross-user key isolation, expiry),
  `integration/concurrency.test.ts` (stale version → 409, missing header → 428).
- **Amendment (2026-10-29, M3, Q-39):** only successful responses are stored and replayed; a request that failed
  changed nothing and runs again on retry. The request digest is SHA-256 over canonical JSON (properties sorted) of
  the path parameters and the body, so the same key under another parent is a different request. The record is
  written in the request's own transaction behind a transaction-scoped advisory lock on (user, route, key): it
  commits with the effect or not at all, and a concurrent duplicate waits for the first request, then replays its
  response (no `409` for requests in flight). `response_body_enc` holds the replayed headers (`ETag`, `Location`)
  with the body. A request with a key whose record expired replaces it; an hourly worker job deletes expired
  records. Code: `src/platform/idempotency/`, `src/platform/http/idempotency.ts`.

## ADR-0009 · PostgreSQL for rate limiting, outbox and scheduled jobs (no Redis/queue in v1)

- **Status:** accepted (2026-10-22, PM "go" for M1)
- **Context:** Rate limiting must work across instances; emails and retention jobs need background execution.
  Adding Redis or a queue is a new paid component (needs PM approval) and widens the attack surface.
- **Decision:** An `UNLOGGED` table `rate_limit_buckets` implements a token bucket keyed by HMAC(daily key,
  subject) so no raw IPs or emails are stored. An `email_outbox` table (payload encrypted with the user's DEK) is
  written in the same transaction as the business change and drained by the worker process with
  `SELECT … FOR UPDATE SKIP LOCKED`. Retention jobs run on a timer in the worker behind `pg_try_advisory_lock`.
  Everything sits behind interfaces (`RateLimitStore`, `Outbox`, `Scheduler`) so Redis/pg-boss can be swapped in
  later if load requires it.
- **Consequences:** One fewer component to secure and pay for; slightly more DB load (negligible at v1 scale);
  rate-limit precision is per-second, which is sufficient.
- **Tests:** `security/rate-limit.test.ts` (per-IP and per-account limits, progressive backoff, `Retry-After`,
  multi-instance consistency using two app instances on one DB), `integration/outbox-delivery.test.ts` (two workers
  draining at once, leases, retries, dead letters), `integration/scheduler.test.ts` (advisory lock, shared schedule,
  failures), `integration/retention.test.ts` (with injected clock).

## ADR-0010 · Spec-first OpenAPI 3.1 enforced by Ajv contract tests and a spec-coverage test

- **Status:** accepted (2026-10-22, PM "go" for M1)
- **Context:** The OpenAPI document is written first and must be enforced.
- **Decision:** `openapi/openapi.yaml` is the single source of truth. Request/response Zod schemas are written to
  match it. The integration test harness validates **every** response (status, headers, body) against the spec
  with Ajv (JSON Schema 2020-12) and fails on any mismatch or undocumented operation. A spec-coverage test fails
  if an `operationId` was never exercised by a test. Drift between Zod and the spec is detected by comparing
  `z.toJSONSchema()` output with the spec's request schemas.
- **Consequences:** Dev dependencies `ajv`, `ajv-formats`, `yaml`, `@redocly/cli` (lint). No runtime dependency
  on the spec.
- **Tests:** `contract/*.test.ts`, harness hook in `test/helpers/contract.ts`.
- **Amendment (2026-11-02, Q-45):** the core contract is frozen as `0.3.0`, because the mobile app starts against
  it: afterwards only additive changes, each approved by the PM. `openapi/frozen/openapi.yaml` is the contract as
  last frozen, byte for byte; `test/contract/freeze.test.ts` fails on a removed or moved operation, a change of
  authentication, a removed parameter, request body, response, header, media type, property or enum value, anything
  newly required of a request, a type a request no longer accepts or a response may newly return, and a response
  property no longer always present (rules in `test/helpers/contract-freeze.ts`, each tested in
  `contract-freeze.test.ts`). Formats, patterns, bounds and conditional rules are not compared. `exportData` and
  `deleteAccount` (with `ExportDocument` and `AccountDeletionScheduled`) stay outside until M4 implements them; the
  snapshot is then renewed from the contract of that day, once it passed the check — as `0.3.1` with the export and
  as `0.3.2` with the deletion, since when every operation is frozen. From then on the snapshot is renewed with every
  approved change, after the check against the snapshot before it, so that additions are frozen as well (`0.3.3`:
  Q-47; `0.3.4`: Q-48). `0.4.0` adds M5's 11 operations (ADR-0019), each outside the freeze until implemented; the
  generated suites classify an operation once it leaves `test/contract/not-yet-implemented.ts`. `0.4.1` adds the
  sign-in methods to the export (Q-52) and deletes an unconfirmed TOTP secret after 24 hours (Q-53).
  Chosen by the PM over oasdiff, which would have added a tool to CI.

## ADR-0011 · Timezone handling with `Intl` only; `local_date` stored per check-in

- **Status:** accepted (2026-10-22, PM "go" for M1)
- **Context:** Streaks must be correct across midnight and DST in the user's IANA timezone. Avoid a timezone
  library dependency if possible.
- **Decision:** All period logic works on **calendar dates** (`YYYY-MM-DD`), never on instants. The client sends
  `local_date` with each check-in (the device knows the user's day); the server validates it against "today" in the
  account timezone (computed with `Intl.DateTimeFormat(…, {timeZone})`) — no future dates, back-dating limited to
  7 days and back-dated check-ins never count (Q-08). Day periods are consecutive dates; week periods start on the
  user's `week_start` setting (`monday | sunday | saturday`, PM decision Q-18). Timezone strings are validated
  against `Intl.supportedValuesOf('timeZone')`.
- **Consequences:** Zero dependencies; DST only affects the mapping instant → local date, which `Intl` handles.
  Test vectors for Europe/Zurich on 2026-03-29 and 2026-10-25 are mandatory.
- **Tests:** `src/domain/dates.test.ts` (a whole 400-year cycle against the runtime calendar), `src/domain/periods.test.ts`,
  `src/platform/time/time-zones.test.ts` (DST vectors), property tests with `fast-check` for period arithmetic;
  streaks in `src/domain/streak.test.ts` (planned, M3).

## ADR-0012 · Offline breached-password check via a committed Bloom filter

- **Status:** accepted (2026-10-22, PM "go" for M1)
- **Context:** NIST SP 800-63B requires blocking commonly used / breached passwords; the brief requires an offline
  list (no network calls to HIBP).
- **Decision:** `scripts/build-password-filter.ts` (`npm run build:password-filter`) builds a Bloom filter (1 %
  false-positive rate) from a pinned, checksum-verified public list: SecLists `xato-net-10-million-passwords-1000000.txt`
  (MIT; the former "top 1,000,000" file, renamed upstream in 2025), commit `c205c36`, SHA-256 `424a3e03…0caf51`. Only
  entries that could pass the length rule (≥ 12 code points after NFKC, no control characters) are kept: 46 296 of
  999 999 entries, 7 hashes, 55 KB instead of the 1.2 MB a filter of the whole list would need. The file records the
  list's SHA-256 and is committed and loaded at startup; a false positive merely asks the user for a different
  password. Passwords are compared case-sensitively after NFKC normalisation; additionally any password containing
  the service name (`questline`, case-insensitive, NFKC) is rejected as a context-specific word. Length policy 12–128
  code points (minimum 12 confirmed by the PM, Q-06).
- **Consequences:** No external dependency at runtime; the list can be refreshed with the documented script. If
  the PM lowers the minimum length, the filter must be rebuilt with the new minimum.
- **Tests:** `src/modules/accounts/password-policy.test.ts` (breached entries and their full-width spellings rejected,
  context word rejected, long passphrases accepted, 12–128 code points, no composition rules, shipped filter built
  from the pinned list), `bloom-filter.test.ts` (membership, false-positive rate, file format, corrupt files refused).

## ADR-0013 · Production KEK sourced from a self-hosted 1Password Connect server

- **Status:** decided by PM (2026-10-22, Q-02)
- **Context:** The brief foresaw a KMS for the key-encryption key. The PM's hosting is not chosen yet and the PM
  requires 1Password connectivity. 1Password Connect is a self-hosted server that syncs selected vaults from
  1Password and exposes them over a local REST API with scoped access tokens.
- **Decision:** `KeyWrapper` gets a `LocalKeyWrapper` implementation in production too, but its 32-byte KEK is
  fetched **at startup** from the Connect server (`GET /v1/vaults/{vault}/items/{item}`) using a Connect token
  from the environment. The KEK is held only in `sodium_malloc` guarded memory, never logged or persisted; the
  process refuses to start if the item is missing, malformed (< 32 bytes) or the Connect server is unreachable.
  DEK wrapping is XChaCha20-Poly1305 with AD = user ID, done in-process. A `kek_version` field supports rotation:
  new KEK item version → re-wrap job for all `user_keys`.
- **Consequences / residual risk (accepted by PM):** unlike a KMS, the KEK is present in app memory, so a fully
  compromised app process can decrypt **all** users' data, not only those active during the compromise
  (threat model RR-1 widened; DPIA R-3 updated). The Connect server and its token become critical assets: the
  server must run in the private network, its token is rotated with the KEK, and its access is logged.
  No runtime dependency is needed (plain `fetch`); 1Password (AgileBits Inc., Canada) is recorded in
  `processors.md` as a security service provider that holds **no personal data**.
- **Tests:** `src/platform/config` tests (missing/short KEK, `KEK_SOURCE=env` in production → refuse to start),
  `src/platform/crypto/kek-source.test.ts` (Connect client against a local stub: happy path, 401/403/404/500, redirect,
  timeout, unreachable, malformed items and keys → startup failure; no token or key in any error),
  `key-wrapper.test.ts`, `integration/key-rotation.test.ts`.
- **Rotation (2026-11-05):** a new version of the KEK item cannot be re-wrapped from, because the Connect server
  returns only an item's current version; ADR-0020 (accepted, Q-56) rotates with a new item and checks only `kek_id` when
  unwrapping.

## ADR-0014 · Email delivery via generic SMTP (`nodemailer`)

- **Status:** decided by PM (2026-10-22, Q-03)
- **Context:** The PM wants a custom SMTP relay (Gmail/Google Workspace SMTP with DNS on Cloudflare was mentioned)
  rather than a provider API.
- **Decision:** `SmtpEmailSender` implements `EmailSender` using `nodemailer` (new runtime dependency: mature, no
  transitive dependencies, the de-facto Node SMTP client). TLS is mandatory (`requireTLS` for STARTTLS on 587 or
  implicit TLS on 465; plaintext refused), credentials come from 1Password/env, `From` uses a dedicated sending
  domain with SPF/DKIM/DMARC configured at the DNS provider. Per-account send limit 3/h and outbox dedupe protect
  the relay's daily quota. The relay operator is a processor for email addresses and must be named in
  `processors.md` (Google = US jurisdiction → DPIA R-9).
- **Consequences:** No provider SDK; delivery feedback limited to SMTP responses (no bounce webhooks in v1).
- **Implementation (M2, 2026-10-29):** `nodemailer` 10.2.1 behind `EmailSender` (`platform/email/smtp-sender.ts`, the
  only file allowed to import it — dependency rule). Always `requireTLS` (STARTTLS that must succeed; Nodemailer
  then sends STARTTLS even when it is not advertised, and fails rather than continuing in plaintext) or implicit TLS;
  certificate verified against the system CAs; TLS ≥ 1.2; the client announces the sender domain, so no internal
  host name appears in `EHLO` or `Message-ID`; file and URL access off; timeouts 10 s connect/greeting, 30 s socket.
  Failures are classified by step and reply code only, never reply text (it can contain the address):
  `smtp_eenvelope_550`, `smtp_etls_500`, `smtp_eauth_535`, `smtp_etimedout`. A recipient or message refused with a
  5yz reply is dead-lettered at once; every other failure is retried (architecture §4.7); failures of the relay
  itself (connection, TLS, authentication, sender address refused) also pause all delivery for 60 s.
- **Tests:** `test/integration/smtp-sender.test.ts` against a local `smtp-server` stand-in (Q-27) whose certificate
  is generated per run (`test/helpers/tls-certificate.ts`, no committed key): STARTTLS and implicit TLS, a relay
  without STARTTLS and an untrusted certificate refused before any credentials are sent (with a control test that
  the stand-in does accept a lenient client in plaintext), refusal classes; `src/platform/email/smtp-sender.test.ts`
  (classification), `src/platform/email/templates.test.ts` (no goal content), `test/integration/outbox-delivery.test.ts`
  (auth failure → retry, pause, dead letter).

## ADR-0015 · Gamification model: resets, ranks, duration factor, gambles

- **Status:** decided by PM (2026-10-22, Q-04/Q-05/Q-08/Q-17); engineering shape accepted with the M1 "go";
  integrity rules added by the PM on 2026-10-29 (Q-31)
- **Context:** The PM replaced the brief's "freeze on pause / Σ min(…) habit progress" with a stricter model and
  added ranks and gambles. Everything must stay non-gameable and exactly-once.
- **Decision (engineering shape):**
  - **Attempts**: an achievement carries `attempt`; pausing or a reset starts a new attempt. Check-ins carry
    `attempt` and `counts_for_progress`; progress/streak/score are computed over counting check-ins of the current
    attempt only. History is never deleted by resets (only by undo, quest/achievement deletion, consent withdrawal,
    account deletion).
  - **Habit reset**: detected when a closed period of the current attempt has fewer than N counting check-ins;
    evaluated lazily on every read/write of the quest and by a daily job (so gamble losses are settled even without
    app activity). State `needs_restart` blocks check-ins until the quest is edited with a new `start_date`.
  - **Effects engine** stays the single place that derives XP events, badges, rank and gamble outcomes from
    (previous state, next state), so undo/pause/delete are exact inverses of award paths.
  - **Numbers** (R-XP-02/03, R-RANK-01…03, R-GMB-*) are constants in `src/domain/constants.ts`, covered by
    table-driven tests, so the PM can tune them with a one-line change and a test update.
  - **Integers**: XP amounts and totals are `bigint`-safe (`int8` in PostgreSQL, `number` ≤ 2^53 asserted) because
    Champion multipliers reach ×365 on durations ×3.
  - **Integrity rules (2026-10-29, Q-31, closes O-06):** one pending gamble per user (partial unique index on
    `gambles.user_id`); a loss takes at most the XP above the current level's threshold and a win at most the
    achievement's required XP, which also keeps totals far below 2^53; lateness and Champion use the attempt's
    deadline (`achievements.deadline_enc`, the earliest `target_date` in effect during the attempt, A-35); the rank
    bonus and gamble wins need 7 × 24 h between creation and unlock (A-34). Each is a constant or a pure function in
    `src/domain`.
- **Consequences:** M3 grows by ≈ 5–7 engineering days; new table `gambles`, new columns on achievements/quests/
  check-ins; `achievement_pauses` is dropped (pause = reset, no freezing); OpenAPI gains gamble placement and rank
  fields. DPIA R-15 assesses gambling-like mechanics for users aged 13+.
- **Tests:** `unit/domain/{habit-reset,rank,gamble,duration}.test.ts` with property tests; `integration/attempts.test.ts`;
  `integration/gamble-settlement.test.ts` with injected clock across the Zurich DST dates.

## ADR-0016 · Supply-chain controls and CI gates

- **Status:** accepted (2026-10-29, PM "go" for M2; proposed in M1 on 2026-10-22)
- **Context:** Work is pushed straight to `master` (ADR-0001), so nothing reviews a dependency or a commit before it
  lands. R-SUP-01/02 and threats T-10 (malicious dependency), T-11 (tampered image) and E-07 (committed secrets)
  need controls that act before install, before commit, before push and on every CI run.
- **Decision:**
  - npm never runs dependency install scripts (`ignore-scripts=true`) and resolves only versions published at
    least 7 days ago (`min-release-age=7`); installs are lockfile-only (`npm ci`); every version is exact.
  - Runtime dependencies must be listed with a reason in the allowlist of `docs/architecture.md` §7; production
    packages must not include payment SDKs (R-GMB-05).
  - GitHub Actions are pinned to commit SHAs, scanner images to digests; the workflow token is read-only and never
    persisted; scanners get read-only mounts; Trivy scans an image tarball instead of the Docker socket.
  - CI jobs install from the registry without the Actions dependency cache: `npm ci` takes seconds and checks every
    package against the lockfile, while a stalled cache restore cost 10 minutes per job on 2026-10-23.
  - Exceptions only in reviewed files, with reason: `osv-scanner.toml` (with expiry), `.gitleaksignore` (exact
    finding fingerprints), `// nosemgrep: <rule> -- <reason>` on the line, and since 2026-11-05 (Q-54)
    `.trivyignore.yaml` (one vulnerability in named packages, with the PM's decision and an expiry). Every exception
    is listed in the next milestone report.
  - CI runs every gate on each push and nightly (fresh vulnerability data); each push gets its own run.
  - **Development tools stay offline (2026-11-05, M6):** the Redocly CLI reported every command to Redocly
    (`otel.cloud.redocly.com`) from the pre-push gate and CI. `redocly.yaml` turns its telemetry off (keeping the
    recommended rules, without which the lint would check nothing), and every npm script runs it under
    `scripts/offline-preload.ts`, which refuses and reports any outbound connection. Its update notice, a plain-HTTP
    version check against the npm registry, is off in CI and in the pre-push hook.
- **Consequences:** A fix published less than 7 days ago needs an explicit, reported `min-release-age-exclude`
  entry. A dependency that needs an install script (none so far; `sodium-native` is expected to load its bundled
  prebuilt binaries at runtime — verified when it is added in M2) needs explicit approval. CI can turn red without
  a code change (new advisory) — it is then fixed first.
- **Tests:** `test/supply-chain/dependency-allowlist.test.ts`, `test/supply-chain/tooling-offline.test.ts`,
  `test/supply-chain/scanner-exceptions.test.ts`, `test/scripts/offline.test.ts`; CI jobs `static`, `osv-scanner`,
  `gitleaks`, `semgrep` (with `semgrep --test` rule tests), `image` (Trivy, SBOM).

## ADR-0017 · Runtime image: distroless Node.js 26 on Debian 13

- **Status:** accepted (2026-10-29, PM "go" for M2; proposed in M1 on 2026-10-22)
- **Context:** The plan allowed "distroless or Alpine"; threat E-06 lists "no shell in distroless image" as a
  mitigation. The first M1 image (Alpine) still contained a busybox shell.
- **Decision:** Runtime stage `gcr.io/distroless/nodejs26-debian13:nonroot`, build stages `node:26-trixie-slim`
  (same glibc), both pinned by digest; uid 65532; application files owned by root; read-only root filesystem with a
  `tmpfs` `/tmp`, `no-new-privileges`, all capabilities dropped (Compose). Health checks use Node itself.
- **Consequences:** No shell for debugging inside containers (deliberate); base updates are digest bumps verified by
  the strict Trivy gate (0 HIGH/CRITICAL incl. unfixed at adoption). Native add-ons must ship glibc builds.
- **Tests:** `test/e2e/smoke.test.ts` (uid ≠ 0, read-only root, no shell, no package manager, no secrets in logs,
  production refusal); CI Trivy gate.

## ADR-0018 · Local mail catcher: Mailpit over TLS in the Compose stack

- **Status:** accepted (2026-11-02, the PM approved the image; Q-45)
- **Context:** The mobile app starts now (Q-45), but a sign-up could not be verified locally: without SMTP settings
  the worker leaves emails queued. SMTP must stay TLS-only (E-12, ADR-0014), no private key may be committed, and the
  app team should need nothing but Docker.
- **Decision:** the local Compose stack (`docker/compose.yml`, development only) runs **Mailpit 1.32.0**
  (`axllent/mailpit`, MIT, pinned by digest; Trivy found no HIGH, CRITICAL or MEDIUM vulnerability at adoption) as
  the worker's relay.
  - SMTP over implicit TLS only (`MP_SMTP_REQUIRE_TLS`: no plaintext, no STARTTLS that could be stripped) with SMTP
    authentication (`MAIL_CATCHER_PASSWORD`, a local random value); the worker uses `SMTP_TLS=implicit` and verifies
    the certificate as it would a real relay's.
  - The certificate (ECDSA P-256 for `mailpit` and `localhost`, one year) is made by `scripts/dev-mail-certificate.ts`
    in a one-off service that runs in the app image with the script mounted read-only and writes into a Compose
    volume, so the key never reaches the host or git. The worker trusts it in addition to the system CAs through
    `NODE_EXTRA_CA_CERTS` — no code change, still verified TLS. It is kept until it expires, because Mailpit and the
    worker read it only at start.
  - Mailpit runs as uid 65532 with a read-only root filesystem and no capabilities; its web UI and API are published
    on 127.0.0.1 only and answer only requests for that address (`MP_ALLOWED_HOSTS`, against DNS rebinding); it logs
    errors only, so no address appears in its log, and never contacts GitHub (`MP_DISABLE_VERSION_CHECK`).
  - Not a processor: it runs on the developer's machine and holds only synthetic test emails (R-SUP-05).
- **Consequences:** the app team signs up, verifies and uses the API locally with Docker alone. One more pinned
  third-party image, used only in development and never shipped, so CI's Trivy gate on the app image does not cover
  it: each version bump is scanned with the CI's Trivy image first and respects the 7-day rule, like npm packages.
  The integration tests still run the worker without SMTP settings (emails stay queued).
- **Tests:** `test/e2e/smoke.test.ts` (both emails of a sign-up delivered; a plaintext client gets no SMTP reply; the
  UI only on 127.0.0.1 and a foreign `Host` refused; the journey from sign-up through the emailed link to the stats;
  no address, password or token in any container log), `test/scripts/dev-mail-certificate.test.ts`,
  `test/helpers/tls-certificate.test.ts`.

## ADR-0019 · Passkeys, TOTP, recovery codes and step-up (M5)

- **Status:** accepted (2026-11-04: the PM approved the design as proposed, Q-52; the library, Q-50, and the
  relying-party ID as a production setting, Q-51, before it; later the same day, an unconfirmed TOTP secret is
  deleted after 24 hours, Q-53).
- **Context:** M5 adds passkeys and optional TOTP 2FA to email and password (R-AUTH-01, plan M5). The contract is
  frozen (Q-45): new operations and additive changes only, each approved. What stays: no enumeration (R-AUTH-07),
  the 10-minute re-authentication for sensitive operations (R-AUTH-06), rate limits and backoff (R-AUTH-08, S-01),
  secrets stored as hashes (R-AUTH-03) or encrypted with the user's data key (R-ENC-01), audit events (R-LOG-03),
  notices without links (A-33), no admin endpoints (requirements §2.8).
- **Decision:**
  - **Passkeys**, verified by `@simplewebauthn/server` (Q-50), imported only by `src/platform/webauthn/` (a
    dependency-cruiser rule, like `nodemailer`). Attestation `none`; discoverable credentials and user verification
    required; ES256, EdDSA and RS256. The relying-party ID and the allowed origins come from configuration (Q-51).
    Challenges: 32 random bytes, single use, 5 minutes, stored as SHA-256 hashes; a response finds its challenge by
    the challenge it signed.
    - Sign-in without an address: `POST /auth/passkey/options` (public) returns request options without a
      credential list, so nothing about any account is revealed (R-AUTH-07); `POST /auth/passkey/login`
      `{ credential, client, device_label? }` → token pair, a session with `auth_method: passkey`. The
      authenticator's user handle (the account ID, set at registration) names the account; the credential must be
      that account's, its signature must verify with user verification, and its signature counter must grow unless
      the authenticator always reports 0 — a counter that does not grow means a possibly cloned credential: refused
      and audited. Every failure is the same `401 invalid-credentials`. A passkey sign-in needs no TOTP code (it is
      already two factors: the device and its PIN or biometrics) and, like a password login, reactivates an account
      pending deletion within its 30 days (R-PRIV-06).
    - Managing them, signed in and re-authenticated within 10 minutes: `POST /me/passkeys/options` (creation
      options: user handle = account ID, name = the address, existing credentials excluded), `POST /me/passkeys`
      `{ credential, name? }` → `201 Passkey`, `GET /me/passkeys`, `DELETE /me/passkeys/{passkeyId}`. At most 10 per
      account (`422 limit-reached`). Stored: credential ID, public key, counter, backup state, transports, the name
      (optional, ≤ 50 characters, encrypted), created and last used.
  - **TOTP**, RFC 6238 on `node:crypto`'s HMAC-SHA1 in `src/platform/crypto/totp.ts`, tested against the RFC's
    vectors — no new dependency: 6 digits, 30-second steps, one step of clock drift either way, no code accepted
    twice (the last accepted step is stored). The 160-bit secret is encrypted with the user's data key.
    - Enrolment, re-authenticated: `POST /me/totp` → the secret, once, as base32 and an `otpauth://` URI (one not
      confirmed within 24 hours is deleted by the hourly purge, Q-53);
      `POST /me/totp/confirm` `{ code }` → TOTP on, and **10 recovery codes**, shown once; `POST /me/recovery-codes`
      → 10 new codes, the old ones void; `DELETE /me/totp` → off, codes deleted. Recovery codes have 80 bits each
      (`XXXX-XXXX-XXXX-XXXX`, Crockford base32), are stored as SHA-256 hashes and work once.
    - Login with TOTP on: after the correct password `POST /auth/login` answers **`202`**
      `{ second_factor_token, expires_in, methods }` instead of tokens — only someone who knows the password learns
      that TOTP is on, as with `email-not-verified` (I-05); `POST /auth/login/second-factor`
      `{ second_factor_token, totp_code | recovery_code, client, device_label? }` → token pair (`auth_method:
      password_totp` or `password_recovery_code`). The token (`ql_sf_…`, its hash stored) lives 5 minutes and takes
      at most 5 wrong codes; wrong codes also count against the account's backoff, as wrong passwords do (S-01).
  - **Step-up**: `POST /auth/reauth` also accepts `{ passkey: credential }` (with a challenge from
    `POST /auth/passkey/options`; the credential must be the session user's); with TOTP on, a password needs
    `totp_code` or `recovery_code` as well, else `401 urn:questline:problem:second-factor-required`.
  - **Visible**: `GET /me` shows `two_factor_enabled` and `recovery_codes_left`; `GET /me/sessions` each session's
    `auth_method`; the export gains `passkeys` and `two_factor` (no key, secret or hash); new audit events
    (`passkey_added`, `passkey_removed`, `passkey_clone_suspected`, `totp_enabled`, `totp_disabled`,
    `recovery_codes_generated`, `recovery_code_used`, `second_factor_failed`); one new notice without a link,
    `sign_in_methods_changed_notice`, after every change of passkeys, TOTP or recovery codes.
  - **Unchanged**: the password stays — a passkey is another way in, not a replacement; a password reset keeps TOTP
    and passkeys, so a taken-over mailbox alone does not remove the second factor.
- **Consequences:** contract `0.4.0` with 11 new operations, kept outside the freeze until implemented, and additive
  changes to `login`, `reauthenticate`, `Account`, `Session` and the export; migration 0009 (`passkeys`,
  `webauthn_challenges`, `totp_secrets`, `recovery_codes`, `second_factor_challenges`, `sessions.auth_method`);
  production settings `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS`; a software authenticator in `test/helpers` for real
  ceremonies. Public challenge creation writes a row: per-network rate limits, 5-minute expiry and the hourly purge
  bound it. **An account whose authenticator is lost with no recovery code left is locked out** — no admin endpoint
  can help; its erasure then needs a request to the controller, handled by hand (GDPR Art. 17). The app must tell the
  user to keep the codes.
- **Tests:** the RFC 6238 vectors and properties, recovery codes, registration and sign-in end to end with the
  software authenticator (a forged signature, a wrong origin or RP ID, a reused, expired or foreign challenge, a
  counter rollback, another account's credential), login with a second factor, step-up, enumeration, rate limits,
  and the generated contract and security suites for every new operation.

## ADR-0020 · Maintenance commands: tombstone replay after a restore, KEK re-wrap, blind-index re-index (M6)

- **Status:** accepted (2026-11-05: the PM approved it as proposed, Q-56; proposed at the M6 kickoff the same day)
- **Context:** M6 owes three operations that rewrite rows of every account at once: replaying tombstones after a
  restore (Q-13, ADR-0006; threats I-18, RR-4), re-wrapping every data key under a new KEK (ADR-0013, E-11) and
  re-indexing every address under a new blind-index key (RR-3). Neither running process can do them: the API's role
  sees one user at a time, the worker never holds the blind-index key, and while the API answers with the old key a
  re-index would let a second account register an address that is already taken. Preparing them found two problems
  in M2's KEK handling:
  - ADR-0013 rotates by "a new KEK item version → re-wrap job", but the Connect server returns only an item's
    current version: once the key in the item is changed, the old one is gone, and nothing can unwrap the data keys
    it wrapped.
  - `localKeyWrapper.unwrap` refuses a data key whose `kek_version` differs from the item's version, and every edit
    of the item raises that version — a note, a tag, a new title. One edit would make every data key unreadable:
    fail closed, but an outage of the whole service until a code change.
- **Decision:**
  - **One maintenance entrypoint** in the same image (`src/maintenance.ts`, run as
    `node dist/maintenance.js <command>`), started as a one-off job like the migration and with the migrator's
    database role (`DATABASE_URL_MIGRATOR`), so the API and the worker gain no privilege. Migration 0010 gives
    `questline_migrator` a policy on `user_keys`, the one table it needs whose RLS is forced against its owner. The
    owner could lift RLS anyway, so the policy crosses no boundary, but it keeps the access explicit and tested.
  - **Offline**: each command runs while the API and the worker are stopped. It refuses to start while a session of
    `questline-api` or `questline-worker` is connected (a best-effort guard; the runbook's "stop them first" is the
    control). Each command is idempotent and resumable: after any failure, run it again.
  - `replay-tombstones`: copies the tombstones of the database the restore replaces
    (`TOMBSTONE_SOURCE_DATABASE_URL`, read only) into the restored one, each with its date, so it still expires 35
    days after the deletion, and deletes every account a tombstone names, 100 per statement with the hard delete's
    cascade. Without a source it replays the restored database's own tombstones.
  - `rewrap-data-keys`: opens every data key with the current KEK or one of the previous KEKs given
    (`OP_PREVIOUS_KEK_ITEM_ID`, a second item in the same vault; `PREVIOUS_LOCAL_KEK` in development) — the AEAD
    tells which key fits, so labels never decide — and stores it wrapped by the current KEK, with its labels. A data
    key that no given KEK opens is counted and left as it is, and the command fails.
  - `reindex-email-blind-index`: decrypts every address, and every pending new address of an email change, with the
    user's data key. A blind index under the previous key (`PREVIOUS_BLIND_INDEX_KEY`) is replaced by one under the
    current key (`BLIND_INDEX_KEY`), and one under the current key is kept; one under neither is counted and left as
    it is, and the command fails.
  - **KEK labels**: `kek_id` names the 1Password item (`onepassword:<vault>/<item>`), and unwrapping checks it
    alone; `kek_version` records the item's version when the key was wrapped, for information. A rotation creates a
    **new item** and never changes the key of an existing one. The old item stays, archived, until the last backup
    taken before the rotation has expired (30 days), because restoring such a backup needs it.
- **Consequences:** a rotation or a restore takes a maintenance window: stop the API and the worker, run the
  command, start them with the new settings (timings in the runbooks, from the drills). The rate-limit key needs no
  command: a new key only resets the buckets, which live 24 hours. A restore to an earlier point also loses what
  happened after it besides completed deletions — deletion requests, consent withdrawals, revoked sessions: put to
  the PM with the restore drill.
- **Tests:** `test/integration/tombstone-replay.test.ts`, `test/e2e/smoke.test.ts` (the restore drill),
  `test/integration/key-rotation.test.ts` (named in ADR-0006 and ADR-0013 since M0),
  `src/platform/crypto/key-wrapper.test.ts`, `test/security/db-roles.test.ts`, `test/security/rls-coverage.test.ts`;
  the drills on the local Compose stack, recorded in the runbooks.
- **Amendment (2026-11-05, Q-57):** a restore to an earlier point loses more than deletions (O-13). So the command
  becomes `replay-after-restore` and its source `REPLACED_DATABASE_URL`. After the tombstones, for every account in
  both databases, it takes over what the replaced database holds wherever the two differ:
  - `deactivated_at`: deletion requests with their dates, and reactivations.
  - `password_hash` and `password_changed_at`, when the replaced database's change is newer.
  - `email_verified_at`, for an address verified after the restore point (built 2026-11-05): left unverified, the
    account would be deleted by the purge of unverified accounts after its 7 days.
  - The address (`email_enc`, `email_blind_index`, `email_verified_at`), in two passes: a temporary blind index first,
    so addresses that moved between accounts do not clash. A clash with an account the replaced database no longer
    holds deletes that account if it is unverified, as its purge did; any other clash holds the move back, and so
    does a clash with an account whose own move was held back. Held-back accounts stay as restored; the command
    finishes everything else and exits 1 (`MaintenanceIncompleteError`, `address_conflicts`) for a decision by
    hand. It never deletes an account the replaced database holds.
  - The passkeys, TOTP secret and recovery codes, replaced row for row. The rows keep their IDs, so the data key and
    the associated data still fit.
  - The consents. When the replaced database holds a withdrawal the restored one lacks, the goal content is deleted
    first, as a withdrawal does.

  An account row it changes gets a version above both databases', so no ETag a client kept from either matches.
  Then it deletes every session with its tokens: every user signs in again. It works in batches of 100 accounts per
  transaction, is idempotent and logs counts per kind. Migration 0010 gives the migrator permissive policies on the
  tables with forced RLS that it touches: `user_keys`, `sessions`, `consents`, `passkeys`, `totp_secrets`,
  `recovery_codes`, `achievements`, `xp_events` and `idempotency_keys`. The other goal-content tables follow by
  cascade.
