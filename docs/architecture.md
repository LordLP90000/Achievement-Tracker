# Architecture

Status: M0 proposal (2026-10-22). Implements the requirements in `docs/requirements.md`; decisions are recorded in
`docs/DECISIONS.md` (ADR-0001 … ADR-0012).

## 1. Shape: a modular monolith with a separate worker process

```
 Mobile app (iOS / Android)
   │  HTTPS (TLS 1.2+/1.3, HSTS), JSON, Bearer access token
   ▼
 Edge: provider load balancer (TLS termination, per-IP limits)   ── private network ──┐
   │                                                                                   │
   ▼                                                                                   ▼
 ┌──────────────────────────────┐        ┌──────────────────────────────┐   ┌────────────────┐
 │ questline-api (Fastify)      │        │ questline-worker             │   │ KMS (KEK)      │
 │  /health, /v1/*              │        │  outbox → email provider     │   │ wrap/unwrap DEK│
 │  role: questline_app (RLS)   │        │  retention & cleanup jobs    │   └────────────────┘
 └──────────────┬───────────────┘        │  role: questline_worker      │
                │ parameterized SQL      └──────────────┬───────────────┘
                ▼                                       ▼
 ┌─────────────────────────────────────────────────────────────────────┐   ┌────────────────┐
 │ PostgreSQL 17 (private, encrypted disk, encrypted backups ≤ 30 d)   │   │ Email provider │
 │ migrations by role questline_migrator (separate job)                │   │ (approved      │
 └─────────────────────────────────────────────────────────────────────┘   │  processor)    │
                                                                           └────────────────┘
```

- One codebase, two entrypoints (`src/server.ts`, `src/worker.ts`), one container image, started with a
  different command. Both are stateless; all state is in PostgreSQL.
- No Redis, no message queue, no object storage in v1 (ADR-0009). Everything that needs shared state goes
  through PostgreSQL behind small interfaces so it can be swapped later.
- The server never calls user-supplied URLs; its only outbound connections are PostgreSQL, the KMS and the
  email provider (allowlisted at the network level in M6).

## 2. Layers inside a module

Each feature module (`src/modules/<feature>/`) is organised the same way; dependencies point inwards.

```
 routes.ts    HTTP: Fastify routes, Zod request/response schemas (strict, allowlisted), problem mapping
    │
 service.ts   Use cases: transactions, authorization context, calls domain functions, writes audit/outbox/XP
    │
 repository.ts  Persistence: Drizzle queries, ALWAYS scoped by user_id (type-enforced), field encryption
    │
 src/domain/*  Pure functions: progress, XP, levels, streaks, state machines. No I/O, no Date.now(), no randomness.
```

Rules enforced by lint/tests:

- `src/domain/**` imports nothing from `src/platform` or `src/modules` (dependency-cruiser rule) and has no side
  effects — this is the part covered by Stryker mutation testing.
- Repositories are created per request via `repos.forUser(userId)`; there is no API to build a repository without
  a user ID. Cross-user access exists only in `src/modules/privacy/retention/*` (worker role).
- Every transaction begins with `SET LOCAL app.user_id = $1` (RLS, ADR-0003). Worker transactions set
  `app.user_id` to the user being processed, or run as `questline_worker` for cross-user retention.
- Output goes through a Zod response schema (`.strict().parse`) before serialisation, so a new column can never
  leak into a response by accident.

## 3. Request lifecycle (API)

| Step | Component | Behaviour |
|------|-----------|-----------|
| 1 | `request-context` plugin | Generates a random UUID request ID (client-supplied IDs are ignored), attaches a child logger with only `request_id`, `method`, `route` (pattern, not raw URL). |
| 2 | Body parsing | JSON only (`415` otherwise), `bodyLimit` 64 KiB, `onProtoPoisoning: 'error'`, `onConstructorPoisoning: 'error'`. |
| 3 | `security-headers` plugin | HSTS, `X-Content-Type-Options`, CSP `default-src 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Resource-Policy: same-origin`, `X-Frame-Options: DENY`; `Cache-Control: no-store, Pragma: no-cache` when the route is authenticated. Never sets CORS headers. |
| 4 | `rate-limit` plugin | Token buckets in PostgreSQL keyed by HMAC(daily key, subject). Auth routes: per IP + per email blind index with progressive backoff; other routes: per user. `429` + `Retry-After`. |
| 5 | `auth-guard` | `Authorization: Bearer ql_at_…` → SHA-256 → `session_tokens.access_token_hash` lookup (joined with `sessions`); checks expiry/revocation; attaches `request.principal = { userId, sessionId, lastReauthAt }`. Missing/invalid → `401` with `WWW-Authenticate: Bearer`. |
| 6 | `reauth-guard` (selected routes) | `lastReauthAt ≥ now − 10 min`, else `403 urn:questline:problem:reauthentication-required`. |
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
- `APP_ENV=production` additionally refuses `KEK_PROVIDER=local`, `LOG_LEVEL=debug|trace`, missing
  `TRUST_PROXY_HOPS`, and any `DATABASE_URL` without `sslmode=verify-full`.
- Variables (final list in M1): `APP_ENV`, `PORT`, `LOG_LEVEL`, `TRUST_PROXY_HOPS`, `PUBLIC_LINK_BASE_URL`,
  `DATABASE_URL_APP`, `DATABASE_URL_WORKER`, `DATABASE_URL_MIGRATOR` (migration job only), `KEK_PROVIDER`,
  `LOCAL_KEK` (dev/test), `KMS_*` (provider-specific), `BLIND_INDEX_KEY`, `RATE_LIMIT_KEY`, `EMAIL_PROVIDER`,
  `EMAIL_*` credentials, `EMAIL_FROM`.

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
| `KeyWrapper` (interface) | `wrap(dek, userId) → {blob, kekId, kekVersion}`, `unwrap(blob, userId, kekId)`. Implementations: `LocalKeyWrapper` (XChaCha20-Poly1305 with the env KEK; dev/test only), `KmsKeyWrapper` (provider SDK/API after Q-02). |
| `KeyService` | Creates a DEK at registration, stores the wrapped DEK in `user_keys`, unwraps on demand, caches plaintext DEKs ≤ 5 min in `sodium_malloc` guarded memory, wipes on eviction/shutdown, destroys on account deletion. |
| `FieldCipher` | `encrypt(dek, {userId, recordId, field}, plaintext)` → `0x01‖nonce‖ct`; `decrypt` verifies AD. Typed helpers for strings and decimals. |
| `PasswordHasher` | Argon2id (ADR-0005) with `needsRehash` for parameter upgrades. |
| `BlindIndex` | HMAC-SHA256(`BLIND_INDEX_KEY`, NFKC-normalised, lower-cased, trimmed email). |
| `Tokens` | Random tokens with type prefixes, SHA-256 digests, constant-time comparison. |

### 4.4 HTTP utilities (`platform/http`)

Problem details factory (ADR-0007), security headers, auth guard, re-auth guard, pagination (opaque base64url
cursor `{created_at, id}` validated by Zod), idempotency, optimistic concurrency (`If-Match` ↔ `version`),
content-type enforcement.

### 4.5 Logging (`platform/logging`)

- Pino JSON logs. The default Fastify request/response serializers are replaced by an **allowlist** serializer:
  `request_id`, `method`, `route`, `status`, `duration_ms`, `user_present` (boolean), `client` (enum).
- No headers, no URL query strings, no bodies, no emails, no IDs other than `request_id` are logged. Pino
  `redact` is configured as a second line of defence for common key names (`password`, `token`, `email`, …).
- Audit events are **not** logs: they are rows in `audit_events` with minimal, allowlisted metadata.
- Test harness captures every log line of the whole run (API + worker) and asserts that no seeded secret or
  personal value appears (R-LOG-02).

### 4.6 Time (`platform/time`)

- `Clock` interface (`now(): Date`) injected everywhere; tests use a controllable clock.
- `tz.ts`: `localDate(instant, timeZone)`, `isValidTimeZone`, ISO-week helpers, all based on `Intl`
  (ADR-0011) and pure date arithmetic.

### 4.7 Background work (`platform/jobs`)

- `Outbox`: rows inserted inside business transactions; the worker drains with `FOR UPDATE SKIP LOCKED`,
  exponential retry (max 8 attempts), then dead-letter (encrypted payload, 7-day retention).
- `Scheduler`: fixed-interval jobs guarded by `pg_try_advisory_lock` so only one worker instance runs a job.
  Jobs: unverified-account purge (7 d), expired one-time tokens, expired/revoked sessions & tokens,
  idempotency keys (24 h), audit events (90 d), tombstones (35 d), stale rate-limit buckets, dead letters (7 d).
- Email sending is the only outbound call; the `EmailSender` interface has a `FakeEmailSender` for tests that
  exposes delivered messages (so tests can extract verification links).

## 5. Domain engine (`src/domain`)

Pure, exhaustively tested functions:

| File | Functions |
|------|-----------|
| `progress.ts` | `oneTimeProgress`, `targetProgress(start, target, current)`, `habitProgress(periods, N, K)`, `achievementProgress(quests)` |
| `periods.ts` | `periodKeyFor(localDate, period)`, `enumeratePeriods(start, until, period)`, ISO-week arithmetic |
| `streak.ts` | `currentStreak(checkInDates, config, today, pauses)`, `bestStreak(...)` with pause intervals frozen |
| `xp.ts` | `xpForSize`, `unlockBonus(requiredXp)`, `levelForXp`, `xpToNextLevel` |
| `transitions.ts` | Achievement status state machine, quest lock state (`locked | available | completed`) |
| `effects.ts` | Given previous and next quest/achievement states, derive XP ledger entries, badge awards/removals, status changes — used by both create-check-in and undo paths so they are exact inverses |

The service layer loads the (decrypted) state, calls `effects`, and persists the result in one transaction
with `SELECT … FOR UPDATE` on the quest and achievement rows, which is what makes XP exactly-once under
concurrency.

## 6. Folder structure

```
.
├── .github/workflows/ci.yml           # lint, typecheck, tests+coverage, semgrep, osv-scanner, gitleaks, trivy, sbom
├── docker/
│   ├── Dockerfile                     # multi-stage, distroless/alpine, non-root, read-only FS
│   └── compose.yml                    # local dev: postgres + api + worker
├── docs/                              # see README documentation map
├── openapi/openapi.yaml               # contract (source of truth)
├── scripts/
│   ├── build-password-filter.ts       # Bloom filter from pinned list (ADR-0012)
│   └── db-roles.sql                   # roles & grants applied by the migration job
├── src/
│   ├── app.ts                         # buildApp(deps): Fastify instance with all plugins and modules
│   ├── server.ts                      # API entrypoint
│   ├── worker.ts                      # worker entrypoint
│   ├── domain/                        # pure functions (see §5), *.test.ts colocated
│   ├── platform/
│   │   ├── config/
│   │   ├── crypto/
│   │   ├── db/{client.ts, schema/, migrations/, rls.sql}
│   │   ├── http/
│   │   ├── jobs/
│   │   ├── logging/
│   │   └── time/
│   └── modules/
│       ├── health/
│       ├── accounts/                  # register, verify, login, refresh, logout, password, email change, reauth, sessions
│       ├── consents/
│       ├── achievements/
│       ├── quests/
│       ├── check-ins/
│       ├── stats/
│       ├── audit/
│       └── privacy/                   # export, deletion, retention jobs
├── test/
│   ├── helpers/                       # testcontainers harness, app factory, fake clock, fake email, log capture, contract validator
│   ├── integration/                   # API + real PostgreSQL
│   ├── contract/                      # OpenAPI conformance & spec coverage
│   ├── security/                      # authz/BOLA, auth flows, abuse cases, RLS, headers, log leakage
│   └── e2e/                           # few smoke flows against the built container
├── .env.example
├── .gitleaks.toml · .semgrep.yml · .nvmrc · eslint.config.js · stryker.config.mjs · vitest.config.ts
├── drizzle.config.ts · tsconfig.json · package.json · package-lock.json
```

Unit tests live next to the code they test (`*.test.ts`); integration/contract/security/e2e tests live under
`test/` because they need the shared harness.

## 7. Planned runtime dependencies (to be confirmed in M1 with versions)

| Package | Why | Alternatives considered |
|---------|-----|------------------------|
| `fastify` | HTTP framework mandated by the stack; schema-driven, fast, plugin encapsulation | – |
| `zod` | Validation mandated by the stack; also used for config and response allowlisting | – |
| `drizzle-orm` | Type-safe, parameterized query layer (ADR-0003) | Kysely (equally good; Drizzle named in the brief) |
| `postgres` (postgres.js) | PostgreSQL driver with zero dependencies, supported by Drizzle | `pg` (more deps) |
| `sodium-native` | Argon2id, XChaCha20-Poly1305, constant-time compare, guarded memory (ADR-0005) | `argon2` + `libsodium-wrappers` (two deps) |
| `pino` | Structured logging (already a Fastify dependency; used directly by the worker) | – |
| KMS client (after Q-02) | Wrap/unwrap DEKs in production | plain `fetch` for OpenBao/Scaleway HTTP APIs (no SDK) |

Everything else (`vitest`, `testcontainers`, `drizzle-kit`, `typescript`, `eslint`, `@stryker-mutator/*`, `ajv`,
`ajv-formats`, `yaml`, `@redocly/cli`, `fast-check`, `dependency-cruiser`, `@cyclonedx/cyclonedx-npm`,
`@commitlint/*`, `lefthook`) is a dev dependency and never ships in the container.

## 8. Deployment & operations view (details in M6 runbook)

- One immutable image per commit, signed digest pinned in deployment config; API and worker are the same image.
- Containers run as non-root with a read-only root filesystem and `tmpfs` for `/tmp`; no secrets baked in;
  secrets injected as environment variables from the provider's secret store.
- PostgreSQL: private network only, TLS required (`verify-full`), encrypted volume, automated encrypted backups
  with 30-day expiry, point-in-time recovery if the provider offers it.
- Migrations run as a separate job before the new API version starts (expand/contract strategy for zero
  downtime).
- Health: `/health/live` (process up), `/health/ready` (DB reachable, KEK unwrap self-test passed).
- Observability without personal data: request metrics (count, duration, status by route), job metrics, error
  counts. No third-party APM that receives bodies or identifiers.

## 9. What is deliberately not here

- No admin endpoints, no feature flags service, no caching layer, no GraphQL, no WebSockets, no file storage.
- No multi-tenancy beyond "one user = one tenant"; no sharing of achievements between users (would be a new
  data flow and privacy decision).
