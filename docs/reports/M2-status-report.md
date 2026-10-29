# STATUS REPORT – M2 Accounts & sessions – 2026-10-29

**Overall: GREEN, one exit criterion deferred by your decision** — every M2 deliverable is built test-first and
green on `master` (CI runs #39–#47, all 7 jobs). The criterion "processors.md names the SMTP relay operator and
the 1Password details" is open because O-02/O-03 are open; you decided (Q-27) that M2 builds against local
stand-ins and the real services are wired before staging (M6). CI was red for six pushes mid-milestone (runs #32 and
#34–#38, see *Security & privacy*). Six proposals need your confirmation and two items need a decision before M3.

## Done

All commits are on `master` (trunk-based, ADR-0001 as amended), each test-first with a `docs/PROGRESS.md` row.

- `eebf046` docs: M2 kickoff, exact Node pin `26.12.1` (26.13.0 LTS from 2026-11-04, after the 7-day rule)
- `2530b40` feat(time): `Clock` everywhere, `FakeClock` for tests (no `Date.now()` outside `platform/time`, lint)
- `34d8d0c` feat(crypto): XChaCha20-Poly1305 AEAD with user/record/field binding, 256-bit tokens stored as SHA-256,
  email blind index (HMAC), constant-time comparison
- `aa29a7c` feat(accounts): Argon2id with a bounded queue (D-01), NFKC, 12–128 characters, offline breached-password
  filter (ADR-0012)
- `d98f160`, `ad9ad83` feat(crypto/config): KEK from 1Password Connect (production) or the environment (dev/test);
  no KEK → no start; data keys wrapped per user
- `aa8d695`, `53ddbdd` feat(db): account tables with forced RLS, a least-privilege grant matrix tested per table, CHECK
  constraints as a second line of defence, the data-inventory guard
- `838e1b6`, `331dd42`, `240da27` feat: Drizzle transactions bound to the user (RLS), field encryption with
  short-lived data keys in guarded memory (no cache, ADR-0006 amended), request validation problems
- `89d2e3c` feat(accounts): register, verify email, resend verification — uniform answers, no enumeration
- `9a2e441`, `204024f`, `c750155`, `87b2e37`, `6d5a0a6` feat(sessions): login with device sessions (20 per account,
  least recently used one logged out, Q-29), refresh rotation with reuse detection, deny-by-default guard, logout and
  logout-all, session list and revoke, re-authentication (10-minute window)
- `dfec0a9`, `9b2e285` feat(accounts): password change, forgot and reset; fix: constant-time hash comparison in the
  login race check (the CI incident)
- `8b426fe`, `429d267` feat(accounts): two-step email change (re-auth, link to the new address, notice to the old)
- `091e0c1` feat(accounts): `GET`/`PATCH /me` with ETag/If-Match (428/409 `current_version`)
- `e01c330` feat(consents): grant, list and withdraw versioned consents
- `96eb1b6` feat(rate-limit): shared PostgreSQL token buckets and progressive backoff, keyed by HMAC of the day
- `4fda479` feat(email): outbox delivery through `SmtpEmailSender` with mandatory TLS, localized plain-text templates
- `4fed249` feat(privacy): hourly retention jobs behind a shared, locked scheduler
- `e131718` test(security): traceability gaps closed (three missing tests added, stale references repointed)
- this commit — docs: this report

**Endpoints (20 new, all contract-tested):** register, verify-email, resend-verification, login, refresh, logout,
logout-all, reauth, password forgot/reset, email-change confirm; `GET`/`PATCH /me`, `/me/password`,
`/me/email-change`, `GET /me/sessions`, `DELETE /me/sessions/{id}`, `GET`/`POST /me/consents`,
`DELETE /me/consents/{type}`. Still listed as not implemented: account deletion and export (M4) and the 16 domain
operations (M3).

## Tests

- **792 automated tests**: 388 unit tests (`src/**`) and 404 integration, contract, security, privacy and
  supply-chain tests (`test/**`, real PostgreSQL 17 via Testcontainers); plus **11 e2e checks** against the built
  image and the running Compose stack. All green locally (pre-push hook) and in CI.
- **Coverage**: 99.2 % statements · 98.0 % branches · 99.8 % functions · 99.8 % lines (gate 85 %).
- **Mutation** (Stryker on `src/platform/crypto`, gate 80 %): **93.5 %** — 360 killed, 25 survived, 4 errors. Two
  files are below 80 % on their own: `password.ts` 79.3 % (11 survivors) and `field-cipher.ts` 75 % (1 of 4); to be
  raised early in M3.
- **Spec coverage**: 22 of 40 operations implemented and contract-tested; 18 listed as not yet implemented.
- **Red first and fault injection**: every task started red; after each feature I broke the code on purpose and
  checked that a test failed. M2 total: 138 deliberate faults (counted in `PROGRESS.md`), all caught except a few equivalent ones
  (e.g. dropping an explicit `user_id` filter where RLS is the second layer; `SKIP LOCKED`, which only saves
  waiting). Several probes exposed weak tests, which were strengthened before committing.

| Exit criterion (plan M2) | Evidence |
|--------------------------|----------|
| ASVS L2 authentication/session checks covered by tests | Every threat of the M2 list (S-01…S-12, E-01…E-03, E-07, E-08, E-11, E-12, I-02, I-03, I-07) points at existing tests — checked by script after `e131718`: `integration/registration`, `login`, `refresh`, `auth-guard`, `my-sessions`, `passwords`, `email-change`, `me`, `consents`; `security/enumeration`, `hashing-flood`, `rate-limit`, `reauth`, `deny-by-default`, `headers`, `log-leakage`, `limits`, `injection`; `integration/encryption-at-rest`, `smtp-sender`, `outbox-delivery`, `retention` |
| Coverage ≥ 85 % | 99.2 % / 98.0 % (statements / branches) |
| Mutation ≥ 80 % on crypto | 93.5 % (CI run #46); two files below 80 % individually (see above) |
| No personal data in captured logs | `security/log-leakage.test.ts`, a "never writes … to the log" test per flow, worker log fields allowlisted (`outbox-delivery.test.ts`); e2e: no seeded secret in any container log |
| `processors.md` names the SMTP relay operator and the 1Password details | **Deferred (Q-27)**: O-02/O-03 open; built and tested against local stand-ins (an in-process SMTP server with TLS, a Connect stub); needed before M6 |

## Security & privacy

- **Incidents and findings**
  - **CI was red for six pushes (runs #32 and #34–#38).** The custom Semgrep rule for timing-unsafe secret comparisons
    (I-10) flagged a `!==` on password hashes in the login race check. I noticed late because I did not check CI
    after each push. Fixed in `9b2e285` (`constantTimeEqual`). Since then Semgrep with the CI image runs locally
    before every push and CI is checked after every push; that routine caught a second finding (a test stand-in
    comparing a test password with `===`) before it reached `master`.
  - A load-dependent test timeout (entrypoints under parallel Argon2id) → integration timeout 20 s, no flakes since.
  - The contract documents `429` on only 18 of 40 operations, so per-user rate limits cannot apply to the others
    without an additive contract change (O-07, decision below).
  - **Traceability**: many threat-model and test-strategy rows for M1/M2 controls named test files planned in M0
    that never existed under those names. The controls were tested elsewhere, except three, for which I added tests
    (`e131718`): a raw dump of every table shows no address, nickname, device label, password or token (I-01);
    swapped ciphertexts fail closed (T-05); deep JSON nesting answers 400 (D-02); SQL meta-characters stay data
    (T-03). Two over-claims were corrected: a DEK cache that M2 removed, and a KEK "zeroed on shutdown" — the KEK is
    held in guarded (locked) memory but not explicitly zeroed when the process stops.
  - A-31 was cited before it was defined (fixed in `4fda479`).
  - **Residual risks I accept unless you object**: resend-verification and forgot-password do slightly different
    database work for known and unknown addresses (a timing difference of a few milliseconds); per-address rate
    limits (3/h) make it impractical to exploit. Emails to accounts pending deletion (A-22) are suppressed only
    once deletion exists (M4).
  - **For the app team**: never refresh twice in parallel — the second use of a refresh token counts as reuse and
    ends the session (R-AUTH-04, by design).
- **Scan results** (CI run #46 and local, 2026-10-29): Semgrep 0 findings (116 rules, 221 files) · osv-scanner 0 ·
  gitleaks 0 over the full history · Trivy 0 HIGH/CRITICAL incl. unfixed · `npm audit --omit=dev` 0 (73 production
  packages) · CycloneDX SBOMs as CI artifacts.
- **Exceptions register** (new in M2, each in the repository with its reason):
  - `@stryker-mutator/*` 10.1.1 installed 6 days after release (ADR-0016 exception, dev-only): 10.0.0 silently
    reported every mutant as survived under Vitest 5.
  - 1 × `nosemgrep` in `src/platform/crypto/kek-source.ts`: the request to the operator-configured Connect server
    (validated at startup; redirects refused).
  - `gitleaks:allow` on synthetic test passwords in `config.test.ts` (as in M1).
- **Data inventory**: M2 is the first milestone that stores personal data — email (encrypted + blind index),
  nickname and device labels (encrypted), settings, consents, audit events with truncated IP prefixes (/24, /48),
  queued emails (encrypted), tokens only as hashes. Every column is in `data-inventory.yaml`, enforced by the
  inventory guard; every retention period is enforced by an hourly job (R-PRIV-07).
- **New runtime dependencies** (R-SUP-01; 73 production packages in total, 0 known vulnerabilities):

  | Package | Version | Reason |
  |---------|---------|--------|
  | `sodium-native` | 5.2.0 | Argon2id, XChaCha20-Poly1305, constant-time compare, guarded memory (ADR-0005); brings 18 more production packages (Holepunch `bare-*` loader, `streamx` family; MIT/Apache-2.0, none with install scripts) |
  | `nodemailer` | 10.2.1 | SMTP delivery with mandatory TLS (ADR-0014, approved with Q-03); no dependencies of its own; only `platform/email/smtp-sender.ts` may import it |

- **New dev dependencies**: `smtp-server` 3.21.1 (+ `punycode.js`, `ipv6-normalize`) as the local SMTP stand-in;
  Stryker 10.1.1 (upgrade). `fast-check`, planned for M2, is not added yet — property tests come with the domain
  engine in M3. No new external service, processor or cost.

## Decisions I made

| Decision | Reason |
|----------|--------|
| No DEK cache while the KEK is local (ADR-0006 amended) | unwrapping costs microseconds; a cache only lengthens key exposure |
| Login: one Argon2id verification per attempt, also for unknown accounts (dummy hash); weak hashes upgraded at login | no timing enumeration (S-02); parameter upgrades without a migration |
| Rate-limit keys are HMAC(key of the UTC day, scope:subject); IPv6 limited per /64 | no address or email stored, days unlinkable (Q-14); a /64 is one subscriber |
| Link emails are sent only while their token still works; security notices always | precise dedupe (D-05) without relying on synchronised clocks |
| Worker without SMTP settings (development only) leaves emails queued; production requires them | the local stack has no relay; nothing is logged instead |
| Scheduled jobs share one schedule through `job_runs` and run under an advisory lock | several worker instances never run a job twice; a failing job waits for its interval |
| Retention deletes in batches of 1 000, at most 100 per run | no statement can hit the 5 s statement timeout on a backlog |

## Decisions I need from you

| ID | Question | Options | My recommendation |
|----|----------|---------|-------------------|
| A-02, A-29…A-33 | Six proposals recorded during M2 (`docs/requirements.md` §5): time-zone validation (A-02 refined), default locale `de-CH` (A-29), forgot-password also for unverified accounts, which also closes account pre-hijacking (A-30), rate-limit values (A-31), email link format with the token in the URL fragment (A-32), email copy: plain text, four languages, formal register (A-33) | confirm all · change individual ones | **confirm all** — they become accepted with your "go" unless you object |
| O-07 | The contract documents `429` on only 18 of 40 operations | document `429` on every authenticated operation (additive, non-breaking; per-user limit then applies everywhere) · keep per-user limits on 18 operations | **document `429` everywhere**, before M3 adds 16 more operations |
| O-08 | The emails' copy was written by engineering | native-speaker review of de/fr/it before launch · keep as is | **review before launch (M6)**, no M3 impact |
| O-05 / O-06 | Gamble mechanics for users aged 13–15; rank and gamble integrity rules (M0 report) | — | needed **before M3 implements ranks and gambles** |

## Scope or plan changes

- **Deferred**: `processors.md` with the named relay operator and Connect details (Q-27, before M6); suppressing
  emails to accounts pending deletion (A-22) and deleting goal content on consent withdrawal (both with M4, when
  deletion and the content tables exist); explicit zeroing of the KEK at shutdown (optional hardening, not
  promised by any requirement); `fast-check` (M3).
- **Added beyond the plan**: password-hashing back-pressure (429 when Argon2id is saturated), 20-session limit,
  per-flow log-leakage tests, a dependency rule that keeps `nodemailer` in one file, an e2e check that every
  retention job runs in the worker container, a script-checked threat-model traceability pass.
- **Effort**: planned 10–14 engineering days; all M2 commits landed on 2026-10-29.

## Next

**M3 Core domain (12–16 engineering days)** after your "go": achievements, quests, check-ins, XP and levels,
streaks, ranks and gambles, idempotency keys, ownership tests generated from the contract, `fast-check` property
tests of the domain engine (branch coverage ≥ 95 %, mutation ≥ 80 % on the domain). Before ranks and gambles are
implemented I need O-05 and O-06; before the first M3 endpoint, O-07. On or after 2026-11-04 I move the Node pin to
26.13.0 LTS (local, CI, image).

---

## Addendum 2026-10-29 — review with the PM

**Decisions** (recorded in `docs/requirements.md` §5 and §6.3):

- **"Go" for M3.** A-02 (as refined) and A-29…A-33 accepted as proposed. No objection to the residual risks above.
- **Q-30 (O-07):** `429` documented on every authenticated operation (22 more, additive, `0.2.2-draft`), so the
  per-user limit applies to all of them — done before the first M3 endpoint.
- **Q-31 (O-06):** the full rank and gamble integrity package including the optional rule — one pending gamble per
  user; a loss takes at most the XP above the current level's threshold; a win pays at most the achievement's
  required XP; lateness and Champion's deadline use the earliest `target_date` in effect during the attempt; the
  rank bonus and gamble wins only for achievements unlocked at least 7 days after their creation. R-XP-03,
  R-RANK-01…03 and R-GMB-01…03 are updated. Two engineering details are **proposed for your confirmation**: A-34
  (7 × 24 h between `created_at` and the unlock; an earlier unlock still records score, rank and badge, pays no rank
  bonus and settles a pending gamble as won with +0 XP) and A-35 (the attempt's deadline lives in a new encrypted
  column `achievements.deadline_enc` and is not an API field — exposing it would be an additive contract change if
  the app needs it).
- **Q-32 (O-05):** gambles stay available to every user ≥ 13 with the Q-31 safeguards; your product review is
  recorded in DPIA R-15 (draft v0.3).
- **O-08** (native-speaker review of the email copy) stays open until launch (M6); no M3 impact.

**Impact**: M3 effort 13–17 days (+1 for Q-30/Q-31), total 52–73. Aligned in the same commit: data model
(`gambles` unique per user, `achievements.deadline_enc`), data inventory, threat model T-16…T-18, test strategy,
ADR-0015 (amended), plan.

**Status**: M2 is **DONE** (closed with the PM's "go" for M3 on 2026-10-29).
