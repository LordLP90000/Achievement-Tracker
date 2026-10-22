# STATUS REPORT – M0 Plan – 2026-10-22

**Overall: GREEN** (on track; waiting for PM decisions before M1/M2 can be fully scoped)

## Done

- `2c1ddee` chore: repository set up on the existing GitHub remote (`LordLP90000/Achievement-Tracker`, default
  branch `master`), `docs/PROGRESS.md`, `docs/DECISIONS.md` (12 ADRs, status *proposed*), branch `m0-plan`
- `b59efdb` docs: requirements restated with IDs (R-*), 19 default assumptions (A-*), 24 open questions (Q-*)
- `639d97a` docs: architecture (modular monolith API + worker, request lifecycle, platform components, folder
  structure, 6 planned runtime dependencies)
- `92b8e7a` docs: PostgreSQL data model (18 tables, encrypted columns, RLS, roles/grants, deletion cascade, export shape)
- `9a74220` docs: OpenAPI 3.1 draft — 33 operations, RFC 9457 problems, `Idempotency-Key`/`If-Match`, cursor
  pagination; Redocly lint clean
- `a4d9321` docs: STRIDE threat model — 60+ threats → mitigation → named test; encryption scope statement;
  end-to-end-encryption evaluation for v2; residual risks; abuse cases
- `499fbfc` docs: data inventory (markdown + machine-readable YAML for the guard test), DPIA draft (14 risks),
  processors register (none approved yet)
- `2bd8cd4` docs: test strategy (layers, deterministic harness, domain test plan with Europe/Zurich DST vectors,
  requirement→test catalogue, coverage/mutation gates, CI pipeline)
- `ea5856d` docs: hosting/KMS/email options with recommendation; milestone plan with effort estimates

## Tests

n/a — M0 is documentation only (no production code, as required). Automated validation performed: OpenAPI document
linted (valid, 0 warnings); cross-reference check that every Q-ID and ADR referenced in any document is defined.
New tests: 0. Planned test catalogue: `docs/test-strategy.md` §5, threat→test mapping in the threat model.

## Security & privacy

- **New risks identified & mitigations proposed**
  - Crypto-shredding cannot make *our own* backups unreadable within the 30-day window (the wrapped DEK is in the
    backup and the KEK still exists). It does protect against leaked dumps/backups (no KMS access). Mitigation:
    tombstone replay after restores (Q-13), 30-day backup expiry, documented honestly in ADR-0006 / threat model §2.
  - Deterministic email blind index allows offline guessing by someone holding DB **and** the HMAC key → key kept
    outside the DB, rotation runbook (RR-3).
  - Minors may enter sensitive goals → minimum age / self-declaration decision needed (Q-23, DPIA R-12).
  - `target_date` is plaintext per the brief; I propose encrypting it too (Q-24).
- **Scan results**: none yet (no code). CI gates specified: lint/typecheck/tests/coverage, Semgrep, osv-scanner,
  gitleaks (+ pre-commit), Trivy, CycloneDX SBOM, commitlint.
- **Data-inventory changes**: initial inventory C1–C15; three categories pending your approval: device label
  (Q-09), deletion tombstones (Q-13), HMAC-hashed IPs for rate limiting (Q-14).

## Decisions I made (ADRs, all *proposed* until your "go")

| ADR | Decision | Reason |
|-----|----------|--------|
| 0001 | `master` kept as default branch; one branch + PR per milestone; Conventional Commits | repo created by your IDE; brief's workflow |
| 0002 | Node 26 LTS target (Active LTS from 2026-10-28), fallback 24 | longest support; dev machine runs non-LTS Node 25 |
| 0003 | Drizzle ORM; three DB roles (migrator/app/worker); Row-Level Security as defence in depth | parameterized-only queries; fail-closed ownership |
| 0004 | Opaque random tokens, SHA-256 stored, prefixed; no JWTs | exact revocation, no alg/claims pitfalls |
| 0005 | `sodium-native` for Argon2id (64 MiB/t=3/p=1), XChaCha20-Poly1305, constant-time compare | one vetted crypto dependency |
| 0006 | Envelope encryption design, AD layout, DEK cache ≤ 5 min, honest crypto-shredding scope | brief + backup reality |
| 0007 | RFC 9457 with URN problem types until a domain exists | no domain yet |
| 0008 | `Idempotency-Key` (24 h, encrypted stored response); `If-Match` ↔ `version`, 409 on conflict, 428 when missing | brief |
| 0009 | PostgreSQL for rate limiting, outbox and jobs — no Redis/queue in v1 | no new paid component; fewer attack surfaces |
| 0010 | Spec-first OpenAPI enforced by Ajv contract tests + spec coverage + Zod drift check | brief |
| 0011 | `Intl`-only timezone handling; `local_date` stored per check-in; ISO weeks | zero dependencies; DST-safe by construction |
| 0012 | Offline breached-password Bloom filter from a pinned public list | NIST + no network |

Also: I moved the local `master` pointer back to `origin/master` after my first commit accidentally landed there
(unpushed; the commit lives on `m0-plan`). Nothing was rewritten on the remote.

## Decisions I need from you

**Blocking (needed before the stated milestone)**

| ID | Question | Options | My recommendation |
|----|----------|---------|-------------------|
| Q-01 | Hosting (M1 infra, M6 deploy) | Exoscale (CH) · Scaleway (EU) · Hetzner (EU) · AWS/GCP/Azure CH regions | **Exoscale**: Swiss compute + managed PostgreSQL + KMS from one provider |
| Q-02 | KMS (M2) | provider KMS · self-hosted OpenBao Transit · Infisical | **Exoscale KMS** (encrypt/decrypt with encryption context) |
| Q-03 | Transactional email (M2) — paid processor | Infomaniak (CH) · Scaleway TEM · Brevo · Mailjet | **Infomaniak** |
| Q-04 | Habit semantics (M3): with the brief's formula over a fixed window, one missed occurrence makes a quest impossible to complete | strict window · **open-ended periods** · 90 % threshold | **open-ended** (keeps formula and per-period cap; a miss only delays) |
| Q-05 | Level curve & unlock bonus (M3) | quadratic `50·L·(L−1)` or linear · bonus 50 % of required XP or flat 100 | **quadratic + proportional bonus** (prevents XP farming) |
| Q-09 | Store a user-chosen, encrypted device label for the session list? (M2) | yes · platform enum only | **yes** |
| Q-10 | Effect of withdrawing goal-content consent (M2/M4) | **delete all goal content, keep account** · delete account · keep but block (non-compliant) | **delete content** |
| Q-11 | Account deletion timing (M4) | **immediate** · 14-day grace | **immediate** (more private) |
| Q-12 | Deleting an achievement/quest revokes its XP? (M3) | **revoke** · keep | **revoke** |
| Q-13 | Keep deletion tombstones (random UUID + time, 35 d) for post-restore replay? (M4) | **yes** · manual runbook only | **yes** |
| Q-14 | Store HMAC-hashed IPs (daily key, 24 h) for rate limiting? (M2) | **yes** · edge-only | **yes** |
| Q-23 | Minors / minimum age (M2) | **≥ 16 self-declared, no DOB stored** · collect DOB · none | **≥ 16 self-declared** |

**Confirm or change (defaults applied otherwise):** Q-06 min password 12 (or 15), Q-07 lifetimes
15 min / 30 d sliding / 180 d absolute / 10 min re-auth, Q-08 back-dating 7 days, Q-15 verified email required for
login, Q-16 limits (A-09), Q-17 status transitions, Q-18 ISO weeks (Monday), Q-19 domain for URIs, Q-20 Node 26,
Q-21 RLS, Q-22 keep `.idea/` tracked and `master`, Q-24 encrypt `target_date` (I will, unless you object).

## Scope or plan changes

- None to the brief. Added, for your approval, three small data categories (Q-09, Q-13, Q-14) and one product
  clarification that changes behaviour (Q-04).
- The OpenAPI draft adds endpoints implied by the brief but not named in it: `POST /auth/reauth`,
  `POST /auth/resend-verification`, two-step email change, `GET /me/sessions`, consents, `GET /me/stats`,
  `DELETE /check-ins/{id}` returning the resulting state. Please object if any of these should not exist.

## Next

**M1 Walking skeleton (4–6 engineering days)**: repo tooling (Node 26, TS strict, ESLint, Prettier, Vitest,
Testcontainers), `buildApp()` with request IDs, allowlist logging, security headers, problem details, health
endpoints; config module with secret-strength checks; Drizzle + first migration (roles, RLS helpers); Testcontainers
+ contract-test harness; Dockerfile (non-root, read-only) + Compose; CI with all gates (lint, typecheck, tests,
coverage, Semgrep, osv-scanner, gitleaks, Trivy, SBOM, commitlint). Needs only your "go" plus Q-20/Q-21/Q-22; it
does not depend on the hosting choice. Q-02/Q-03 are needed when M2 starts.

Housekeeping notes: no `gh` CLI on this machine, so the PR must be opened from the compare link I provide (the
report above is the PR description). Your global git identity shows as `'Laurent` (leading apostrophe) — you may
want to fix `git config --global user.name`.

---

## Addendum 2026-10-22 (afternoon) — PM decisions received

All 24 questions were answered (see `docs/requirements.md` §6 for the full list). Changes versus the brief,
restated as the change-request protocol requires:

1. **Habit misses reset the quest** to 0 % and require the user to restart it (history kept) — replaces the
   Σ min(…) formula and the "freeze on pause" rule.
2. **Pause = reset** (new attempt, XP of the attempt revoked, pending gamble lost); **no manual archiving**;
   completed achievements are the read-only, non-deletable archive.
3. **Back-dated check-ins never count** (history only).
4. **Ranks** Bronze→Champion from a server-computed execution score (Diamond = 100 %, Champion = 100 % + flawless
   incl. no lost gamble), **rank bonus ×0.5 … ×365**, **level curve ×3 per level**, **duration factor** for habits
   by span in days, **gambles** (stake = current-level XP, double or nothing, settled on target date / reset /
   pause / delete). Reward currency/coupons → v2.
5. **Deletion with 30-day reactivation**, **week-start setting**, **min age 13 self-declared**, **encrypted
   target_date**, 12-char passwords, lifetimes as recommended, device label / tombstones / hashed IPs approved.
6. **Infrastructure**: hosting = PM's own option (later); **KEK from a self-hosted 1Password Connect server**
   (residual risk accepted: KEK in app memory); **email via custom SMTP** (`nodemailer`; relay operator to be
   named — Google would be a US processor).

**Impact**: data model + ADRs updated (committed); OpenAPI, `data-inventory.yaml` and test catalogue to be updated
in the next session before M1 starts; effort now **51–72 days** (+7–10, mostly M3). Open items O-01…O-05 in
`docs/requirements.md` §7 — O-05 is a recommendation to review gambling-like mechanics for 13–15-year-olds before M3.

**Still needed from you**: the "go" for M1 (nothing in M1 depends on the open items).
