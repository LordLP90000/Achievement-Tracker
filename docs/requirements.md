# Requirements, assumptions and decisions

Status: M0 **v2** (2026-10-22) — updated with the PM's answers to all open questions (Q-01…Q-24, §6). Requirement IDs
(`R-…`) are referenced by the threat model, the test strategy and test names. Assumptions (`A-…`) are defaults the
PM has not objected to. Where a PM decision changed the original brief, the row is marked **[PM 2026-10-22]**.
Later on 2026-10-22: R-TLS/R-LOG/R-SUP rows restored from v1 (R-SUP-04 adapted to ADR-0013), A-26…A-28 proposed,
open item O-06 added. 2026-10-23: decisions Q-25…Q-28 from the M1 review (§6.1); O-02/O-03 moved to "before M6".
2026-10-29: A-26…A-28 accepted with the PM's "go" for M2. 2026-10-29 (M2 review, the PM's "go" for M3): A-02 as
refined and A-29…A-33 accepted; decisions Q-30…Q-32 (§6.3) close O-05, O-06 and O-07; A-34 and A-35 proposed.
Later on 2026-10-29: Q-33…Q-38 on habit periods, undo, habit edits and locked habits (§6.4); A-36…A-38 proposed.

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
| R-QST-02 | A quest may name one `prerequisite_quest_id` of the **same** achievement; it is `locked` until the prerequisite is completed. No cycles. A locked habit never resets; its run starts when it unlocks **[PM 2026-10-29, Q-38]**. |
| R-QST-03 | Type `one_time`: completed by a single counting check-in; progress 0 or 1. |
| R-QST-04 | Type `habit`: `times_per_period` N, `period` `day|week`, `period_count` K, `start_date`. Progress = (consecutive fully-met periods since the attempt's start) / K; a period is met when it has ≥ N counting check-ins. **A closed period with < N counting check-ins resets the quest** **[PM 2026-10-22, Q-04]**: progress → 0, state → `needs_restart` (no check-ins accepted), `reset_count + 1`. The user restarts by editing the quest (new `start_date` ≥ today, optionally new N/K); earlier check-ins remain visible as history and do not count. Completed when K consecutive periods are met. |
| R-QST-05 | Type `target`: `start_value`, `target_value` (≠ start), optional `unit`; increasing or decreasing. Progress = `clamp((current − start) / (target − start), 0, 1)`, `current` = value of the latest counting check-in (by `local_date`, then `created_at`); none ⇒ `start`. Completed when progress = 1. |
| R-QST-06 | `title`, `notes`, `unit`, `start_value`, `target_value` are encrypted at the application level. |
| R-QST-07 | Quests can be edited (title, notes, position, required flag, size, prerequisite, type-specific parameters); `type` is immutable. Progress/XP are recomputed; XP follows R-XP-*. Quests of a `completed` achievement are read-only. A habit's `period`, `times_per_period`, `period_count` and `start_date` change only at a restart or before its run begins **[PM 2026-10-29, Q-37]**. |
| R-QST-08 | Deleting a quest deletes its check-ins, revokes XP earned through it and clears `prerequisite_quest_id` on quests that referenced it. |
| R-QST-09 | Week-based periods start on the user's configured `week_start` (`monday | sunday | saturday`, default `monday`) **[PM 2026-10-22, Q-18]**. Each habit run keeps the `week_start` in effect when it started (creation or restart); a change applies to habits created or restarted afterwards **[PM 2026-10-29, Q-34]**. The first period of a weekly habit runs from its `start_date` to the end of the first full week, so it lasts 7–13 days; every later period is a calendar week **[PM 2026-10-29, Q-33]**. |

### 2.3 Check-ins

| ID | Requirement |
|----|-------------|
| R-CHK-01 | A check-in records progress for a quest: one occurrence (one_time/habit) or a numeric `value` (target); optional `note`; `local_date` in the user's timezone. |
| R-CHK-02 | `value` and `note` are encrypted at the application level. |
| R-CHK-03 | Undo = delete the check-in and reverse **all** its effects (progress, completion, XP, streak, rank, gamble). Check-ins are otherwise immutable. Undo is possible only on the day the check-in was made, in the account's time zone **[PM 2026-10-29, Q-36]**. |
| R-CHK-04 | `local_date` must not be in the future and may be back-dated at most 7 days. **Only check-ins dated "today" (account timezone, at creation time) count** toward progress, streaks, XP and resets; back-dated ones are stored as history with `counts_for_progress = false` **[PM 2026-10-22, Q-08]**. |
| R-CHK-05 | Check-ins are rejected (409) on a `locked` or `needs_restart` quest, on quests of a `paused`/`completed` achievement, and (422) with a `value` on non-target quests or without one on target quests. |
| R-CHK-06 | Creating a check-in returns the check-in, the updated quest and achievement, XP awarded and any rank/gamble/unlock events (no second round trip). |

### 2.4 XP, levels, duration factor

| ID | Requirement |
|----|-------------|
| R-XP-01 | XP is awarded exactly once per quest completion / unlock / rank / gamble settlement (idempotent under retries and concurrency), and revoked on undo, pause-reset, deletion. All changes are in an append-only ledger with a user-local date. |
| R-XP-02 | **Duration factor** (habit quests only, from structure not from user claims) **[PM 2026-10-22, Q-05g/h]**: span in days = `period_count` (daily) or `period_count × 7` (weekly); factor ×1 for ≤ 28 days, ×1.5 for 29–56, ×2 for 57–112, ×3 for ≥ 113. `xp = round(base × factor)`. |
| R-XP-03 | **Level curve** **[PM 2026-10-22, Q-05e]**: XP required to reach level L is `100 × 3^(L−2)` for L ≥ 2 (L2 = 100, L3 = 300, L4 = 900, L5 = 2 700, L10 = 656 100); level 1 at 0 XP. Level is derived from total XP, which can decrease through a lost gamble — it removes at most the XP above the current level's threshold (R-GMB-03, **[PM 2026-10-29, Q-31]**), so the level itself never drops. |
| R-XP-04 | Total XP never goes below 0 and is stored/handled as a 64-bit integer. |

### 2.5 Execution score and ranks **[PM 2026-10-22, Q-05c…f]**

| ID | Requirement |
|----|-------------|
| R-RANK-01 | On unlock, the **execution score** (0–100) of the current attempt is computed from non-gameable signals only: (a) quest execution = XP-weighted mean over required quests of `100 / (1 + reset_count_in_attempt)` for habits and 100 for one_time/target; (b) lateness: if the attempt has a **deadline** — the earliest `target_date` in effect during the attempt **[PM 2026-10-29, Q-31; A-35]** — and unlock is after it, multiply by `max(0, 1 − days_late / 30)`, days late counted from the deadline; (c) each gamble lost on this achievement (any attempt) subtracts 10 points. Clamp 0–100. |
| R-RANK-02 | Ranks by score: Bronze ≥ 55, Silver ≥ 65, Gold ≥ 75, Platinum ≥ 85, Emerald ≥ 92, **Diamond = 100**, **Champion = 100 and flawless**: `attempt = 1` (never paused/reset), no habit reset in the attempt, no gamble ever lost on this achievement, every bonus quest also completed, and on/before the attempt's deadline if it has one (R-RANK-01 b, Q-31). Score < 55 → unlocked but `unranked`. |
| R-RANK-03 | **Rank bonus** = `round(Σ required quest xp × multiplier)` with multipliers Bronze ×0.5, Silver ×1.5, Gold ×4.5, Platinum ×13.5, Emerald ×40, Diamond ×120, Champion ×365; unranked → 0. Recorded as an XP event `rank_bonus` and a badge of kind `achievement_rank` with the rank. The bonus is paid only if the unlock comes at least 7 days after the achievement was created **[PM 2026-10-29, Q-31; A-34]**; otherwise it is 0 — score, rank and badge are still recorded. |
| R-RANK-04 | Rank, score and badge are reverted if the unlock is undone (R-ACH-05). |
| R-RANK-05 | A spendable reward currency ("coupons") is **out of scope for v1**; the ledger design (per-rank events) allows adding it later without migration of history. |

### 2.6 Gambles **[PM 2026-10-22, Q-05i]**

| ID | Requirement |
|----|-------------|
| R-GMB-01 | A user may have **one pending gamble at a time**, across all achievements **[PM 2026-10-29, Q-31]**, placed on an `active` achievement that has a `target_date` in the future. Stake = XP above the current level's threshold at placement time (must be > 0). The stake is locked (recorded) but not removed. |
| R-GMB-02 | **Win**: the achievement is unlocked on/before `target_date` → XP event `gamble_won` of `+stake` (double or nothing), capped at the achievement's required XP (Σ effective XP of its required quests) and 0 if the unlock comes less than 7 days after the achievement was created **[PM 2026-10-29, Q-31; A-34]**; status `won`. |
| R-GMB-03 | **Loss**: `target_date` passes without unlock (settled by the daily retention job in the user's timezone), or a habit quest of the achievement resets, or the achievement is paused or deleted → XP event `gamble_lost` of `−stake`, limited to the XP above the current level's threshold at settlement **[PM 2026-10-29, Q-31]** (the level never drops, XP never goes below 0), status `lost`. Quest progress is never affected by a loss. |
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
| R-IN-01 | Validate everything; body ≤ 64 KiB; limits **[PM, Q-16]**: ≤ 200 achievements/user (active and paused; the completed archive does not count, **[PM 2026-10-29, Q-40]**), ≤ 50 quests/achievement, ≤ 50 check-ins/quest/day, ≤ 20 sessions; page size default 20, max 100; cursor pagination. |
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
| A-02 | Timezone validated against `Intl.supportedValuesOf('timeZone')`, default `Europe/Zurich`; locale from an allowlist. **[refined 2026-10-29 in M2; accepted 2026-10-29 with the M3 go]** The list omits `UTC` and lists renamed zones under old names (`Europe/Kiev`), so a name is accepted when its canonical form (via `Intl.DateTimeFormat`) is in that list or is `UTC`: aliases such as `Europe/Kyiv`, `US/Eastern`, `Etc/UTC`, `GMT` are accepted and stored canonically; offsets (`+01:00`) and POSIX-style names (`EST5EDT`, `Etc/GMT+5`) are refused. |
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
| A-23 | `week_start` change does not retroactively re-bucket already closed periods (with Q-34 a running habit keeps its week start altogether). |
| A-24 | The PM's own hosting must satisfy H-1…H-7 in `docs/hosting-options.md`; until named, deployment artefacts stay provider-neutral (Docker image + Compose). |
| A-25 | SMTP sender uses `nodemailer` with TLS required (STARTTLS or implicit TLS), credentials from 1Password/env, per-account send limit 3/h, outbox dedupe. |
| A-26 | **[accepted 2026-10-29 with the M2 go; proposed 2026-10-22]** While a gamble is pending, the achievement's `target_date` cannot be changed or removed (`409 gamble-pending`); otherwise a loss could be avoided by moving the date (T-17). |
| A-27 | **[accepted 2026-10-29 with the M2 go; proposed 2026-10-22]** After a lost gamble, no new gamble can be placed on the same achievement in the same attempt (`409 gamble-lost-this-attempt`, T-16). |
| A-28 | **[accepted 2026-10-29 with the M2 go; proposed 2026-10-22]** A habit `start_date` (on creation and on restart) must be today or later (`422`): a period before today could never be met because back-dated check-ins never count (R-CHK-04). |
| A-29 | **[accepted 2026-10-29 with the M3 go; proposed 2026-10-29]** A registration without `locale` gets `de-CH` (the service starts in German-speaking Switzerland, like the default timezone `Europe/Zurich`); the app is expected to send the device locale. |
| A-30 | **[accepted 2026-10-29 with the M3 go; proposed 2026-10-29]** Forgot-password also emails an **unverified** account, and a completed reset marks the address verified: the link proves control of the address. This also closes account pre-hijacking — if someone registered another person's address first, the owner takes it over with a reset, which ends every session and replaces the password. |
| A-31 | **[accepted 2026-10-29 with the M3 go; proposed 2026-10-29 and recorded here after the rate-limit commit cited it without defining it]** Rate-limit values (R-AUTH-08), to be tuned with the M6 load test: every public auth endpoint 20 / min per client (IPv4 address, IPv6 /64); requests that may email an address 3 / h per submitted address, registered or not (register, resend-verification, forgot-password); email-change requests 3 / h per user; every authenticated operation 120 / min per user (O-07 → Q-30: all of them document `429`); wrong passwords at login per submitted address and at re-auth/password change per user: 5 free failures, then a block of 1 min doubling up to 15 min, cleared by a success. |
| A-32 | **[accepted 2026-10-29 with the M3 go; proposed 2026-10-29]** Email links have the form `<PUBLIC_LINK_BASE_URL>/verify-email#token=…`, `/reset-password#token=…` and `/confirm-email-change#token=…`; the app (universal/app links) or a small web page posts the token to the matching endpoint. The token travels in the URL **fragment**, which browsers never send to a server, so it cannot end up in web-server logs or `Referer` headers. |
| A-33 | **[accepted 2026-10-29 with the M3 go; proposed 2026-10-29]** Emails are plain text (no HTML, nothing to inject or track), signed "Questline", in English, German, French or Italian after the account's locale (Swiss locales use their language; German in Swiss orthography without ß; an unknown stored locale falls back to `de-CH`), in the formal register (Sie / vous / Lei). Security notices never contain a link. Copy review: O-08. |
| A-34 | **[proposed 2026-10-29]** The 7-day rule of Q-31 compares instants: an unlock earns its rank bonus and pays a gamble win only if it comes at least 7 × 24 h after the achievement's `created_at` — not calendar days, so changing the time zone cannot shorten the wait. An earlier unlock still records score, rank and badge; a pending gamble is then settled as `won` with +0 XP (it counts as won in the gamble record and returns to pending like any win if the unlock is undone, R-ACH-05). |
| A-35 | **[proposed 2026-10-29]** The **deadline** of an attempt (Q-31, R-RANK-01 b) is the earliest `target_date` in effect at any time during the attempt: it starts as the `target_date` when the attempt starts (creation, or the resume that starts attempt n + 1); an earlier new date moves it, a later date or removing the date does not. It is stored encrypted like `target_date` (Q-24) in `achievements.deadline_enc` and is not an API field (it shows through score and rank; the export, M4, includes it — exposing it would be an additive contract change). Gamble settlement keeps using `target_date`, which cannot change while a gamble is pending (A-26). |
| A-36 | **[proposed 2026-10-29]** A counting check-in (dated today) on a habit whose run has not begun yet (`start_date` after today) is refused with `422`: it would belong to no period and silently count for nothing. Back-dated check-ins stay possible as history (R-CHK-04). |
| A-37 | **[proposed 2026-10-29]** A completed quest keeps its target values (`start_value`, `target_value`; `422`): changing them could make it incomplete again and re-lock a running habit that requires it, which would stop that habit's periods (Q-38) — a way around a reset. Title, notes, unit and the other fields stay editable. |
| A-38 | **[proposed 2026-10-29]** XP revocations are exact (R-XP-01), so when a lost gamble took XP that is later revoked (by a pause or a deletion) the total would fall below 0; an `xp_floor` ledger event then brings it back to 0 (R-XP-04) and later XP counts in full. The ledger also records an undone winning unlock as `gamble_reverted`. |
| A-39 | **[proposed 2026-10-29]** While an achievement is **paused**, its quests show as reset — no check-in counts, no habit run is going — and nothing changes: no habit resets, no XP, no gamble (it was lost on pausing). On resume (attempt n + 1), a habit whose `start_date` has passed starts its run on the resume day, like an unlocked habit (Q-38); one with a later `start_date` keeps it. Implemented with pause/resume. |
| A-40 | **[proposed 2026-10-29]** A **completed** achievement is shown as it was on its unlock day, in the account's time zone: a bonus habit still running then keeps its state and never resets afterwards, so the read-only archive (R-ACH-07) never changes by itself. Only an undo on the unlock day (Q-36) can re-lock it (R-ACH-05). |

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

### 6.1 Decisions from the M1 review (PM, 2026-10-23)

| ID | Decision |
|----|----------|
| Q-25 | **Contract**: every operation that accepts a request body documents `413` (body over 64 KiB) and `415` (body not JSON) as problem responses — 19 operations, additive change. |
| Q-26 | Commits in this repository use the PM's GitHub no-reply address (`272163696+LordLP90000@users.noreply.github.com`) and the name `Laurent` (repository-local git config). Past commits keep the old address; history is not rewritten. |
| Q-27 | M2 is built and tested against local stand-ins for the SMTP relay and the 1Password Connect server; the real services are wired in when O-02/O-03 are answered, before staging (M6). |
| Q-28 | Two findings of the M1 demo are fixed before M2: successful health probes are no longer logged (failures still are), and Fastify's per-address "Server listening at …" lines are dropped (one structured `api listening` line remains). |

### 6.2 Decisions during M2 (PM)

| ID | Decision |
|----|----------|
| Q-29 | **Session limit (2026-10-29):** a login that would create a 21st live session logs out the least recently used session automatically (revoked with reason `session_limit`, audited as `session_revoked`); the login itself always succeeds, so the contract is unchanged. Refusing the 21st login was rejected: it needs a contract change and could lock out a user without another logged-in device. |

### 6.3 Decisions from the M2 review (PM, 2026-10-29)

With the same review the PM gave the "go" for M3 and accepted A-02 (as refined) and A-29…A-33. O-08 (copy review of
the emails) stays open until launch.

| ID | Decision |
|----|----------|
| Q-30 | **`429` on every authenticated operation (O-07):** the contract documents `429` on the 22 authenticated operations that lacked it (additive, `0.2.2-draft`), so the per-user limit of A-31 applies to every authenticated operation; done before the first M3 endpoint. |
| Q-31 | **Integrity of ranks and gambles (O-06), the recommended package including its optional rule:** (1) one pending gamble per **user**, not per achievement (R-GMB-01); (2) a loss removes `min(stake, XP above the current level's threshold)` (R-GMB-03, R-XP-03); (3) a win pays at most the achievement's required XP (R-GMB-02); (4) lateness and Champion's deadline are measured against the earliest `target_date` in effect during the attempt (R-RANK-01/02, A-35); (5) the rank bonus and a gamble win only for achievements unlocked at least 7 days after their creation (R-RANK-03, R-GMB-02, A-34). The numbers live in `src/domain/constants.ts` (ADR-0015). |
| Q-32 | **Gambles for users aged 13–15 (O-05, DPIA R-15) — the PM's product review:** gambles stay available to every user ≥ 13 with the Q-31 safeguards: XP only (no money, purchases or real-world value), no chance element (the outcome depends only on the user finishing their own achievement), one at a time, never cancellable, a loss never lowers the level, wins capped. Not chosen: opt-in per account, no gambles in v1, an age bracket at registration (new personal data, conflicts with Q-23). Re-assessed with legal input if a reward currency arrives (R-RANK-05). |

### 6.4 Decisions during M3 (PM)

| ID | Decision |
|----|----------|
| Q-33 | **First period of a weekly habit (2026-10-29):** it runs from `start_date` to the end of the first full calendar week (7–13 days) and still needs `times_per_period` check-ins; every later period is a calendar week (R-QST-09). The duration factor stays based on `period_count × 7` days (R-XP-02). Not chosen: a proportional target for a partial week, 7-day blocks counted from `start_date`, a partial week as a normal period (impossible to meet, e.g. 5× per week started on a Saturday). |
| Q-34 | **`week_start` changes and running habits (2026-10-29):** each habit run keeps the week start it began with (stored per quest); a new setting applies to habits created or restarted afterwards. Not chosen: switching running habits with transitional periods. |
| Q-35 | **Contract, additive (2026-10-29):** habit quests show a read-only `current_period` — start, end, counting check-ins and the number required — so the app never re-implements Q-33/Q-34. Computed, nothing new stored. |
| Q-36 | **Undo window (2026-10-29):** a check-in can be undone only on the day it was made (account time zone); later → `409 urn:questline:problem:check-in-final` (additive contract change). Closed periods and completed achievements never change afterwards (R-CHK-03, R-ACH-05, R-ACH-07). Not chosen: undo at any time with recomputed effects; answering 404 for older check-ins. |
| Q-37 | **Editing a running habit (2026-10-29):** while a habit's run is open or completed, its `period`, `times_per_period`, `period_count` and `start_date` are fixed (`422`); they change at a restart (`needs_restart`) or before the run's `start_date`. Title, notes, size, required flag, position and prerequisite stay editable (R-QST-07). Not chosen: a change that restarts the habit as a reset; a change that restarts it without penalty (which would let a user dodge a reset and a gamble loss). |
| Q-38 | **Habits with a prerequisite (2026-10-29):** a locked habit never resets; if its start date has passed when it unlocks, its run starts on the unlock day (with the week start of that day, Q-34). A habit's prerequisite changes only before its run begins (a future start date, or while locked) or at a restart, like the Q-37 fields — otherwise adding a prerequisite could freeze a running habit before a missed period. Not chosen: periods running while the habit is locked (resets the user could not prevent); periods closed while locked counting as met. |
| Q-39 | **Idempotency keys and failures (2026-10-29):** only successful create responses are stored and replayed for 24 h (`Idempotency-Replayed: true`); a request that failed (e.g. `403 consent-required`, `409 gamble-pending`, `422` limit) changed nothing, so a retry with the same key runs again and the app can fix the cause first (ADR-0008, contract 0.2.6). Not chosen: replaying failures too, which would force a new key after every error. |
| Q-40 | **Achievement limit and the archive (2026-10-29):** the limit of 200 achievements per user (R-IN-01) counts only `active` and `paused` ones; completed achievements, the read-only archive that cannot be deleted (R-ACH-07), do not count. The next open one → `422 urn:questline:problem:limit-reached` (contract 0.2.7). Not chosen: counting the archive, which would lock out long-time users for good. |

## 7. Open items (non-blocking)

| ID | Item | Needed by |
|----|------|-----------|
| O-01 | Name of the hosting option and its database/backup/TLS/secret-store capabilities (H-1…H-7) | before M6 (staging) |
| O-02 | SMTP relay operator and credentials path in 1Password; DPA status (Google = US processor if Gmail is used) | before M6 (staging); M2 uses a local stand-in (Q-27) |
| O-03 | 1Password Connect server deployment details (URL, vault, token issuance) | before M6 (staging); M2 uses a local stand-in (Q-27) |
| O-04 | Consent text + version, privacy policy text, controller identity | before launch |
| O-05 | Product review of gambling-like mechanics for users aged 13–15 (DPIA R-15) | **closed 2026-10-29** → Q-32 |
| O-07 | **429 in the contract** (found while wiring R-AUTH-08): only 18 of 40 operations document `429`, so the per-user limit applies only to those; `GET`/`PATCH /me`, sessions, consents, logout and the M3 reads/updates cannot be limited per user without an additive contract change (document `429` on every authenticated operation). Edge per-IP limits (architecture §1) still apply | **closed 2026-10-29** → Q-30 |
| O-08 | **Email copy review**: the texts of the seven emails in four languages (A-33) were written by engineering; tone (formal register proposed) and translations need a native-speaker review | before launch (M6) |
| O-06 | **Integrity of ranks and gambles** (found while specifying `placeGamble`; analysis and recommendation in the M0 report): (a) one pending gamble *per achievement* with an unremoved stake lets the same XP be staked on many achievements at once; (b) R-GMB-03 "−stake" can lower the level or push XP below 0 when XP changed after placement, contradicting R-XP-03/R-XP-04; (c) wins compound — a simulation of trivial achievements with gambles exceeds the 2^53 safe-integer bound of R-XP-04 after 102 rounds, inside the 200-achievement limit; (d) a trivial achievement (one S quest, unlocked the same day) is flawless → Champion bonus 10 × 365 = 3 650 XP, and a gamble on it is riskless; (e) moving or removing `target_date` avoids the lateness penalty and Champion's deadline condition (A-26 only covers pending gambles) | **closed 2026-10-29** → Q-31 |

## 8. Traceability

- Threats → mitigations → tests: `docs/security/threat-model.md`.
- Data categories → tables/columns → export/deletion: `docs/privacy/data-inventory.md` + `.yaml`.
- Test layers, gates: `docs/test-strategy.md`.
- Decision records: `docs/DECISIONS.md` (ADR-0001…0015).
