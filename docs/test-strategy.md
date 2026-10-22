# Test strategy

Status: M0 proposal (2026-10-22). Rules from the brief are non-negotiable: Red → Green → Refactor for every
behaviour, no test is deleted, skipped or weakened to get to green, every security/privacy requirement has at least
one automated test, deterministic tests only.

## 1. Principles

1. **Test first.** A failing test (that fails for the right reason) precedes every production change; the commit
   that introduces behaviour contains its tests.
2. **Deterministic.** Injected `Clock`; seeded randomness (`fast-check` seeds are fixed and printed on failure);
   no real network (the test environment blocks outbound connections except the Testcontainers database);
   no shared mutable state between tests (database per test file, fresh app instance per file).
3. **Real dependencies where it matters.** Integration tests run against real PostgreSQL (Testcontainers) with
   the real migrations, roles and RLS policies. Only the KMS and the email provider are faked, through the same
   interfaces used in production (`KeyWrapper`, `EmailSender`).
4. **Meaningful assertions.** Coverage is a signal; every test asserts observable behaviour (response, DB state,
   side effects), not implementation details.
5. **Traceability.** Test titles carry the IDs they prove (`R-AUTH-04`, `S-03`, …). A traceability test parses
   `docs/requirements.md` and `docs/security/threat-model.md` and fails if any security/privacy requirement or
   threat ID has no test referencing it.
6. **Flaky = broken.** `retry: 0`. A flaky test is fixed or reported to the PM; it is never quarantined silently.

## 2. Layers

| Layer | Scope | Tools | Location | Speed |
|-------|-------|-------|----------|-------|
| Unit | Domain engine (progress, XP, levels, streaks, transitions, effects), validation schemas, crypto wrappers, config parsing, time utilities, password policy | Vitest, `fast-check` (property tests), libsodium known-answer vectors | `src/**/*.test.ts` (colocated) | ms |
| Integration | API + real PostgreSQL: every endpoint's happy path and error paths, idempotency, concurrency, encryption at rest, outbox, retention jobs, audit | Vitest, Testcontainers (`postgres:17-alpine` pinned by digest), `fastify.inject` (no sockets) | `test/integration/**` | s |
| Contract | Every integration response validated against `openapi/openapi.yaml` (status, headers, body); spec coverage (every `operationId` exercised); Zod ↔ OpenAPI drift | Ajv 2020-12 + `ajv-formats`, `yaml`, `@redocly/cli lint` | harness hook + `test/contract/**` | s |
| Security | Authz/BOLA for every endpoint (generated from the spec), deny-by-default, auth flows and abuse cases, rate limiting, headers, RLS, DB roles, log leakage, config hardening, mass assignment, injection, prototype pollution | Vitest + Testcontainers | `test/security/**` | s |
| Privacy | Data-inventory guard, export completeness, deletion completeness (every table), consent gating and withdrawal effects, retention | Vitest + Testcontainers | `test/privacy/**` | s |
| E2E smoke | Built container image + PostgreSQL via Docker Compose: register → verify → login → consent → achievement → quest → check-in → stats → export → delete; container hardening checks (uid ≠ 0, read-only FS) | Vitest over HTTP, Docker | `test/e2e/**` | min |
| Mutation | Stryker on `src/domain/**` and `src/platform/crypto/**` | `@stryker-mutator/core` + Vitest runner | `stryker.config.mjs` | min (PR: changed files; nightly: full) |
| Non-gating | Timing-uniformity check for enumeration (S-02), load/limit tests (k6), DAST (ZAP API scan with the OpenAPI spec) against staging | nightly / M6 | `test/perf/**`, CI nightly | – |

## 3. Harness design (`test/helpers`)

- **`startDatabase()`** — one PostgreSQL container per test run (global setup). Migrations run once into a
  template database with the real roles (`questline_migrator`, `questline_app`, `questline_worker`) and RLS.
  Each test file gets `CREATE DATABASE … TEMPLATE questline_template` (fast, fully isolated) and drops it after.
- **`buildTestApp(overrides)`** — the production `buildApp()` with: `FakeClock` (settable, advanceable),
  `LocalKeyWrapper` with a test KEK, `FakeEmailSender` (captures messages so tests can extract verification/reset
  links), `FakeRandom` where determinism is needed (never for token generation tests, which assert on entropy),
  `LogCapture` (collects every log line of API + worker in memory).
- **Factories** — `aUser()`, `anAchievement()`, `aQuest({type})`, `aCheckIn()` produce synthetic data with
  sentinel markers (`SEED-<kind>-<n>`) that are registered in a **sensitive-values registry** used by the log-leak
  test (R-LOG-02) and the encryption-at-rest test (I-01): both scan raw outputs for every registered value.
- **`asUser(app, user)`** — helper returning a client bound to a logged-in session (handles tokens, `If-Match`,
  `Idempotency-Key`), so tests read as scenarios.
- **Contract hook** — `app.inject` is wrapped so every response is validated against the spec and recorded for the
  spec-coverage report. Routes not in the spec fail the test.
- **Two-instance mode** — `buildTestApp({instances: 2})` for multi-instance tests (rate limiting, advisory locks).

## 4. Domain engine test plan (≥ 95 % branch, Stryker ≥ 80 %)

| Area | Example cases |
|------|---------------|
| `targetProgress` | increasing 0→12 at 6 = 0.5; decreasing 90→80 at 85 = 0.5; overshoot clamps to 1; regression below start clamps to 0; start = target rejected; decimals; property: monotone in current for fixed direction |
| `habitProgress` | 5×/week × 8 weeks with 6 check-ins in a week counts 5; empty = 0; exactly N·K = 1; open-ended periods (Q-04 b) — a missed week delays completion; property: never exceeds 1 |
| `achievementProgress` | XP weighting (S=10, M=25, L=50); bonus quests excluded; no required quests → 0 (A-17) |
| Unlock/relock `effects` | all required complete → unlock + badge + bonus; undo → relock, −bonus; bonus quests never block; completion of a bonus quest after unlock does not re-trigger bonus; idempotent when state unchanged |
| XP ledger | award once per completion transition; undo → exact negative; complete-undo-complete → net one award; deletion revokes (Q-12) |
| Levels | thresholds at boundaries (99/100 XP), monotone, `xpToNextLevel` |
| Streaks | daily and weekly; current open period does not break; gap breaks; pause intervals frozen (periods inside a pause skipped); DST vectors **Europe/Zurich 2026-03-29 and 2026-10-25** (check-ins at 00:30/01:30/02:30/03:30 local, and 23:30 → next-day boundaries); Pacific/Auckland and America/Sao_Paulo as second opinions; week boundary Sunday→Monday; year boundary ISO week 53 |
| `tz` | `localDate` for instants around midnight and DST; invalid timezone rejected; property: `localDate(instant, tz)` changes at most once per 24 h window |
| Transitions | every allowed/forbidden status transition (R-ACH-07); lock state with prerequisites; cycle detection |

## 5. Security and privacy test catalogue (each requirement → test)

| Requirement | Test(s) |
|-------------|---------|
| R-AUTH-02 | `password-policy.test.ts`: 11 chars → 422, 12 OK, 128 OK, 129 → 400, top-100 breached → 422, no composition rules, Unicode NFKC, no truncation |
| R-AUTH-03 | `one-time-tokens.test.ts`: single use, 30 min + 1 s → 401, superseded → 401, stored as hash only (DB assertion) |
| R-AUTH-04 | `refresh-rotation.test.ts`, `token-ttl.test.ts` |
| R-AUTH-05 | `sessions.test.ts`, `password-change.test.ts` (other sessions revoked, current kept), `password-reset.test.ts` (all revoked) |
| R-AUTH-06 | `reauth.test.ts` (each sensitive endpoint without recent re-auth → 403) |
| R-AUTH-07 | `enumeration.test.ts` (byte-identical bodies/status/headers minus request_id; hasher spy; same emails sent count) |
| R-AUTH-08 | `rate-limit.test.ts` (per IP, per account, backoff progression, Retry-After, two instances share state) |
| R-AUTHZ-01 | `deny-by-default.test.ts` (spec-driven) |
| R-AUTHZ-02/03 | `ownership.test.ts` (spec-driven: every operation with an ID, user A vs user B → 404, no side effects) ; `rls.test.ts` |
| R-AUTHZ-04 | `mass-assignment.test.ts` |
| R-IN-01 | `limits.test.ts` (body 64 KiB + 1 → 413, limit=101 → 400, 201st achievement → 422, unknown field → 400) |
| R-IN-02 | ESLint rule test + `injection.test.ts` |
| R-OUT-01/03 | `problem-details.test.ts`, `idempotency.test.ts`, `concurrency.test.ts` |
| R-OUT-02 | `ids.test.ts` (UUID v4 format, 10⁴ IDs unique) |
| R-TLS-01…04 | `headers.test.ts` (each header on each route class; no CORS header even with `Origin`), `config.test.ts`, `compare.test.ts` |
| R-ENC-01/02 | `encryption-at-rest.test.ts`, `aead.test.ts`, `envelope.test.ts`, `blind-index.test.ts` (normalisation, uniqueness) |
| R-ENC-03 | `db-roles.test.ts` (app role: `CREATE TABLE` fails, `ALTER` fails, `TRUNCATE` fails) |
| R-LOG-01/02 | `log-leakage.test.ts` (global, after all tests), `request-id.test.ts` |
| R-LOG-03 | `audit.test.ts` |
| R-SUP-04 | `config.test.ts` (missing/weak/duplicate secrets, production guards) |
| R-PRIV-04 | `consent.test.ts` (create content without consent → 403; withdrawal deletes content; versions recorded) |
| R-PRIV-05 | `export.test.ts` (completeness vs seeded data; re-auth; 3rd export in 24 h → 429; audit event) |
| R-PRIV-06 | `account-deletion.test.ts` (every table empty for the user; DEK gone; tokens invalid; tombstone written; re-registration with the same email works) |
| R-PRIV-07 | `retention.test.ts` (clock-driven: unverified 7 d, audit 90 d, idempotency 24 h, tokens, tombstones 35 d) |
| R-PRIV-08 | `data-inventory-guard.test.ts` (§6 of the data inventory) |

## 6. Coverage, mutation and quality gates

| Gate | Threshold | Enforced by |
|------|-----------|-------------|
| Branch coverage `src/domain/**` | ≥ 95 % | Vitest `coverage.thresholds` (per-glob) |
| Overall coverage (lines/branches/functions) | ≥ 85 % | Vitest thresholds |
| Mutation score `src/domain/**`, `src/platform/crypto/**` | ≥ 80 % | Stryker `thresholds.break` |
| Lint / format / import boundaries | 0 errors | ESLint (typescript-eslint strict, `eslint-plugin-regexp`, security rules), Prettier, dependency-cruiser |
| Typecheck | 0 errors, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` | `tsc --noEmit` |
| OpenAPI | lint clean; all operations covered by tests | Redocly, spec-coverage test |
| SAST | 0 findings (Semgrep `p/typescript`, `p/nodejs`, `p/owasp-top-ten`, custom rules) | CI |
| Dependencies | 0 high/critical | `osv-scanner` (lockfile) |
| Secrets | 0 | gitleaks (CI + pre-commit via lefthook) |
| Container | 0 high/critical | Trivy image scan |
| SBOM | generated and attached to the build | `@cyclonedx/cyclonedx-npm` |
| Commits | Conventional Commits | commitlint |

## 7. CI pipeline (GitHub Actions, M1)

```
push / pull_request
 ├─ install (npm ci, engine-strict, cache)
 ├─ lint ─ typecheck ─ commitlint ─ redocly lint          (parallel, fast fail)
 ├─ unit tests + coverage (no Docker)
 ├─ integration + contract + security + privacy tests     (Docker service for Testcontainers) + coverage merge + thresholds
 ├─ mutation (Stryker incremental on changed files; full run nightly)
 ├─ semgrep ─ osv-scanner ─ gitleaks                       (parallel)
 ├─ build image → trivy → sbom (artifact)
 └─ e2e smoke against the built image
nightly: full Stryker, timing-uniformity check, dependency refresh report
M6: ZAP API scan + k6 against staging
```

All gates are `required` checks on `master`. No `continue-on-error`, no `--no-verify`.

## 8. Conventions

- Vitest `describe` per unit/endpoint; `it('<behaviour> [R-ID, T-ID]')` in plain language, AAA structure.
- One assertion concept per test; use custom matchers for problem responses (`toBeProblem('urn:questline:problem:…', 404)`).
- Test data never contains real personal data; emails use the reserved domain `example.test`.
- Tests that must observe time use `clock.set('2026-03-29T00:30:00+01:00')`-style explicit instants with zone.
- Tests for negative paths assert **both** the response and the absence of side effects (DB unchanged, no email, no XP).
