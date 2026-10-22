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

---

## Final addendum 2026-10-22 (evening) — remaining M0 tasks done

**Overall: GREEN for M1** (nothing open blocks it) · **AMBER for M3** (O-06 needs your decision before ranks and
gambles are implemented).

### Done

- `56a43d1` OpenAPI v2 (`0.2.0-draft`, 40 operations): statuses `active|paused|completed` (client may request
  `active|paused`; completed = read-only, not deletable → `409 achievement-completed`); achievement `attempt`,
  `rank`, `execution_score`; quest `needs_restart`, integer `xp`, `duration_factor`, `reset_count`; check-in
  `attempt`, `counts_for_progress`; `placeGamble` + `listGambles`; `Effects` with rank, score and gamble outcome;
  `Stats` with completed-by-rank and gamble record; `age_confirmed` (const `true`); `week_start`;
  `DELETE /me` → `202 {deletion_scheduled_for}` with reactivation by login.
- `39b014f` `data-inventory.yaml` v2 (+ `data-inventory.md` C3/C6/C7).
- `276ecc4` test strategy v2: 23 new and 3 updated catalogue rows; domain plan for habit resets, `week_start`
  periods, duration-factor table, score/rank, gambles across the Zurich DST dates.
- `843e223` architecture v2: 1Password Connect `KekSource`, SMTP relay, domain files `constants`, `habit-reset`,
  `duration`, `rank`, `gamble`; runtime dependency `nodemailer`.
- Commit `docs(m0): cross-reference check and decision-consistency sweep`: restored requirement definitions,
  aligned threat model, DPIA, data inventory, data model, ADR-0006/0012 and plan with your decisions, this addendum.

### Tests

n/a — documentation only. Automated checks (scratch scripts, not committed): Redocly lint valid with 0 warnings;
Ajv 2020 strict validation of 42 sample payloads (incl. negative cases) against the v2 schemas; inventory YAML vs
data model: 18 tables, 175 columns, 0 differences; cross-reference check: every ID referenced in the 16 docs/spec
files (≈ 1 300 references) is defined. I propose turning these into M1 tests (contract semantics, traceability,
data-inventory guard preview).

### Pre-existing defects found and fixed

1. `CheckInResult` / `AchievementDetail` combined `allOf` with `additionalProperties: false`, so no valid response
   could ever pass the planned contract tests → `*Base` schemas + `unevaluatedProperties: false` (verified).
2. `data-inventory.yaml`: unquoted commas inside YAML flow mappings created bogus keys.
3. Requirements v2 had dropped the definitions of R-LOG-01…03 and R-SUP-01…05 (still referenced in 7 files) and
   condensed R-TLS-01…04 → restored from v1; R-SUP-04 adapted to ADR-0013 (production refuses an env-supplied KEK).
4. My earlier log and report said the v1 spec had 33 operations — it had 38.
5. Password length was `422` in the test strategy but `400` in the spec → `400` (schema) for length, `422` only for
   breached passwords; `register` now documents its `422`.
6. Threat model, DPIA, data inventory, data model, ADR-0006/0012 and plan still described a KMS, a plaintext
   `target_date`, immediate deletion and Q-23 as open → aligned.

### Security & privacy

- **New risk — O-06, integrity of ranks and gambles** (details in `docs/requirements.md` §7): (a) the same XP can be
  staked on many achievements at once; (b) "−stake" can lower the level or push XP below 0, contradicting
  R-XP-03/04; (c) wins compound — a simulation of trivial "Champion + gamble" achievements exceeds the 2^53 bound of
  R-XP-04 after 102 rounds, inside the 200-achievement limit; (d) a one-quest achievement unlocked the same day is
  flawless → Champion bonus 10 × 365 = 3 650 XP (200 of them reach level 10 without any gamble); (e) moving or
  removing `target_date` avoids the lateness penalty and Champion's deadline.
- **Re-rated — DPIA R-12 = 6 medium**: a self-declared 13–15-year-old may not consent validly alone in EU states
  whose age of digital consent is 14–16 (GDPR Art. 8) → DP-expert review together with O-04.
- **Interim secure defaults in the contract** (proposed, you may object): A-26 no `target_date` change while a
  gamble is pending; A-27 no new gamble after a loss in the same attempt (T-16); A-28 habit `start_date` not in
  the past.
- Scans: none (no code). Data-inventory changes: `data-inventory.md` §7.

### Decisions I made

| Decision | Reason |
|----------|--------|
| A-26, A-27, A-28 (interim, proposed) | close manipulation paths T-16/T-17; a past start date could never be met |
| Reads may apply lazy habit resets and gamble losses (documented in the contract conventions) | A-21 |
| `listGambles` uses cursor pagination | gamble history per achievement is unbounded |
| `PATCH`/`DELETE` of a completed achievement and mutations of its quests → `409 achievement-completed` | R-ACH-07, R-QST-07 |
| Gamble placement accepts no body fields | stake is server-side (T-17) |
| R-SUP-04: production refuses an env-supplied KEK | keeps v1's "no dev crypto in production" under ADR-0013 |

### Decisions I need from you

| ID | Question | Options | My recommendation |
|----|----------|---------|-------------------|
| M1 | "go" for M1 on `m1-walking-skeleton` | go · hold | go |
| PR | Merge `m0-plan` into `master` | you on GitHub · me locally (`--no-ff`) and push | either; asked separately |
| O-06 | Rank/gamble integrity (before M3) | recommended package · point by point · keep the rules and add only an XP cap | **package**: one pending gamble per user; loss = min(stake, XP above the current level's threshold); payout capped at the achievement's required XP; lateness and Champion deadline measured against the earliest `target_date` set in the attempt; optional — gamble wins and rank bonus only if the achievement existed ≥ 7 days before its unlock |
| O-01…O-05 | unchanged | | |

### Scope or plan changes

- Contract additions beyond your list, all derived from approved requirements or threats: `409 achievement-completed`
  on achievement `PATCH` and quest mutations, `409 gamble-pending` on `target_date` edits (A-26),
  `409 gamble-lost-this-attempt` (A-27), `409 quest-needs-restart`, `422` for a past habit `start_date` (A-28),
  `422` for a breached password on `register`. Please object if any of these should not exist.
- Effort unchanged at 51–72 days; O-06 may add about 0.5–1 day to M3 depending on the option.
- Dependencies: runtime `nodemailer` (M2, ADR-0014, approved with Q-03); planned dev dependency `smtp-server`
  (M2, local SMTP test server, to confirm then). No new external service or processor.

### Next

**M1 Walking skeleton (4–6 days)** on `m1-walking-skeleton` after your "go": tooling pinned to Node 26 LTS
(`.nvmrc`, `engines`), `buildApp()` with request IDs, allowlist logging, security headers, problem details and
health endpoints; Zod config module with secret-strength and `KEK_SOURCE` production guards; Drizzle + migration
0001 (roles, RLS helpers); Testcontainers + contract harness (Ajv 2020 strict); Dockerfile + Compose; CI with all
gates. The PR description for `m0-plan` is this report; compare link:
https://github.com/LordLP90000/Achievement-Tracker/pull/new/m0-plan
