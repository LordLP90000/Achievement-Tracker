# Requirements, assumptions and decisions

Status: M0 **v2** (2026-10-22) — updated with the PM's answers to all open questions (Q-01…Q-24, §6). Requirement IDs
(`R-…`) are referenced by the threat model, the test strategy and test names. Assumptions (`A-…`) are defaults the
PM has not objected to. Where a PM decision changed the original brief, the row is marked **[PM 2026-10-22]**.
Later on 2026-10-22: R-TLS/R-LOG/R-SUP rows restored from v1 (R-SUP-04 adapted to ADR-0013), A-26…A-28 proposed,
open item O-06 added.

## 1. Product summary

Questline is a mobile app. Users set an **Achievement** (a big goal), break it into **Quests** (smaller goals) and
record **Check-ins**. Completing quests earns **XP**; an achievement is **unlocked** when all its required quests
are completed, receives a **rank** (Bronze … Champion) based on how flawlessly it was executed, and pays a rank bonus.
Users may **gamble** their current-level XP on finishing an achievement by its target date. The backend is a
REST/JSON API under `/v1` used only by the mobile app.

Vocabulary used verbatim in code, API and docs: `Achievement`, `Quest`, `Check-in` (`check_in` in identifiers),
`XP`, `level`, `streak`, `badge`, `rank`, `gamble`, `attempt`, quest types `one_time | habit | target`, sizes
`S | M | L`, achievement statuses `active | paused | completed`, ranks
`bronze | silver | gold | platinum | emerald | diamond | champion`.

## 2. Functional requirements

### 2.1 Achievements

| ID | Requirement |
|----|-------------|
| R-ACH-01 | An achievement has: `title`, `description`, `motivation` ("why"), `category`, optional `target_date`, `status` (`active`, `paused`, `completed`), `is_private` (display hint), `attempt` (1-based counter of restarts), and — once completed — `rank` and `execution_score`. |
| R-ACH-02 | `title`, `description`, `motivation`, `category` **and `target_date`** are encrypted at the application level (R-ENC-*). **[PM 2026-10-22, Q-24]** |
| R-ACH-03 | Achievement progress = XP-weighted average of the progress of its **required** quests: `Σ(progress_i · xp_i) / Σ(xp_i)` (xp_i = base size XP × duration factor, R-XP-02). |
| R-ACH-04 | An achievement is unlocked when all required quests are completed: status → `completed`, `completed_at` set, execution score and rank computed (R-RANK-*), rank badge awarded, rank bonus XP granted, pending gamble settled as won if on/before `target_date`. Bonus quests give XP but never block unlocking. |
| R-ACH-05 | Undoing a check-in that makes a required quest incomplete again reverses the unlock: status back to `active`, rank/score/badge removed, rank bonus revoked, a gamble settled by that unlock is reverted to pending. (Possible only for check-ins made "today", see R-CHK-04.) |
| R-ACH-06 | **Pausing resets the achievement** **[PM 2026-10-22, Q-17]**: all quests return to 0 % (new attempt), XP earned through the achievement in the current attempt is revoked (prevents farming), a pending gamble is lost, check-ins are kept as history only (`counts_for_progress = false`). Resuming (`paused → active`) starts attempt `n + 1`. The brief's "pausing freezes streaks" is superseded. |
| R-ACH-07 | Client-requestable transitions: `active → paused`, `paused → active` only. `completed` is set only by the system. There is **no manual archiving**; completed achievements are the user's archive: read-only and **not deletable** **[PM 2026-10-22, Q-17]**. |
| R-ACH-08 | Achievements are listed with cursor pagination, filterable by `status`. |
| R-ACH-09 | Deleting an `active`/`paused` achievement deletes its quests and check-ins and revokes all XP earned through it **[PM 2026-10-22, Q-12]**; a pending gamble is lost (stake removed). |

### 2.2 Quests

| ID | Requirement |
|----|-------------|
| R-QST-01 | A quest belongs to exactly one achievement, has a `position`, is `required` or `bonus`, and has a `size` `S/M/L` worth base `10/25/50` XP. Effective `xp` = base × duration factor (R-XP-02). |
| R-QST-02 | A quest may name one `prerequisite_quest_id` of the **same** achievement; it is `locked` until the prerequisite is completed. No cycles. |
| R-QST-03 | Type `one_time`: completed by a single counting check-in; progress 0 or 1. |
| R-QST-04 | Type `habit`: `times_per_period` N, `period` `day|week`, `period_count` K, `start_date`. Progress = (consecutive fully-met periods since the attempt's start) / K; a period is met when it has ≥ N counting check-ins. **A closed period with < N counting check-ins resets the quest** **[PM 2026-10-22, Q-04]**: progress → 0, state → `needs_restart` (no check-ins accepted), `reset_count + 1`. The user restarts by editing the quest (new `start_date` ≥ today, optionally new N/K); earlier check-ins remain visible as history and do not count. Completed when K consecutive periods are met. |
| R-QST-05 | Type `target`: `start_value`, `target_value` (≠ start), optional `unit`; increasing or decreasing. Progress = `clamp((current − start) / (target − start), 0, 1)`, `current` = value of the latest counting check-in (by `local_date`, then `created_at`); none ⇒ `start`. Completed when progress = 1. |
| R-QST-06 | `title`, `notes`, `unit`, `start_value`, `target_value` are encrypted at the application level. |
| R-QST-07 | Quests can be edited (title, notes, position, required flag, size, prerequisite, type-specific parameters); `type` is immutable. Progress/XP are recomputed; XP follows R-XP-*. Quests of a `completed` achievement are read-only. |
| R-QST-08 | Deleting a quest deletes its check-ins, revokes XP earned through it and clears `prerequisite_quest_id` on quests that referenced it. |
| R-QST-09 | Week-based periods start on the user's configured `week_start` (`monday | sunday | saturday`, default `monday`) **[PM 2026-10-22, Q-18]**. Changing `week_start` applies to periods that start after the change. |

### 2.3 Check-ins

| ID | Requirement |
|----|-------------|
| R-CHK-01 | A check-in records progress for a quest: one occurrence (one_time/habit) or a numeric `value` (target); optional `note`; `local_date` in the user's timezone. |
| R-CHK-02 | `value` and `note` are encrypted at the application level. |
| R-CHK-03 | Undo = delete the check-in and reverse **all** its effects (progress, completion, XP, streak, rank, gamble). Check-ins are otherwise immutable. |
| R-CHK-04 | `local_date` must not be in the future and may be back-dated at most 7 days. **Only check-ins dated "today" (account timezone, at creation time) count** toward progress, streaks, XP and resets; back-dated ones are stored as history with `counts_for_progress = false` **[PM 2026-10-22, Q-08]**. |
| R-CHK-05 | Check-ins are rejected (409) on a `locked` or `needs_restart` quest, on quests of a `paused`/`completed` achievement, and (422) with a `value` on non-target quests or without one on target quests. |
| R-CHK-06 | Creating a check-in returns the check-in, the updated quest and achievement, XP awarded and any rank/gamble/unlock events (no second round trip). |

### 2.4 XP, levels, duration factor

| ID | Requirement |
|----|-------------|
| R-XP-01 | XP is awarded exactly once per quest completion / unlock / rank / gamble settlement (idempotent under retries and concurrency), and revoked on undo, pause-reset, deletion. All changes are in an append-only ledger with a user-local date. |
| R-XP-02 | **Duration factor** (habit quests only, from structure not from user claims) **[PM 2026-10-22, Q-05g/h]**: span in days = `period_count` (daily) or `period_count × 7` (weekly); factor ×1 for ≤ 28 days, ×1.5 for 29–56, ×2 for 57–112, ×3 for ≥ 113. `xp = round(base × factor)`. |
| R-XP-03 | **Level curve** **[PM 2026-10-22, Q-05e]**: XP required to reach level L is `100 × 3^(L−2)` for L ≥ 2 (L2 = 100, L3 = 300, L4 = 900, L5 = 2 700, L10 = 656 100); level 1 at 0 XP. Level is derived from total XP (which can decrease through gambles — a lost gamble removes exactly the XP above the current level's threshold, so the level itself never drops). |
| R-XP-04 | Total XP never goes below 0 and is stored/handled as a 64-bit integer. |

### 2.5 Execution score and ranks **[PM 2026-10-22, Q-05c…f]**

| ID | Requirement |
|----|-------------|
| R-RANK-01 | On unlock, the **execution score** (0–100) of the current attempt is computed from non-gameable signals only: (a) quest execution = XP-weighted mean over required quests of `100 / (1 + reset_count_in_attempt)` for habits and 100 for one_time/target; (b) lateness: if `target_date` is set and unlock is after it, multiply by `max(0, 1 − days_late / 30)`; (c) each gamble lost on this achievement (any attempt) subtracts 10 points. Clamp 0–100. |
| R-RANK-02 | Ranks by score: Bronze ≥ 55, Silver ≥ 65, Gold ≥ 75, Platinum ≥ 85, Emerald ≥ 92, **Diamond = 100**, **Champion = 100 and flawless**: `attempt = 1` (never paused/reset), no habit reset in the attempt, no gamble ever lost on this achievement, every bonus quest also completed, and on/before `target_date` if set. Score < 55 → unlocked but `unranked`. |
| R-RANK-03 | **Rank bonus** = `round(Σ required quest xp × multiplier)` with multipliers Bronze ×0.5, Silver ×1.5, Gold ×4.5, Platinum ×13.5, Emerald ×40, Diamond ×120, Champion ×365; unranked → 0. Recorded as an XP event `rank_bonus` and a badge of kind `achievement_rank` with the rank. |
| R-RANK-04 | Rank, score and badge are reverted if the unlock is undone (R-ACH-05). |
| R-RANK-05 | A spendable reward currency ("coupons") is **out of scope for v1**; the ledger design (per-rank events) allows adding it later without migration of history. |

### 2.6 Gambles **[PM 2026-10-22, Q-05i]**

| ID | Requirement |
|----|-------------|
| R-GMB-01 | A user may place **one** pending gamble per `active` achievement that has a `target_date` in the future. Stake = XP above the current level's threshold at placement time (must be > 0). The stake is locked (recorded) but not removed. |
| R-GMB-02 | **Win**: the achievement is unlocked on/before `target_date` → XP event `gamble_won` of `+stake` (double or nothing), status `won`. |
| R-GMB-03 | **Loss**: `target_date` passes without unlock (settled by the daily retention job in the user's timezone), or a habit quest of the achievement resets, or the achievement is paused or deleted → XP event `gamble_lost` of `−stake`, status `lost`. Quest progress is never affected by a loss. |
| R-GMB-04 | A gamble cannot be cancelled. Losses count against Champion eligibility and the execution score (R-RANK-01/02). |
| R-GMB-05 | Gambles are XP-only mechanics (no money, no purchases). |

### 2.7 Streaks and stats

| ID | Requirement |
|----|-------------|
| R-STR-01 | Streak = number of consecutive met periods in the current attempt ending with the latest closed or the current period (the open period never breaks it), in the user's timezone and `week_start`. Because a missed period resets the quest, the current streak equals the met-period count of the attempt; the **best streak** across attempts is tracked for stats. |
| R-STR-02 | Streaks and period boundaries are correct across midnight and DST; mandatory vectors: `Europe/Zurich` 2026-03-29 and 2026-10-25. |
| R-STA-01 | Stats endpoint: XP over time (per local day), total XP and level, completed achievements by rank, badges, best streaks, gamble record (won/lost counts). |

### 2.8 Out of scope for the backend in v1

Reminders/push, achievement templates, file uploads, admin endpoints, web client (CORS off), passkeys/TOTP (M5),
end-to-end encryption (v2 evaluation), reward currency/coupons (v2).

## 3. Security requirements (ASVS 5.0 L2 + OWASP API Security Top 10)

### 3.1 Authentication & sessions

| ID | Requirement |
|----|-------------|
| R-AUTH-01 | v1: email + password. M5 adds passkeys (WebAuthn) and optional TOTP 2FA. |
| R-AUTH-02 | Argon2id ≥ OWASP parameters (ADR-0005). Policy per NIST SP 800-63B: **12–128 chars** **[PM, Q-06]**, no composition rules, no forced rotation, offline block-list (ADR-0012), no truncation, Unicode NFKC. |
| R-AUTH-03 | Email verification and password reset: single-use tokens, ≤ 30 min, stored only as hashes. |
| R-AUTH-04 | Access tokens opaque, ≤ 15 min. Refresh tokens rotate on every use, bound to a device session, hashed; reuse of a rotated token revokes the whole session. |
| R-AUTH-05 | Users list and revoke sessions. Password change revokes all other sessions; password reset revokes all. |
| R-AUTH-06 | Email change, password change, export, deletion request require re-authentication within **10 min** **[PM, Q-07]**. |
| R-AUTH-07 | No account enumeration across register, login, resend-verification, forgot-password, email-change. |
| R-AUTH-08 | Rate limiting with progressive backoff on auth endpoints (per account via email blind index, per IP via daily-keyed HMAC **[PM, Q-14]**); per-user limits elsewhere. `429` + `Retry-After`. |
| R-AUTH-09 | Login only after email verification **[PM, Q-15]**; unverified accounts purged after 7 days. |
| R-AUTH-10 | Session lifetimes **[PM, Q-07]**: access 15 min, refresh 30 days sliding, absolute 180 days. |
| R-AUTH-11 | Registration requires `age_confirmed = true` (self-declaration of **≥ 13**, parental consent handled by the terms) **[PM, Q-23]**; no date of birth is stored. |

### 3.2 Authorization

| ID | Requirement |
|----|-------------|
| R-AUTHZ-01 | Deny by default: every endpoint except health and the public auth endpoints requires a valid access token. |
| R-AUTHZ-02 | Every query is scoped to the authenticated user; foreign objects → `404`. RLS as second layer **[PM, Q-21]**. |
| R-AUTHZ-03 | For every endpoint an automated test proves user A cannot read/change/delete user B's data. |
| R-AUTHZ-04 | Strict allowlisted schemas; owner, XP, rank, score, attempt, status `completed`, gamble outcomes, completion flags and timestamps never come from the client. |

### 3.3 Input, output & transport

| ID | Requirement |
|----|-------------|
| R-IN-01 | Validate everything; body ≤ 64 KiB; limits **[PM, Q-16]**: ≤ 200 achievements/user, ≤ 50 quests/achievement, ≤ 50 check-ins/quest/day, ≤ 20 sessions; page size default 20, max 100; cursor pagination. |
| R-IN-02 | No string-built SQL; no server-side requests to user-supplied URLs. |
| R-OUT-01 | RFC 9457 problems, URN types until a domain exists **[PM, Q-19]**, no internals. |
| R-OUT-02 | Random UUID v4 IDs only. |
| R-OUT-03 | `Idempotency-Key` on create endpoints (incl. gamble placement); `version` + `If-Match`, `409` on conflict. |
| R-TLS-01 | TLS only (1.2+, prefer 1.3) at the edge; HSTS (`max-age=63072000; includeSubDomains; preload`) and security headers (`X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Permissions-Policy` minimal, `Cross-Origin-Resource-Policy: same-origin`). |
| R-TLS-02 | `Cache-Control: no-store` (+ `Pragma: no-cache`) on every authenticated response. |
| R-TLS-03 | CORS disabled (no `Access-Control-Allow-Origin` ever) unless the PM approves a web client. |
| R-TLS-04 | Constant-time comparison for all secrets and tokens. |

### 3.4 Encryption & data at rest

| ID | Requirement |
|----|-------------|
| R-ENC-01 | Envelope encryption: one DEK per user wrapped by the KEK; AEAD XChaCha20-Poly1305 with AD = user ID + record ID + field; key version stored (ADR-0006). |
| R-ENC-02 | Email encrypted + HMAC blind index (separate key). |
| R-ENC-03 | Encrypted disks and backups; private DB; app role without DDL; migrations by a separate role. |
| R-ENC-04 | Threat model states the protection scope; E2E evaluated for v2. |
| R-ENC-05 | **KEK source in production: 1Password Connect server (self-hosted)** **[PM, Q-02]**: the API fetches the KEK at startup over the local Connect API, holds it only in guarded memory, and refuses to start without it. Dev/test use a local env secret. Residual risk: a compromised app process holds the KEK (ADR-0013). |

### 3.5 Logging & monitoring

Unchanged from v1 (restored verbatim on 2026-10-22 after the cross-reference check found them missing from v2).

| ID | Requirement |
|----|-------------|
| R-LOG-01 | Structured JSON logs with request IDs. |
| R-LOG-02 | Never log passwords, tokens, emails, goal content or request bodies. A test captures all logs emitted during the whole test run and fails if any seeded secret or personal value appears. |
| R-LOG-03 | Security audit events (login success/failure, password/email change, session revocation, export, deletion, consent changes) with minimal data; retention 90 days. |

### 3.6 Supply chain

Unchanged from v1 except R-SUP-04, adapted to ADR-0013. SMTP credentials and the Connect token are secrets under R-SUP-04.

| ID | Requirement |
|----|-------------|
| R-SUP-01 | Lockfile committed; minimal dependencies; every new runtime dependency is listed with a reason in the next report. |
| R-SUP-02 | CI fails on lint, typecheck, test or coverage failures; SAST findings (Semgrep); high/critical vulnerable dependencies (osv-scanner); committed secrets (gitleaks, also pre-commit); high/critical container findings (Trivy). SBOM (CycloneDX) generated per build. |
| R-SUP-03 | Containers: minimal base image, non-root, read-only filesystem, no secrets inside. |
| R-SUP-04 | Config via environment; the app refuses to start if a required secret is missing or too weak; production refuses a KEK supplied via environment — it must come from 1Password Connect (R-ENC-05; v1: "refuses the local key wrapper", which ADR-0013 now uses in production with the Connect-sourced KEK). |
| R-SUP-05 | Synthetic seed data only in dev and test. |

## 4. Privacy requirements (Swiss FADP + GDPR)

| ID | Requirement |
|----|-------------|
| R-PRIV-01 | Data minimisation: account = email + password hash + settings (timezone, locale, `week_start`) + optional nickname + age confirmation flag. |
| R-PRIV-02 | No third-party analytics, trackers, ad SDKs, crash reporters. |
| R-PRIV-03 | Every processor needs PM approval and an entry in `docs/privacy/processors.md`. Approved so far **[PM, Q-02/Q-03]**: 1Password (Connect, security service — holds the KEK, no personal data), SMTP relay operator (to be named; email addresses + one-time links). Hosting: PM's own option, to be documented. |
| R-PRIV-04 | Explicit, unticked, versioned consent for goal content; withdrawal **hard-deletes all goal content immediately, account stays** **[PM, Q-10]**. |
| R-PRIV-05 | `GET /v1/me/export` — complete JSON, re-auth, 2/24 h, audit-logged. |
| R-PRIV-06 | **Account deletion with a 30-day reactivation window** **[PM, Q-11]**: the request (re-auth) revokes all sessions and deactivates the account; logging in with the password within 30 days reactivates it; after 30 days the retention job hard-deletes all rows and destroys the wrapped DEK (crypto-shredding) and writes a tombstone **[PM, Q-13]**. |
| R-PRIV-07 | Inventory with retention: audit 90 d, hashed-IP rate-limit rows 24 h, idempotency 24 h, backups 30 d, unverified accounts 7 d, deactivated accounts 30 d, tombstones 35 d. |
| R-PRIV-08 | Data-inventory guard test. |
| R-PRIV-09 | DPIA maintained; gambling-like mechanics with users ≥ 13 are assessed (DPIA R-15). |

## 5. Assumptions (not objected to by the PM)

| ID | Assumption |
|----|-----------|
| A-01 | Nickname optional, 1–40 chars, encrypted. |
| A-02 | Timezone validated against `Intl.supportedValuesOf('timeZone')`, default `Europe/Zurich`; locale from an allowlist. |
| A-03 | Habit check-ins are count-based; several per day allowed. |
| A-04 | *(superseded by R-QST-09)* |
| A-05 | Target values: decimals ≤ 3 fractional digits, |value| ≤ 10⁹; `start = target` is invalid. |
| A-06 | Badges: one `achievement_rank` badge per completed achievement (carries the rank). |
| A-07 | Re-auth window 10 min (confirmed Q-07). |
| A-08 | *(superseded by R-CHK-04)* |
| A-09 | Field limits as in R-IN-01 (confirmed Q-16). |
| A-10 | Session lifetimes (confirmed Q-07). |
| A-11 | Export synchronous, 2 per 24 h. |
| A-12 | Email change: verify new address, notify old, uniform responses. |
| A-13 | XP ledger entries carry the user's local date. |
| A-14 | Registration stores accepted `privacy_policy_version` and `age_confirmed`; goal-content consent is given later in-app. |
| A-15 | Idempotency records 24 h, encrypted. |
| A-16 | Prerequisite chains ≤ depth 20. |
| A-17 | Achievements without required quests have progress 0 and cannot be unlocked. |
| A-18 | Health endpoints unauthenticated, `{status}` only, outside `/v1`. |
| A-19 | Emails contain no goal content; links use a base URL from config. |
| A-20 | **Gamble settlement for a missed `target_date`** runs daily after local midnight in the user's timezone; an unlock on the target date itself counts as on time. |
| A-21 | **Habit period closing** is evaluated lazily on read/write and by the daily job, so a reset is detected even if the user does not open the app (needed for gamble losses). |
| A-22 | **Deactivated accounts** (pending deletion) cannot use any endpoint except login (which reactivates after password check and re-verifies nothing else); their emails are not sent; their data is excluded from nothing (it is simply retained encrypted). |
| A-23 | `week_start` change does not retroactively re-bucket already closed periods. |
| A-24 | The PM's own hosting must satisfy H-1…H-7 in `docs/hosting-options.md`; until named, deployment artefacts stay provider-neutral (Docker image + Compose). |
| A-25 | SMTP sender uses `nodemailer` with TLS required (STARTTLS or implicit TLS), credentials from 1Password/env, per-account send limit 3/h, outbox dedupe. |
| A-26 | **[proposed 2026-10-22, PM may object]** While a gamble is pending, the achievement's `target_date` cannot be changed or removed (`409 gamble-pending`); otherwise a loss could be avoided by moving the date (T-17). |
| A-27 | **[proposed 2026-10-22, PM may object]** After a lost gamble, no new gamble can be placed on the same achievement in the same attempt (`409 gamble-lost-this-attempt`, T-16). |
| A-28 | **[proposed 2026-10-22, PM may object]** A habit `start_date` (on creation and on restart) must be today or later (`422`): a period before today could never be met because back-dated check-ins never count (R-CHK-04). |

## 6. Decisions taken by the PM (2026-10-22)

| ID | Decision |
|----|----------|
| Q-01 | Hosting: PM's **own hosting option**, to be added later. Nothing in M1 depends on it; it must meet H-1…H-7. |
| Q-02 | KEK via **1Password Connect server (self-hosted)**; app fetches the KEK at startup (ADR-0013). |
| Q-03 | Email via **custom SMTP** (relay to be documented; Gmail/Google Workspace SMTP with DNS on Cloudflare mentioned) → ADR-0014. |
| Q-04 | Habit: **missed period resets the quest to 0 %**, user restarts by redefining it; earlier check-ins kept as history. |
| Q-05 | No self-declared difficulty. **Duration factor** by habit span (R-XP-02); **ranks** Bronze…Champion with multipliers ×0.5 … ×365 (×3 per rank); **level curve ×3 per level**; Diamond = 100 %, Champion = 100 % + flawless (incl. no lost gamble); **gambles** on achievements with the current-level XP as stake, double or nothing (R-GMB-*); coupons/currency deferred to v2. |
| Q-06 | Password minimum **12** characters. |
| Q-07 | Access 15 min · refresh 30 d sliding · absolute 180 d · re-auth 10 min. |
| Q-08 | Back-dating up to 7 days allowed, **but back-dated check-ins never count** toward progress. |
| Q-09 | Device label: **yes** (encrypted, ≤ 64 chars). |
| Q-10 | Consent withdrawal: **hard-delete goal content, keep account**. |
| Q-11 | Deletion: **30-day reactivation window**, then hard delete. |
| Q-12 | Deleting achievements/quests **revokes** their XP. |
| Q-13 | Tombstones: **yes** (35 days). |
| Q-14 | Hashed IPs for rate limiting: **yes** (24 h). |
| Q-15 | Email verification **required before login**. |
| Q-16 | Limits: **defaults accepted**. |
| Q-17 | Status model: `active ↔ paused` (pause = reset), `completed` set by the system, read-only, not deletable; **no manual archiving**. |
| Q-18 | Week start **user-selectable** (Monday/Sunday/Saturday). |
| Q-19 | No domain yet → URNs and placeholders. |
| Q-20 | **Node 26 LTS**. |
| Q-21 | **RLS enabled**. |
| Q-22 | Keep `.idea/` tracked and `master`. |
| Q-23 | Minimum age **13**, self-declared, no DOB. |
| Q-24 | **Encrypt `target_date`**. |

## 7. Open items (non-blocking)

| ID | Item | Needed by |
|----|------|-----------|
| O-01 | Name of the hosting option and its database/backup/TLS/secret-store capabilities (H-1…H-7) | before M6 (staging) |
| O-02 | SMTP relay operator and credentials path in 1Password; DPA status (Google = US processor if Gmail is used) | start of M2 |
| O-03 | 1Password Connect server deployment details (URL, vault, token issuance) | start of M2 |
| O-04 | Consent text + version, privacy policy text, controller identity | before launch |
| O-05 | Product review of gambling-like mechanics for users aged 13–15 (DPIA R-15) | before M3 implementation of gambles |
| O-06 | **Integrity of ranks and gambles** (found while specifying `placeGamble`; analysis and recommendation in the M0 report): (a) one pending gamble *per achievement* with an unremoved stake lets the same XP be staked on many achievements at once; (b) R-GMB-03 "−stake" can lower the level or push XP below 0 when XP changed after placement, contradicting R-XP-03/R-XP-04; (c) wins compound — a simulation of trivial achievements with gambles exceeds the 2^53 safe-integer bound of R-XP-04 after 102 rounds, inside the 200-achievement limit; (d) a trivial achievement (one S quest, unlocked the same day) is flawless → Champion bonus 10 × 365 = 3 650 XP, and a gamble on it is riskless; (e) moving or removing `target_date` avoids the lateness penalty and Champion's deadline condition (A-26 only covers pending gambles) | before M3 implementation of ranks/gambles |

## 8. Traceability

- Threats → mitigations → tests: `docs/security/threat-model.md`.
- Data categories → tables/columns → export/deletion: `docs/privacy/data-inventory.md` + `.yaml`.
- Test layers, gates: `docs/test-strategy.md`.
- Decision records: `docs/DECISIONS.md` (ADR-0001…0015).
