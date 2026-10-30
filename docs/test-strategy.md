# Test strategy

Status: M0 proposal v2 (2026-10-22, updated for the PM decisions). Rules from the brief are non-negotiable: Red → Green → Refactor for every
behaviour, no test is deleted, skipped or weakened to get to green, every security/privacy requirement has at least
one automated test, deterministic tests only.

## 1. Principles

1. **Test first.** A failing test (that fails for the right reason) precedes every production change; the commit
   that introduces behaviour contains its tests.
2. **Deterministic.** Injected `Clock`; seeded randomness (`fast-check` seeds are fixed and printed on failure);
   no real network (the test environment blocks outbound connections except the Testcontainers database);
   no shared mutable state between tests (database per test file, fresh app instance per file).
3. **Real dependencies where it matters.** Integration tests run against real PostgreSQL (Testcontainers) with
   the real migrations, roles and RLS policies. Only the KEK source (1Password Connect) and the SMTP relay are
   replaced, through the same interfaces used in production (`KekSource`, `EmailSender`); the real adapters are
   tested separately against a local Connect stub and a local SMTP test server (ADR-0013, ADR-0014).
4. **Meaningful assertions.** Coverage is a signal; every test asserts observable behaviour (response, DB state,
   side effects), not implementation details.
5. **Traceability.** Test titles carry the IDs they prove (`R-AUTH-04`, `S-03`, …). A traceability test parses
   `docs/requirements.md` and `docs/security/threat-model.md` and fails if any security/privacy requirement or
   threat ID has no test referencing it.
6. **Flaky = broken.** `retry: 0`. A flaky test is fixed or reported to the PM; it is never quarantined silently.

## 2. Layers

| Layer | Scope | Tools | Location | Speed |
|-------|-------|-------|----------|-------|
| Unit | Domain engine (progress, habit resets, XP, duration factor, levels, execution score and ranks, gambles, streaks, transitions, effects), validation schemas, crypto wrappers, KEK source, SMTP sender, config parsing, time utilities, password policy | Vitest, `fast-check` (property tests), libsodium known-answer vectors | `src/**/*.test.ts` (colocated) | ms |
| Integration | API + real PostgreSQL: every endpoint's happy path and error paths, idempotency, concurrency, encryption at rest, outbox, retention jobs, audit | Vitest, Testcontainers (`postgres:17-alpine` pinned by digest), `fastify.inject` (no sockets) | `test/integration/**` | s |
| Contract | Every integration response validated against `openapi/openapi.yaml` (status, headers, body); spec coverage (every `operationId` exercised); Zod ↔ OpenAPI drift | Ajv 2020-12 + `ajv-formats`, `yaml`, `@redocly/cli lint` | harness hook + `test/contract/**` | s |
| Security | Authz/BOLA for every endpoint (generated from the spec), deny-by-default, auth flows and abuse cases, rate limiting, headers, RLS, DB roles, log leakage, config hardening, mass assignment, injection, prototype pollution | Vitest + Testcontainers | `test/security/**` | s |
| Privacy | Data-inventory guard, export completeness, deletion completeness (every table), consent gating and withdrawal effects, retention | Vitest + Testcontainers | `test/privacy/**` | s |
| E2E smoke | Built container image + PostgreSQL via Docker Compose: register → verify → login → consent → achievement → quest → check-in → gamble → stats → export → delete (`202`); container hardening checks (uid ≠ 0, read-only FS, no shell, no package manager) | Vitest over HTTP, Docker | `test/e2e/**` | min |
| Mutation | Stryker on `src/domain/**` and `src/platform/crypto/**` | `@stryker-mutator/core` + Vitest runner | `stryker.config.mjs` | min (every push; incremental on changed files plus a nightly full run from M3) |
| Non-gating | Timing-uniformity check for enumeration (S-02), load/limit tests (k6), DAST (ZAP API scan with the OpenAPI spec) against staging | nightly / M6 | `test/perf/**`, CI nightly | – |

## 3. Harness design (`test/helpers`)

- **`startDatabase()`** — one PostgreSQL container per test run (global setup). Migrations run once into a
  template database with the real roles (`questline_migrator`, `questline_app`, `questline_worker`) and RLS.
  Each test file gets `CREATE DATABASE … TEMPLATE questline_template` (fast, fully isolated) and drops it after.
- **`buildTestApp(overrides)`** — the production `buildApp()` with: `FakeClock` (settable, advanceable),
  `LocalKeyWrapper` with a test KEK, `FakeEmailSender` (captures messages so tests can extract verification/reset
  links), `FakeRandom` where determinism is needed (never for token generation tests, which assert on entropy),
  `LogCapture` (collects every log line of API + worker in memory).
- **Factories** — `aUser()`, `anAchievement()`, `aQuest({type})`, `aCheckIn()`, `aGamble()` produce synthetic data with
  sentinel markers (`SEED-<kind>-<n>`) that are registered in a **sensitive-values registry** used by the log-leak
  test (R-LOG-02) and the encryption-at-rest test (I-01): both scan raw outputs for every registered value.
- **`asUser(app, user)`** — helper returning a client bound to a logged-in session (handles tokens, `If-Match`,
  `Idempotency-Key`), so tests read as scenarios.
- **Contract hook** — `app.inject` is wrapped so every response is validated against the spec and recorded for the
  spec-coverage report. Routes not in the spec fail the test.
- **Two-instance mode** — `buildTestApp({instances: 2})` for multi-instance tests (rate limiting, advisory locks).
- **Connect stub and SMTP test server** — a local HTTP stub of the 1Password Connect API (`kek-source.test.ts`) and an
  in-process SMTP server (`smtp-server`) with a certificate generated per run (`test/helpers/tls-certificate.ts`,
  so no private key is committed; `smtp-sender.test.ts`); no test ever reaches a real 1Password or SMTP service.

## 4. Domain engine test plan (≥ 95 % branch, Stryker ≥ 80 %)

| Area | Example cases |
|------|---------------|
| `targetProgress` | increasing 0→12 at 6 = 0.5; decreasing 90→80 at 85 = 0.5; overshoot clamps to 1; regression below start clamps to 0; start = target rejected; decimals; property: monotone in current for fixed direction |
| `habitProgress` | 5×/week × 8 weeks with 6 check-ins in a week counts that week as met (not 6/5); empty = 0; K consecutive met periods = 1; progress = consecutive met periods since the run's `start_date` / K; only counting check-ins of the current attempt and run count (back-dated and earlier ones ignored); property: never exceeds 1 |
| Habit reset (`habit-reset.ts`, R-QST-04) | a closed period with < N counting check-ins → progress 0, `needs_restart`, `reset_count + 1`, exactly once per missed period; the open period never triggers a reset; a period counts as met once it has N counting check-ins, and the habit completes as soon as its K-th period is met; detection on read/write equals detection by the daily job (property: a reset or completion found on one day is found unchanged on every later day, A-21); a check-in made today never causes a reset; restart with `start_date` ≥ today clears `needs_restart`, a past `start_date` is rejected (A-28); a reset settles a pending gamble as lost |
| Periods (`periods.ts`, R-QST-09) | week periods for `week_start` = monday, sunday, saturday; day periods; the first weekly period of a habit runs from `start_date` to the end of the first full week, 7–13 days (Q-33); a habit run keeps the week start it began with (Q-34, A-23); the current period's window and count for the API (Q-35); year boundary incl. ISO week 53 for Monday weeks |
| Duration factor (`duration.ts`, R-XP-02) | table-driven boundaries — daily K = 28 → ×1, 29 → ×1.5, 56 → ×1.5, 57 → ×2, 112 → ×2, 113 → ×3; weekly K = 4 (28 d) → ×1, 5 (35 d) → ×1.5, 8 (56 d) → ×1.5, 9 (63 d) → ×2, 16 (112 d) → ×2, 17 (119 d) → ×3; one_time and target → ×1; `round(25 × 1.5) = 38` (half up); derived from the quest structure only, never from client input |
| `achievementProgress` | weighting by effective XP (base S=10, M=25, L=50 × duration factor); bonus quests excluded; no required quests → 0 (A-17); exactly 1 only when every required quest is complete, also where a floating-point sum would round up |
| Decimals (`decimal.ts`, A-05) | canonical strings ("80.50" → "80.5", "-0" → "0"), ≤ 3 fractional digits, \|value\| ≤ 10^9, exponents/signs/spaces refused; property: reading back what is written |
| Execution score and rank (`rank.ts`, R-RANK-01…03) | habit term `100 / (1 + resets)` XP-weighted, one_time and target = 100; lateness factor `max(0, 1 − days_late / 30)` at 0, 1, 15, 30 and 31 days late, measured from the attempt's deadline — the earliest `target_date` in effect during the attempt, so postponing or removing the date changes nothing and bringing it forward counts (Q-31, A-35) — and an unlock on the deadline itself is on time (A-20); −10 per gamble lost on the achievement in any attempt; clamp 0–100; `rankForScore` boundaries 54.99 → unranked, 55 → Bronze, 65, 75, 85, 92, 99.99 → Emerald, 100 → Diamond; Champion only with 100 + attempt 1 + no reset + no lost gamble + all bonus quests completed + on time; `rankBonus` = round(Σ required xp × multiplier) for ×0.5 … ×365, unranked → 0, and 0 when the unlock comes less than 7 × 24 h after the achievement's creation (A-34); property: adding a reset, lateness or a lost gamble never raises score or rank |
| Gambles (`gamble.ts`, R-GMB-01…04) | placement guards: achievement `active`, `target_date` after today, no pending gamble on any achievement of the user (Q-31), no loss in the current attempt (A-27), stake > 0; stake = XP above the current level's threshold; win on unlock on/before `target_date` → +min(stake, the achievement's required XP), +0 when the unlock comes less than 7 × 24 h after creation (Q-31, A-34); loss when `target_date` has passed (evaluated after local midnight, A-20), on habit reset, pause or deletion → −min(stake, XP above the current level's threshold at settlement) (Q-31); undo of the winning unlock → pending again; each gamble settles exactly once (state-machine property test); injected-clock vectors with the target date on **Europe/Zurich 2026-03-29 and 2026-10-25** and settlement checks at 23:30, 00:30, 01:30, 02:30 and 03:30 local; Pacific/Auckland as a second opinion |
| Unlock/relock `effects` | all required complete → unlock + score + rank + `achievement_rank` badge + rank bonus + gamble won; undo → relock, −bonus, badge and rank removed, gamble back to pending (R-ACH-05, R-RANK-04); bonus quests never block; a pending gamble whose target date passed is lost before an unlock and counts in its score; pause → pending gamble lost, then attempt XP revoked (R-ACH-06); deleting the last open required quest unlocks; properties: reconciling an applied outcome again changes nothing (idempotent), completing and un-completing a quest restores XP, credits and status exactly, N pause loops leave nothing behind (T-16), the total never ends below 0 (A-38) |
| XP ledger | award once per completion transition; undo → exact negative; complete-undo-complete → net one award; deletion revokes (Q-12); back-dated check-ins never award (R-CHK-04); N pause/resume loops yield the XP of one honest run (T-16); totals stay within 0 … 2^53 − 1 (R-XP-04) |
| Levels (`xp.ts`, R-XP-03) | `100 × 3^(L−2)`: L1 at 0, L2 100, L3 300, L4 900, L5 2 700, L10 656 100; boundaries 99/100 and 299/300; monotone; `xpToNextLevel`; a lost gamble never lowers the level (Q-31) |
| Counting check-ins (R-CHK-04) | `checkInDating(local_date, today)` (`check-in-dating.ts`): today → counts; 1–7 days back → stored with `counts_for_progress = false`; 8 days back or future → rejected; "today" from `localDateOf(now, tz)` (`platform/time/time-zones.test.ts`): instants around local midnight and on both Zurich DST dates |
| Streaks | daily and weekly; current open period does not break; streak = met periods of the current attempt (a pause starts a new attempt, R-ACH-06), best streak across attempts; DST vectors **Europe/Zurich 2026-03-29 and 2026-10-25** (check-ins at 00:30/01:30/02:30/03:30 local, and 23:30 → next-day boundaries); Pacific/Auckland and America/Sao_Paulo as second opinions |
| `tz` | `localDateOf` (`platform/time/time-zones.test.ts`) for instants around midnight and both Zurich DST dates, Pacific/Auckland as a second opinion; unknown time zone rejected; through a whole year, the date moves at most one day per hour and never backwards (a "once per 24 h" property would be false on 23-hour days) |
| Transitions | `active ↔ paused` only, `completed` system-only, read-only and not deletable (R-ACH-07); quest states `locked`, `available`, `needs_restart`, `completed`; prerequisites: same achievement, cycles (also corrupt stored ones), chains of 20 links allowed and 21 refused on both sides of the changed quest (A-16), property: a link is refused as a cycle exactly when it would lead back to the quest; habit settings and prerequisite fixed once a run has begun, editable before it, while locked and at a restart (Q-37, Q-38); a locked habit's run starts on the unlock day (Q-38); a completed quest keeps its target values (A-37) |

## 5. Requirement and threat → test catalogue (security, privacy, gamification integrity)

| Requirement | Test(s) |
|-------------|---------|
| R-AUTH-02 | `password-policy.test.ts` (breached list after NFKC, context word, no composition rules); `integration/registration.test.ts`: 11 characters and 11 emoji → 400, 12 characters and 12 emoji OK, 128 OK, 129 → 400 (code points, as JSON Schema counts), breached → 422 before any lookup; `password.test.ts` (Argon2id parameters, NFKC, no truncation) |
| R-AUTH-03 | `integration/registration.test.ts` (verification): emailed token works once, a replay answers 204 and changes nothing (contract), 30 min + 1 s → 401, superseded by a resend → 401, other token kinds → 401, stored as SHA-256 only (DB assertion); `integration/passwords.test.ts` (reset: `ql_pt_` token emailed, 30 min, hash only, single use, superseded by a newer request, other kinds refused, a weak password does not use it up) |
| R-AUTH-04 | `integration/refresh.test.ts` (rotation marks the used generation and issues the next; a rotated token coming back revokes the session, deletes its tokens and is audited `refresh_reuse_detected`; two truly concurrent uses — forced by holding the row lock until both wait — yield one 200 and one reuse; access, unknown and malformed tokens refused); `integration/auth-guard.test.ts` (an access token works for 15 minutes, not a second longer) |
| R-AUTH-05 | `integration/auth-guard.test.ts` (logout ends only the current session — revoked, tokens deleted, audited; logout-all ends every session of the user and no other user's), `integration/my-sessions.test.ts` (list: only active sessions — not revoked, before the absolute expiry, refresh token unexpired — newest first, labels decrypted, current marked; revoke: another or the current session, tokens deleted, audited `session_revoked`; 404 for another user's, unknown, malformed or already revoked session), `integration/passwords.test.ts` (password change: other sessions revoked with their tokens, current kept; reset: all revoked) |
| R-AUTH-06 | `src/modules/sessions/reauth.test.ts` (window: allowed up to 10 min − 1 ms, refused at 10 min), `integration/my-sessions.test.ts` (`POST /auth/reauth`: correct password → 204, `last_reauth_at` = now, one Argon2id verification, audited; wrong → 401 `invalid-credentials`, nothing changed, audited `reauth_failed`), `integration/passwords.test.ts` (password change 10 min after the last password entry → 403, nothing changed), `reauth.test.ts` (each further sensitive endpoint without recent re-auth → 403, added with the endpoints) |
| R-AUTH-07 | `integration/email-change.test.ts` (free vs. taken new address: identical 202), `security/enumeration.test.ts` (status, headers minus `date` and body identical for new/existing/deactivated registrations and for resend to unknown/unverified/verified/deactivated addresses; hasher spy: exactly one hash per registration, none for a breached password; one email per registration either way) |
| R-AUTH-08 | `security/rate-limit.test.ts` (20/min per client address → 429 + `Retry-After: 3`, another address unaffected, a token back after 3 s; an IPv6 /64 counts as one client; two API instances on one database share the buckets; login backoff 5 free failures then 60, 120, 240, 480, 900, 900 s, a success clears it, unknown addresses behave identically; re-auth and password change share a per-user backoff; 3 emails/h per address — registered or not — and per user for email changes, a breached registration costs nothing; buckets reset with the UTC day; the table holds only 32-byte keyed hashes and counters, logs name the scope only), `src/modules/rate-limit/policy.test.ts` (token bucket and backoff arithmetic), `keys.test.ts` (daily key, no raw subject, IPv6 /64), `contract/rate-limits.test.ts` (every `/v1` operation documents 429; every implemented route takes the per-user bucket when authenticated and the per-client bucket when public, before its handler — Q-30); `security/rate-limit.test.ts` also: any authenticated operation, e.g. `GET /me`, 120/min per user, then 429 + `Retry-After: 1`, other users unaffected |
| R-AUTH-09 | `integration/login.test.ts` (correct password on an unverified account → 403, wrong password → 401), `security/enumeration.test.ts` (unknown address, wrong password and unverified account with a wrong password: identical 401, one Argon2id verification each), `retention.test.ts` (unverified accounts purged after 7 d) |
| R-AUTH-10 | `integration/refresh.test.ts` with injected clock: a refresh token expires exactly 30 d after issue, each use slides the window (three uses 29 d apart), a session ends 180 d after login even when used, the last tokens are capped at the absolute expiry (600 s left → `access_expires_in` = `refresh_expires_in` = 600), a past absolute expiry is refused even with a valid refresh token; `integration/auth-guard.test.ts`: an access token works at 14 min 59 s and is refused at 15 min, and stays valid after a refresh until it expires |
| R-AUTH-11 | `integration/registration.test.ts`: missing or `false` `age_confirmed` → 400 with no account and no email; `true` → 202 and the flag stored; schema introspection proves no date-of-birth column exists |
| R-AUTHZ-01 | `contract/deny-by-default.test.ts` (spec-driven: the routes marked public are exactly the implemented operations with `security: []`; every other implemented operation answers 401 + `WWW-Authenticate: Bearer` without a token, with another scheme and with an unknown token), `integration/auth-guard.test.ts` (malformed headers, refresh token as access token, revoked or expired session) |
| R-AUTHZ-02/03 | `ownership.test.ts` (spec-driven: every operation with an ID, user A vs user B → 404, no side effects) ; `rls.test.ts` |
| R-AUTHZ-04 | `integration/me.test.ts` (`PATCH /me` with `email`, `version` or any unknown property → 400, nothing changed), `mass-assignment.test.ts` (M3 resources) |
| R-IN-01 | `contract/problem-details.test.ts` + `contract/body-errors.test.ts` (body 64 KiB + 1 → 413, non-JSON → 415, both as documented on every operation with a body — Q-25), `security/limits.test.ts` (M2: arrays and objects nested up to the body limit → 400, the process keeps serving; M3: limit=101 → 400, 201st achievement → 422, unknown field → 400), `integration/login.test.ts` (21st login logs out the least recently used session, tokens deleted, audited — Q-29); text limits count characters like JSON Schema (`validation.test.ts`: emoji, combining marks); pagination (`platform/http/pagination.test.ts`: cursor round trip and refusals, `limit` 1–100 as plain decimals, default 20; `integration/pagination.test.ts`: every row exactly once for page sizes 1–100 with shared timestamps, stable across inserts and deletes between pages) |
| R-IN-02 | ESLint `no-restricted-imports`/syntax rules (only `platform/db` builds SQL) + `security/injection.test.ts` (SQL meta-characters in the address, password, device label and nickname come back unchanged; M3 adds the goal-content fields) |
| R-OUT-01/03 | `problem-details.test.ts`, `src/platform/http/concurrency.test.ts` (ETag format; `If-Match` parsing refuses weak tags, lists, `*`, 0 and over 9 digits), `integration/me.test.ts` (ETag = version on GET and PATCH; no `If-Match` → 428; stale → 409 with `current_version`; malformed → 400), `idempotency.test.ts`, `concurrency.test.ts` |
| R-OUT-02 | `ids.test.ts` with the M3 resources (UUID v4 format, 10⁴ IDs unique); M2 identifiers (accounts, sessions, consents) come from `randomUUID()` and have no dedicated test yet |
| R-TLS-01…04 | `headers.test.ts` (each header on each route class; no CORS header even with `Origin`), `config.test.ts`, `compare.test.ts` |
| R-ENC-01/02 | `encryption-at-rest.test.ts`, `aead.test.ts`, `envelope.test.ts`, `blind-index.test.ts` (normalisation, uniqueness) |
| R-ENC-03 | `db-roles.test.ts` (app role: `CREATE TABLE` fails, `ALTER` fails, `TRUNCATE` fails) |
| R-ENC-05 | `kek-source.test.ts` against a local Connect stub (happy path; 401, 404, timeout, malformed or < 32-byte item → startup refused; Connect token and KEK never logged), `config.test.ts` (production refuses an env-provided KEK), `kek-source.test.ts` (the KEK is copied into guarded memory and the loaded buffer wiped; it is not explicitly zeroed at shutdown — the guarded allocation is locked and freed with the process) |
| R-LOG-01/02 | `log-leakage.test.ts` (global, after all tests), `request-id.test.ts` |
| R-LOG-03 | each flow's integration test asserts its audit event (registration, login, refresh, logout, sessions, passwords, email change, consents); `integration/encryption-at-rest.test.ts` (no address or token in audit metadata); `integration/retention.test.ts` (90 days); export and deletion events with M4 |
| R-SUP-04 | `config.test.ts` (missing/weak/duplicate secrets, production guards) |
| R-PRIV-04 | `integration/consents.test.ts` (M2: explicit, versioned grant → 201 and audited; a second active grant → 409, also for two simultaneous grants; withdrawal keeps the history, is audited and allows a later grant; nobody else's consents visible or withdrawable), `consent.test.ts` (M3/M4: creating goal content without consent → 403; withdrawal deletes all goal content) |
| R-PRIV-05 | `export.test.ts` (completeness vs seeded data; re-auth; 3rd export in 24 h → 429; audit event) |
| R-PRIV-06 | `integration/login.test.ts` (M2): a correct password within 30 d reactivates (audited `account_reactivated`, version + 1), at exactly 30 d the account counts as deleted (401, no reactivation) even before the purge job ran; `account-deletion.test.ts` (M4) with injected clock: `DELETE /me` → 202 with `deletion_scheduled_for` = now + 30 d, every session and token revoked, other endpoints unusable, no further email; a wrong password stays an identical 401; at 30 d + 1 s the job hard-deletes (every table empty for the user, wrapped DEK gone, tombstone written); re-registration with the same email works afterwards |
| R-PRIV-07 | `integration/retention.test.ts` (clock-driven, each period at its boundary: unverified accounts 7 d with everything they own, used/expired one-time tokens, session tokens at refresh expiry, sessions 7 d after revocation/expiry/last refresh, audit 90 d, hashed rate-limit rows 24 h, dead letters 7 d, tombstones 35 d, job runs 30 d, batching; all jobs through the scheduler with the worker role), `integration/scheduler.test.ts` (one instance at a time, one schedule, failures recorded and rolled back); M3 adds idempotency 24 h, M4 deactivated accounts 30 d |
| R-PRIV-08 | `data-inventory-guard.test.ts` (§6 of the data inventory) |
| R-XP-02 | `duration.test.ts` (factor table at every boundary for daily and weekly spans, rounding, one_time/target ×1), `quests.test.ts` (client cannot set `xp` or `duration_factor` → 400) |
| R-XP-03 | `xp.test.ts` (level thresholds and boundaries; level never drops through a lost gamble — Q-31) |
| R-QST-04 | `habit-reset.test.ts` (domain) + `integration/habit-reset.test.ts` (reset detected lazily on read and by the daily job; `needs_restart` blocks check-ins → 409; restart via `PATCH` with `start_date` ≥ today; history kept and not counted) |
| R-QST-09 | `periods.test.ts` (monday/sunday/saturday boundaries; change applies to later periods only, A-23), `me.test.ts` (`PATCH /me` `week_start`) |
| R-CHK-04 | `check-ins.test.ts` with injected clock: today counts; 1–7 days back stored with `counts_for_progress = false` and no effect on progress, XP, streak, reset or rank; 8 days back and future → 422; a check-in dated today on a habit whose run has not begun → 422 (A-36); around local midnight and on both Zurich DST dates |
| R-CHK-03 | `check-ins.test.ts`: an undo on the day of the check-in reverses every effect; the next day (account timezone) → 409 `check-in-final` and nothing changes (Q-36) |
| R-QST-07 | `quests.test.ts`: a running or completed habit's `period`, `times_per_period`, `period_count` and `start_date` → 422 and nothing changes; allowed at a restart and before the run's `start_date`; other fields stay editable (Q-37) |
| R-RANK-01/02 | `rank.test.ts` (score formula, rank thresholds, Champion conditions; property tests) |
| R-RANK-03 | `rank.test.ts` (multipliers and rounding; no bonus for an unlock less than 7 × 24 h after creation, A-34), `integration/unlock.test.ts` (exactly one `rank_bonus` event and one `achievement_rank` badge per unlock) |
| R-RANK-04 | `integration/effects-undo.test.ts` (undo of the unlocking check-in removes rank, score, badge and bonus; a gamble won by it is pending again) |
| R-RANK-05 | `xp-ledger.test.ts` (rank bonuses are a distinct ledger kind per unlock, so a later currency can be derived without migrating history) |
| R-GMB-01 | `integration/gamble.test.ts` (each placement guard → 409/422, incl. a gamble already pending on another achievement of the user — Q-31; stake computed server-side; client fields → 400; `Idempotency-Key` replay; 10 parallel placements on different achievements → one 201) |
| R-GMB-02/03 | `integration/gamble-settlement.test.ts` (win on/before the target date incl. the date itself; loss by the daily job after the date with injected clock across both Zurich DST dates, and on habit reset, pause and deletion; exactly one settlement; quest progress unaffected by a loss; a win pays at most the required XP and +0 within 7 days of creation, a loss takes at most the XP above the level threshold — Q-31) |
| R-GMB-04 | `integration/gamble.test.ts` (no cancel operation exists in the spec; a loss lowers the score and rules out Champion) |
| R-GMB-05 | design constraint, checked by the spec-coverage test (no purchase or payment operation) and `dependency-allowlist.test.ts` (no payment SDK) |
| T-16 | `integration/pause-reset.test.ts` (N pause/resume and complete/undo loops → net XP of one honest run; no new gamble after a loss in the same attempt, A-27) |
| T-17 | `integration/gamble.test.ts` (parallel placement and settlement → exactly one; `target_date` change while a gamble is pending → 409, A-26), `security/mass-assignment.test.ts` (client `stake`, `status`, `attempt` → 400) |
| T-18 | `rank.test.ts`, `integration/check-ins.test.ts` (back-dated check-ins never change score or rank; a timezone change re-buckets no closed period) |
| E-11 | `kek-source.test.ts` (unreachable or unauthorised Connect server → refuse to start; token and KEK never logged); KEK rotation drill in M6 |
| E-12 | `integration/smtp-sender.test.ts` (plaintext relay and untrusted certificate refused before any credentials are sent, TLS required), `integration/outbox-delivery.test.ts` (auth failure → retry, pause, then dead letter), `config.test.ts` (SMTP credentials required and strength-checked, no plaintext mode), `security/rate-limit.test.ts` (per-account send limit) |
| E-13 | `security/deactivation.test.ts` (after `DELETE /me`: access and refresh tokens → 401; forgot-password → uniform 202 without email; only a password login reactivates, rate-limited and audited) |

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
push to master · pull_request · nightly 03:17 UTC — seven parallel jobs, all must pass
 ├─ static     npm ci (engine-strict, no install scripts) → format → lint → typecheck → dependency-cruiser
 │             → redocly lint → actionlint → commitlint (pushed range)
 ├─ test       unit + integration + contract + security + privacy tests in one Vitest run (Testcontainers on the
 │             runner's Docker) → coverage thresholds → spec-coverage gate
 ├─ mutation   Stryker (full run on every push while the mutated set is small; incremental on changed files plus a
 │             full nightly run once src/domain grows, M3)
 ├─ semgrep    custom rule tests (`semgrep --test .semgrep/`) → scan with p/typescript, p/nodejs, p/owasp-top-ten
 │             and the custom rules
 ├─ osv        lockfile scan (accepted advisories only with reason and expiry in osv-scanner.toml)
 ├─ gitleaks   full history (reviewed synthetic test values pinned by fingerprint in .gitleaksignore)
 └─ image      build → Trivy (HIGH/CRITICAL incl. unfixed, secrets) → CycloneDX SBOMs for npm and the image
               (artifact, 90 days) → e2e smoke against the Compose stack
nightly, from M2: timing-uniformity check; dependency refresh report (planned)
M6: ZAP API scan + k6 against staging
```

Actions are pinned to commit SHAs and scanner images to digests; the workflow token is read-only and never
persisted; scanners get read-only mounts and Trivy scans an exported image tarball instead of the Docker socket.

Work is pushed directly to `master` (ADR-0001 as amended), so the fast gates also run locally in the lefthook `pre-push`
hook and CI runs every gate on each push; a red pipeline is fixed or reverted before any other work. No
`continue-on-error`, no `--no-verify`, no force-push.

## 8. Conventions

- Vitest `describe` per unit/endpoint; `it('<behaviour> [R-ID, T-ID]')` in plain language, AAA structure.
- One assertion concept per test; use custom matchers for problem responses (`toBeProblem('urn:questline:problem:…', 404)`).
- Test data never contains real personal data; emails use the reserved domain `example.test`.
- Tests that must observe time use `clock.set('2026-03-29T00:30:00+01:00')`-style explicit instants with zone.
- Tests for negative paths assert **both** the response and the absence of side effects (DB unchanged, no email, no XP).
