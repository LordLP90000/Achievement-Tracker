# Milestone plan and effort

Status: M0 proposal (2026-10-22). Effort is given in focused engineering days (senior-engineer equivalent) and
includes writing tests first, docs and reports; calendar time depends on how fast PM decisions arrive. Each
milestone ends with a status report and waits for the PM's "go". All work is pushed directly to `master` (ADR-0001 as
amended on 2026-10-22).

## Summary

| Milestone | Scope | Effort (days) | Needs from PM before start |
|-----------|-------|---------------|----------------------------|
| M0 Plan | this document set | done in 1 | – |
| M1 Walking skeleton | repo, tooling, Docker, CI gates, config/secrets, health, Testcontainers + contract harness | 4–6 | "go" (Q-20 Node 26, Q-21 RLS, Q-22 housekeeping are decided) |
| M2 Accounts & sessions | crypto platform, registration/verification/login/refresh/reset, sessions, re-auth, consent, audit, rate limiting, outbox/worker, email adapter | 10–14 | none: built against local stand-ins for the SMTP relay and the Connect server (Q-27); O-02/O-03 needed before M6 (Q-02/03/06/07/09/14/15/23 are decided) |
| M3 Core domain | domain engine (+ Stryker), achievements/quests/check-ins, field encryption, idempotency, concurrency, stats, ownership tests for every endpoint | 12–16 | O-05 review of gambling-like mechanics, O-06 rank/gamble integrity rules, objections to A-26…A-28 if any (Q-04/05/08/12/16/17/18/24 are decided) |
| M4 Privacy rights | export, deletion + crypto-shredding + tombstones, consent withdrawal effects, retention jobs, data-inventory guard test | 5–7 | – (Q-10/11/13 are decided) |
| M5 Auth hardening | passkeys (WebAuthn), optional TOTP 2FA, recovery codes, step-up | 7–10 | approval of WebAuthn library dependency; RP ID/domain (Q-19) |
| M6 Hardening & handover | DAST (ZAP) + load/limits (k6) on staging, deployment config for the chosen provider, runbooks (ops, key rotation, restore drill, breach), API docs, `client-security.md`, DP-expert review package | 6–9 | O-01 hosting named (accounts/credentials for staging), O-04 consent and policy texts, budget |
| **Total** | | **51–72** (was 44–62 before the PM's decisions of 2026-10-22, see §Change log) | |

## Change log 2026-10-22 — impact of the PM's decisions (Q-01…Q-24)

| Decision | Impact | Effort delta |
|----------|--------|--------------|
| Q-04/Q-17 habit reset, pause = reset, attempts, no archiving | New `attempt`/`reset_count`/`needs_restart` columns, `counts_for_progress`; effects engine handles resets and pause revocation; daily job closes periods | M3 +2 d |
| Q-05 ranks, execution score, duration factor, ×3 level curve, gambles | New `gambles` table, rank/score fields, badge rank, XP `bigint`; new endpoint to place a gamble; settlement job; many new domain tests | M3 +4–5 d |
| Q-08 back-dated check-ins are history only | `counts_for_progress` flag; simpler streak repair logic | M3 ±0 |
| Q-11 30-day deletion grace | `deactivated_at`, login reactivation, daily hard-delete job | M4 +1 d |
| Q-18 week-start setting | `users.week_start`, period helpers parameterised | M3 +0.5 d |
| Q-02 1Password Connect KEK source | Connect client + startup checks (no SDK) | M2 +1 d |
| Q-03 custom SMTP | `nodemailer` sender + local SMTP test server | M2 +0.5 d |
| Q-01 hosting deferred | None for M1–M5; M6 depends on the host being named | – |
| Q-24 encrypted target_date | trivial | – |

Document updates after this change: done on 2026-10-22 (OpenAPI v2, `data-inventory.yaml` v2, test strategy,
architecture, cross-reference fixes — see `docs/PROGRESS.md`). O-06 (rank/gamble integrity) may add M3 effort
depending on the PM's choice.

Risk buffer: +15 % recommended for unknowns in external interfaces (1Password Connect, SMTP relay) and Node 26 native-module prebuilds.

## M1 — Walking skeleton (4–6 days)

Deliverables

- `package.json` with pinned Node 26 LTS (`.nvmrc`, `engines`, `engine-strict`), TypeScript strict config, ESLint
  (typescript-eslint strict, regexp, security rules), Prettier, dependency-cruiser, commitlint, lefthook (gitleaks
  pre-commit).
- `buildApp()` with: request context + request IDs, allowlist logger, security headers, JSON-only body parsing with
  limits, RFC 9457 error handler, `/health/live` + `/health/ready`.
- Config module (Zod) with secret-strength checks and production guards; `.env.example` with placeholders only.
- Drizzle + `drizzle-kit`; migration 0001: roles/grants script, RLS helper functions, `job_runs`.
- Testcontainers harness (template DB per run, DB per test file), `FakeClock`, `LogCapture`, contract validator
  hook (Ajv against `openapi.yaml`), spec-coverage reporter (allowing "not yet implemented" operations only via an
  explicit list that shrinks each milestone).
- Dockerfile (multi-stage, distroless or Alpine, non-root, read-only FS), `compose.yml` (postgres + api + worker).
- CI: lint, typecheck, unit, integration (Docker), coverage thresholds, Stryker (scaffold), Semgrep, osv-scanner,
  gitleaks, Trivy, CycloneDX SBOM, e2e smoke (health through the built image).

Exit criteria: all gates green on `master`; `docker compose up` serves `/health/ready`; tests prove config refusal,
headers, problem format, log allowlist, RLS fail-closed on a sample table, app role has no DDL.

## M2 — Accounts & sessions (10–14 days)

Deliverables (each test-first): `platform/crypto` (AEAD, envelope, `LocalKeyWrapper`, `KekSource` with the 1Password
Connect client, Argon2id hasher with semaphore, blind index, tokens), `users`/`user_keys`, register → verify → login → refresh →
logout/logout-all, sessions list/revoke, `reauth`, password change/forgot/reset, email change (two-step),
consents (grant/withdraw record; content deletion effect lands in M4 or here if M3 tables exist), audit events,
rate limiting with progressive backoff (PostgreSQL store, two-instance test), outbox + worker + `SmtpEmailSender`
(`nodemailer`), retention job for unverified accounts and expired tokens, security test suites
S-01…S-12, E-01…E-03, E-07…E-08, E-11, E-12, I-02, I-03, I-07, headers, enumeration, log leakage.

Exit criteria: ASVS L2 authentication/session checks covered by tests; coverage ≥ 85 %; mutation ≥ 80 % on crypto;
no personal data in captured logs; processors.md updated with the named SMTP relay operator and the 1Password details.

## M3 — Core domain (12–16 days)

Deliverables: `src/domain/*` with property tests and Stryker ≥ 80 %; achievements, quests (incl. prerequisites,
ordering), check-ins + undo, effects engine (exactly-once XP, unlock/relock, rank badges, pause resets), habit resets,
ranks and execution score, gambles with daily settlement, streaks with attempts and DST vectors, stats; field-level
encryption for all listed fields (incl. `target_date`, Q-24); idempotency keys;
optimistic concurrency; cursor pagination; limits; spec-driven ownership and deny-by-default tests covering every
operation; encryption-at-rest test; consent guard.

Exit criteria: every operation in `openapi.yaml` implemented and exercised; domain branch coverage ≥ 95 %;
ownership test matrix green; `GET /v1/me/stats` correct against seeded scenarios.

## M4 — Privacy rights (5–7 days)

Deliverables: export (complete, re-auth, rate-limited, audited), account deletion (30-day deactivation with
reactivation by login, then cascade, DEK destruction, tombstone, re-registration possible), consent withdrawal
deleting goal content, retention jobs (deactivated accounts 30 d, audit 90 d, idempotency 24 h, tombstones 35 d,
dead letters 7 d, sessions 7 d), data-inventory guard test, export-completeness test, deletion-completeness test,
DPIA update.

## M5 — Auth hardening (7–10 days)

Deliverables: passkeys (registration + authentication ceremonies, multiple credentials per user, `sign_count`
checks, attestation "none"), optional TOTP (RFC 6238, encrypted secrets, recovery codes hashed), step-up
re-authentication with passkey/TOTP, session list showing auth method, audit events, threat-model update.
Dependency decision for the PM: `@simplewebauthn/server` (vetted, widely used) vs. implementing WebAuthn
verification ourselves (not recommended — "never implement crypto yourself").

## M6 — Hardening & handover (6–9 days)

Deliverables: staging deployment on the chosen provider (IaC in `deploy/`), ZAP API scan with the OpenAPI spec and
zero high findings, k6 tests proving limits and backoff under load, restore drill with tombstone replay, key
rotation runbook (KEK re-wrap, blind-index key re-index), breach-notification runbook (FDPIC / GDPR 72 h),
operations runbook, API reference (Redoc build of the spec), `docs/client-security.md` (MASVS-aligned), review
package for the data-protection expert (DPIA, inventory, threat model, processors, test evidence).

## Cross-cutting schedule risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Open items O-02/O-03 (SMTP relay operator, Connect deployment) arrive late | Real adapters untested against the real services | Decided (Q-27): M2 builds against local stand-ins; wiring the real services is a task before staging (M6) |
| Node 26 prebuilds missing for `sodium-native` | M1/M2 delay | Fallback to Node 24 or `libsodium-wrappers-sumo` (ADR-0005), reported immediately |
| Testcontainers in CI (Docker-in-Docker, pull limits) | CI flakiness | Pin image by digest, use GitHub-hosted Docker, cache layers |
| 1Password Connect not available in CI | Cannot integration-test the real KEK source | Contract tests against a local Connect stub; one manual verification on staging in M6 |
| Scope creep from app-team requests (e.g. reorder endpoint, templates sync) | schedule | Change-request protocol: restate, impact, plan update, test-first |
