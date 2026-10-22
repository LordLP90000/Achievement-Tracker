# Architecture Decision Records

Short ADRs for every significant decision. Status values: `proposed` (made by the lead engineer in M0, becomes
`accepted` with the PM's milestone "go"), `accepted`, `superseded`, `rejected`. Decisions that the PM must take
are **not** recorded here until taken; they live in `docs/requirements.md` → "Open questions".

Format: Context → Decision → Consequences → Tests that enforce it.

---

## ADR-0001 · Repository and workflow conventions

- **Status:** proposed (2026-10-22)
- **Context:** The PM requires TDD, small Conventional Commits, one branch per milestone, PROGRESS.md and
  DECISIONS.md reporting, and PRs when a remote exists.
- **Decision:** Single repository (GitHub `LordLP90000/Achievement-Tracker`, default branch `master` as created by
  the PM's IDE — not renamed without PM approval). `master` is protected; each milestone works on a branch
  `m<n>-<name>` and is merged by PR after the PM's "go". Conventional Commits (`feat`, `fix`, `refactor`, `docs`,
  `test`, `chore`, `perf`, `ci`, `security`). Every commit that changes behaviour contains its tests.
- **Consequences:** Linear, reviewable history per milestone; the milestone report doubles as PR description.
- **Tests:** CI gate `commitlint` (M1).

## ADR-0002 · Node.js 26 LTS as runtime target

- **Status:** proposed (2026-10-22)
- **Context:** The stack mandates Node.js LTS. Node 26 enters Active LTS on 2026-10-28; Node 24 moves to
  Maintenance LTS on 2026-10-20. The dev machine currently runs Node 25 (never LTS).
- **Decision:** Target **Node 26 LTS** (pinned via `.nvmrc`/`engines`/Docker tag in M1, once the LTS release is
  out). Fallback to Node 24 only if a vetted native dependency (e.g. `sodium-native`) lacks Node 26 prebuilds;
  that fallback would be reported to the PM.
- **Consequences:** Longest support window (Maintenance until April 2029). `engines.node` is enforced with
  `engine-strict` so non-LTS versions fail fast.
- **Tests:** CI runs on the pinned LTS image; `npm ci` fails on wrong engine.

## ADR-0003 · Drizzle ORM, two database roles, Row-Level Security as defence in depth

- **Status:** proposed (2026-10-22)
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
- **Consequences:** Slightly more migration work; a second connection role in config. Cross-user maintenance
  jobs (retention, outbox) run in the worker under a third DML-only role `questline_worker`, for which the RLS
  policies grant access explicitly (`TO questline_worker USING (true)`); no role has `BYPASSRLS`.
- **Tests:** `security/rls.test.ts` (query without `app.user_id` returns zero rows; user A's id cannot read B's
  rows even with a deliberately unfiltered query), `security/db-roles.test.ts` (app role cannot `CREATE TABLE`),
  BOLA tests per endpoint (`security/ownership.test.ts`).

## ADR-0004 · Opaque random tokens; no JWTs

- **Status:** proposed (2026-10-22)
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

- **Status:** proposed (2026-10-22)
- **Context:** Vetted libraries only. Need Argon2id, XChaCha20-Poly1305 (preferred by the brief), constant-time
  comparison and secure memory. Fewer dependencies are better for supply-chain risk.
- **Decision:** `sodium-native` (prebuilt libsodium bindings) provides all of: `crypto_pwhash` (Argon2id13),
  `crypto_aead_xchacha20poly1305_ietf_*`, `sodium_memcmp`, `sodium_malloc`/`sodium_memzero`. Node's built-in
  `crypto` is used for HMAC-SHA256 (blind index), SHA-256 (token hashes), `randomBytes`, `randomUUID`,
  `timingSafeEqual`. No other crypto dependency. Argon2id parameters: **m = 64 MiB, t = 3, p = 1**
  (above OWASP's minimum of 19 MiB / t = 2 / p = 1), re-tuned in M2 so a hash takes 150–300 ms on the production
  instance size. Parameters are encoded in the PHC string so they can be raised later with transparent re-hash on
  login.
- **Consequences:** One native dependency with prebuilds (verified against Node 26 in M1). If prebuilds are
  missing, fallback is `libsodium-wrappers-sumo` (WASM, same API family) — reported to the PM.
- **Tests:** `unit/crypto/password.test.ts` (parameters ≥ policy, verify/needs-rehash), `unit/crypto/aead.test.ts`
  (round-trip, tamper detection, wrong AD fails, nonce uniqueness), known-answer tests from libsodium vectors.

## ADR-0006 · Envelope encryption design and the limits of crypto-shredding

- **Status:** proposed (2026-10-22)
- **Context:** Goal content may be health data. Requirement: per-user data key (DEK) wrapped by a KEK (KMS in
  production), AEAD with AD = user ID + record ID + field name, key version for rotation, crypto-shredding on
  deletion.
- **Decision:**
  - One 32-byte DEK per user, generated at registration, wrapped by the KEK through a `KeyWrapper` interface
    (`LocalKeyWrapper` for dev/test using a 32-byte env secret; `KmsKeyWrapper` for production — provider chosen by
    the PM, see hosting options). Wrapped DEKs live in `user_keys` with `kek_id`, `kek_version`, `dek_version`.
  - Field ciphertext format (bytea): `0x01 | nonce(24) | ciphertext+tag`. AD = `questline|v1|<user_id>|<record_id>|<field>`.
    Record IDs are therefore generated application-side (random UUID v4) before the insert.
  - Unwrapped DEKs are cached in process memory (`sodium_malloc` guarded buffers) for at most 5 minutes per user
    and wiped on eviction, to bound KMS calls and latency.
  - **Crypto-shredding scope (honest statement):** deleting a user hard-deletes all rows including the wrapped DEK.
    Backups taken before the deletion still contain the wrapped DEK and the ciphertext; they can be decrypted only
    by a party that has **both** the backup **and** KMS `Decrypt` permission, and only until the backup expires
    (30 days). Against a *leaked* backup or DB dump (no KMS access) the data is unreadable immediately — this is
    the primary threat this design addresses. To make our own restores safe, a `deleted_user_tombstones` table
    (random user UUID + timestamp, retained 35 days > backup retention) is replayed after any restore
    (pending PM approval — see open question Q-13). Per-user KMS keys (immediate shredding) were evaluated and
    rejected for v1 on cost grounds (≈ USD 0.06–1.00 per user per month).
- **Consequences:** Encrypted fields cannot be searched/aggregated in SQL; all progress maths happens in the domain
  layer (which we want anyway for testability). Key rotation = re-wrap DEKs (cheap) or re-encrypt fields
  (background job, versioned).
- **Tests:** `unit/crypto/envelope.test.ts`, `integration/encryption-at-rest.test.ts` (raw DB rows contain no
  plaintext of seeded goal content; AD mismatch across users/records/fields fails), `integration/key-rotation.test.ts`,
  `integration/account-deletion.test.ts` (DEK destroyed, rows gone, tombstone written).

## ADR-0007 · Error format: RFC 9457 problem details with URN problem types

- **Status:** proposed (2026-10-22)
- **Context:** Errors must be `application/problem+json` without internals. No production domain exists yet.
- **Decision:** `type` is a URN `urn:questline:problem:<slug>` (dereferenceability is not required by RFC 9457);
  switch to `https://<docs-domain>/problems/<slug>` once the PM provides a domain. Every problem carries
  `title`, `status`, optional `detail` (safe, static text), `instance` (request path) and `request_id`.
  Validation failures add `errors: [{pointer, message}]` (JSON Pointer, no raw values echoed).
- **Consequences:** Clients branch on `type`, never on free text. Unknown exceptions map to a generic
  `urn:questline:problem:internal` with no detail.
- **Tests:** `contract/problem-details.test.ts` (schema + no stack/SQL/paths in any error body; fuzzed inputs).

## ADR-0008 · Idempotency keys and optimistic concurrency

- **Status:** proposed (2026-10-22)
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

## ADR-0009 · PostgreSQL for rate limiting, outbox and scheduled jobs (no Redis/queue in v1)

- **Status:** proposed (2026-10-22)
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
  multi-instance consistency using two app instances on one DB), `integration/outbox.test.ts`,
  `integration/retention.test.ts` (with injected clock).

## ADR-0010 · Spec-first OpenAPI 3.1 enforced by Ajv contract tests and a spec-coverage test

- **Status:** proposed (2026-10-22)
- **Context:** The OpenAPI document is written first and must be enforced.
- **Decision:** `openapi/openapi.yaml` is the single source of truth. Request/response Zod schemas are written to
  match it. The integration test harness validates **every** response (status, headers, body) against the spec
  with Ajv (JSON Schema 2020-12) and fails on any mismatch or undocumented operation. A spec-coverage test fails
  if an `operationId` was never exercised by a test. Drift between Zod and the spec is detected by comparing
  `z.toJSONSchema()` output with the spec's request schemas.
- **Consequences:** Dev dependencies `ajv`, `ajv-formats`, `yaml`, `@redocly/cli` (lint). No runtime dependency
  on the spec.
- **Tests:** `contract/*.test.ts`, harness hook in `test/helpers/contract.ts`.

## ADR-0011 · Timezone handling with `Intl` only; `local_date` stored per check-in

- **Status:** proposed (2026-10-22)
- **Context:** Streaks must be correct across midnight and DST in the user's IANA timezone. Avoid a timezone
  library dependency if possible.
- **Decision:** All period logic works on **calendar dates** (`YYYY-MM-DD`), never on instants. The client sends
  `local_date` with each check-in (the device knows the user's day); the server validates it against "today" in the
  account timezone (computed with `Intl.DateTimeFormat(…, {timeZone})`) — no future dates, back-dating limited to
  7 days (Q-08). Day periods are consecutive dates; week periods are ISO weeks (Monday start). Timezone strings are
  validated against `Intl.supportedValuesOf('timeZone')`.
- **Consequences:** Zero dependencies; DST only affects the mapping instant → local date, which `Intl` handles.
  Test vectors for Europe/Zurich on 2026-03-29 and 2026-10-25 are mandatory.
- **Tests:** `unit/domain/streak.test.ts`, `unit/time/tz.test.ts` (DST vectors), property tests with
  `fast-check` for period arithmetic.

## ADR-0012 · Offline breached-password check via a committed Bloom filter

- **Status:** proposed (2026-10-22)
- **Context:** NIST SP 800-63B requires blocking commonly used / breached passwords; the brief requires an offline
  list (no network calls to HIBP).
- **Decision:** `scripts/build-password-filter.ts` builds a Bloom filter (1 % false-positive rate, ≈ 1.2 MB) from a
  pinned, checksum-verified public list (SecLists "top 1,000,000", MIT licence) plus context words (app name).
  The filter binary is committed and loaded at startup; a false positive merely asks the user for a different
  password. Passwords are compared case-sensitively after NFKC normalisation; length policy 12–128 chars
  (Q-06: minimum length to confirm).
- **Consequences:** No external dependency at runtime; the list can be refreshed with a documented script.
- **Tests:** `unit/accounts/password-policy.test.ts` (top-100 passwords rejected, long passphrases accepted,
  ≥ 64 chars allowed, no composition rules, no truncation).
