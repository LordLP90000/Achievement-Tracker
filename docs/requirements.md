# Requirements, assumptions and open questions

Status: M0 draft (2026-10-22). Requirement IDs (`R-…`) are referenced by the threat model, the test strategy and
test names. Assumptions (`A-…`) are defaults I will apply unless the PM objects. Open questions (`Q-…`) are
decisions the PM must take; each lists options and my recommendation.

## 1. Product summary

Questline is a mobile app. Users set an **Achievement** (a big goal), break it into **Quests** (smaller goals) and
record **Check-ins**. Completing quests earns **XP**; an achievement is **unlocked** when all its required quests
are completed (badge + bonus XP). The backend is a REST/JSON API under `/v1` used only by the mobile app.

Vocabulary used verbatim in code, API and docs: `Achievement`, `Quest`, `Check-in` (`check_in` in identifiers),
`XP`, `level`, `streak`, `badge`, quest types `one_time | habit | target`, sizes `S | M | L`, achievement statuses
`active | paused | completed | archived`.

## 2. Functional requirements

### 2.1 Achievements

| ID | Requirement |
|----|-------------|
| R-ACH-01 | An achievement has: `title`, `description`, `motivation` ("why"), `category`, optional `target_date`, `status` (`active`, `paused`, `completed`, `archived`), `is_private` (display hint for the app only). |
| R-ACH-02 | `title`, `description`, `motivation`, `category` are encrypted at the application level (see R-ENC-*). |
| R-ACH-03 | Achievement progress = XP-weighted average of the progress of its **required** quests: `Σ(progress_i · xp_i) / Σ(xp_i)`. |
| R-ACH-04 | An achievement is unlocked (status → `completed`, badge awarded, bonus XP granted) when all required quests are completed. Bonus quests give XP but never block unlocking. |
| R-ACH-05 | Undoing a check-in that makes a required quest incomplete again reverses the unlock: status back to `active`, badge removed, bonus XP revoked. |
| R-ACH-06 | Pausing an achievement freezes the streaks of its habit quests (periods during the pause neither break nor extend a streak). |
| R-ACH-07 | `status` transitions by the client are limited to `active ↔ paused`, `active|paused → archived`, `archived → active`. `completed` is set only by the system (and reverted only by R-ACH-05). See Q-17. |
| R-ACH-08 | Achievements are listed with cursor pagination, filterable by `status`. |

### 2.2 Quests

| ID | Requirement |
|----|-------------|
| R-QST-01 | A quest belongs to exactly one achievement, has a `position` (order), is `required` or `bonus`, and has a `size` `S/M/L` worth `10/25/50` XP. |
| R-QST-02 | A quest may name one `prerequisite_quest_id` of the **same** achievement; the quest is `locked` (no check-ins) until the prerequisite is completed. No prerequisite cycles. |
| R-QST-03 | Type `one_time`: completed by a single "done" check-in; progress is 0 or 1. |
| R-QST-04 | Type `habit`: `times_per_period` N, `period` `day|week`, `period_count` K, `start_date`. Progress = `Σ_periods min(check-ins in period, N) / (N · K)`. Completed when progress = 1. (Period semantics: Q-04.) |
| R-QST-05 | Type `target`: `start_value`, `target_value` (≠ start), optional `unit`; increasing or decreasing. Progress = `clamp((current − start) / (target − start), 0, 1)` where `current` = value of the latest check-in (by `local_date`, then `created_at`); no check-in ⇒ `current = start`. Completed when progress = 1. |
| R-QST-06 | `title`, `notes`, `unit`, `start_value`, `target_value` are encrypted at the application level. |
| R-QST-07 | Quests can be edited (title, notes, position, required flag, size, prerequisite, type-specific parameters); the quest `type` is immutable. Progress/XP are recomputed after edits (an edit may complete or un-complete a quest; XP follows R-XP-*). |
| R-QST-08 | Deleting a quest deletes its check-ins, revokes XP earned through it (Q-12) and clears `prerequisite_quest_id` on quests that referenced it. |

### 2.3 Check-ins

| ID | Requirement |
|----|-------------|
| R-CHK-01 | A check-in records progress for a quest: "done" (one_time), one occurrence (habit) or a numeric `value` (target); optional `note`; `local_date` in the user's timezone. |
| R-CHK-02 | `value` and `note` are encrypted at the application level. |
| R-CHK-03 | Undo = delete the check-in and reverse **all** its effects (progress, completion, XP, streak, achievement unlock). Check-ins are otherwise immutable. |
| R-CHK-04 | Check-ins on a `locked` quest, a quest of a `paused|archived|completed` achievement, or with a future `local_date` are rejected. Back-dating is limited (A-08). |
| R-CHK-05 | Creating a check-in returns the updated quest and achievement state and the XP awarded, so the app needs no second round trip. |

### 2.4 XP, levels, streaks, stats

| ID | Requirement |
|----|-------------|
| R-XP-01 | XP is awarded exactly once per quest completion and once per achievement unlock (idempotent under retries and concurrent requests), and revoked on undo. All XP changes are recorded in an append-only ledger. |
| R-XP-02 | Level is derived from total XP (curve: Q-05). |
| R-STR-01 | Streak = number of consecutive periods (ending with the latest closed or the current period) in which a habit quest met its target N, computed in the user's IANA timezone. The current, still-open period does not break a streak. |
| R-STR-02 | Streaks are correct across midnight and DST changes; mandatory test vectors: `Europe/Zurich` on 2026-03-29 (clocks forward) and 2026-10-25 (clocks back). |
| R-STR-03 | Best streak per habit quest is tracked for stats. |
| R-STA-01 | Stats endpoint: XP over time (per local day), total XP and level, unlocked achievements, badges, best streaks. |

### 2.5 Out of scope for the backend in v1

Reminders (local notifications, no server push), achievement templates (shipped in the app), file uploads,
admin/back-office endpoints, web client (CORS stays off), passkeys/TOTP (M5), end-to-end encryption (evaluated for v2).

## 3. Security requirements (ASVS 5.0 L2 + OWASP API Security Top 10)

### 3.1 Authentication & sessions

| ID | Requirement |
|----|-------------|
| R-AUTH-01 | v1 authentication: email + password. M5 adds passkeys (WebAuthn) and optional TOTP 2FA. |
| R-AUTH-02 | Passwords hashed with Argon2id ≥ OWASP parameters (ADR-0005). Policy per NIST SP 800-63B: length over complexity, ≥ 64 chars allowed (we allow 128), no composition rules, no forced rotation, offline block-list of common/breached passwords (ADR-0012), no truncation, Unicode allowed (NFKC-normalised). |
| R-AUTH-03 | Email verification and password reset use single-use tokens, valid ≤ 30 min, stored only as hashes. |
| R-AUTH-04 | Access tokens are opaque, ≤ 15 min. Refresh tokens rotate on every use, are bound to a device session and stored only as hashes; reuse of a rotated refresh token revokes the whole session. |
| R-AUTH-05 | Users can list and revoke their sessions. A password change revokes all other sessions. A password reset revokes all sessions. |
| R-AUTH-06 | Changing email or password, data export and account deletion require recent re-authentication (window: A-07). |
| R-AUTH-07 | No account enumeration: register, login, resend-verification and forgot-password return the same response shape/status and take similar time whether or not the account exists. |
| R-AUTH-08 | Rate limiting with progressive backoff on all auth endpoints, per account (keyed by email blind index) and per IP; per-user limits on all other endpoints. `429` with `Retry-After`. |
| R-AUTH-09 | Login is only possible after email verification (Q-15). Unverified accounts are deleted after 7 days. |

### 3.2 Authorization

| ID | Requirement |
|----|-------------|
| R-AUTHZ-01 | Deny by default: every endpoint except `health`, `register`, `verify-email`, `resend-verification`, `login`, `refresh`, `password/forgot`, `password/reset` requires a valid access token. |
| R-AUTHZ-02 | Every query is scoped to the authenticated user. Another user's object (by ID) returns `404`, never `403`. RLS enforces this as a second layer (ADR-0003). |
| R-AUTHZ-03 | For **every** endpoint there is an automated test proving user A cannot read, change or delete user B's data (BOLA/IDOR). |
| R-AUTHZ-04 | Explicit request/response schemas with allowlisted fields; unknown fields are rejected (`400`). Owner, XP, status transitions, completion flags and timestamps are never accepted from the client (no mass assignment). |

### 3.3 Input, output & transport

| ID | Requirement |
|----|-------------|
| R-IN-01 | Everything validated (types, lengths, ranges, enums, formats); limits on body size (64 KiB), collection sizes and page size (default 20, max 100); cursor pagination only. |
| R-IN-02 | No string-built SQL (ESLint + review); no server-side requests to user-supplied URLs (none needed). |
| R-OUT-01 | Errors as RFC 9457 `application/problem+json`, no stack traces/internals (ADR-0007). |
| R-OUT-02 | All IDs are random UUID v4, never sequential. |
| R-OUT-03 | `Idempotency-Key` on create endpoints; optimistic concurrency via `version` + `If-Match`, `409` on conflict (ADR-0008). |
| R-TLS-01 | TLS only (1.2+, prefer 1.3) at the edge; HSTS (`max-age=63072000; includeSubDomains; preload`) and security headers (`X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Permissions-Policy` minimal, `Cross-Origin-Resource-Policy: same-origin`). |
| R-TLS-02 | `Cache-Control: no-store` (+ `Pragma: no-cache`) on every authenticated response. |
| R-TLS-03 | CORS disabled (no `Access-Control-Allow-Origin` ever) unless the PM approves a web client. |
| R-TLS-04 | Constant-time comparison for all secrets and tokens. |

### 3.4 Encryption & data at rest

| ID | Requirement |
|----|-------------|
| R-ENC-01 | Application-level envelope encryption for the fields in R-ACH-02, R-QST-06, R-CHK-02, plus email and nickname: one DEK per user, wrapped by a KEK (KMS in production, local secret in dev/test only); AEAD XChaCha20-Poly1305 with AD = user ID + record ID + field name; key version stored for rotation; vetted libraries only (ADR-0005, ADR-0006). |
| R-ENC-02 | Email stored encrypted plus an HMAC-SHA256 blind index (separate key) for login lookup and uniqueness. |
| R-ENC-03 | Encrypted disks and backups; database never publicly reachable; app DB role has no DDL rights, migrations use a separate role (ADR-0003). |
| R-ENC-04 | The threat model states what application-level encryption protects against (leaked DB dumps/backups) and what it does not (fully compromised server), and evaluates end-to-end encryption for v2. |

### 3.5 Logging & monitoring

| ID | Requirement |
|----|-------------|
| R-LOG-01 | Structured JSON logs with request IDs. |
| R-LOG-02 | Never log passwords, tokens, emails, goal content or request bodies. A test captures all logs emitted during the whole test run and fails if any seeded secret or personal value appears. |
| R-LOG-03 | Security audit events (login success/failure, password/email change, session revocation, export, deletion, consent changes) with minimal data; retention 90 days. |

### 3.6 Supply chain & infrastructure

| ID | Requirement |
|----|-------------|
| R-SUP-01 | Lockfile committed; minimal dependencies; every new runtime dependency is listed with a reason in the next report. |
| R-SUP-02 | CI fails on lint, typecheck, test or coverage failures; SAST findings (Semgrep); high/critical vulnerable dependencies (osv-scanner); committed secrets (gitleaks, also pre-commit); high/critical container findings (Trivy). SBOM (CycloneDX) generated per build. |
| R-SUP-03 | Containers: minimal base image, non-root, read-only filesystem, no secrets inside. |
| R-SUP-04 | Config via environment; the app refuses to start if a required secret is missing or too weak; production refuses the local key wrapper. |
| R-SUP-05 | Synthetic seed data only in dev and test. |

## 4. Privacy requirements (Swiss FADP/nDSG + GDPR)

| ID | Requirement |
|----|-------------|
| R-PRIV-01 | Data minimisation: account = email + password hash + settings (timezone, locale) + optional nickname. No real name, phone, location, contacts, advertising IDs, device fingerprinting. |
| R-PRIV-02 | No third-party analytics, trackers, ad SDKs or crash reporters receiving personal data. |
| R-PRIV-03 | Every external processor needs PM approval and an entry in `docs/privacy/processors.md`. |
| R-PRIV-04 | Explicit, unticked, versioned consent for storing goal content (may include health data); consent version + timestamp stored; withdrawal possible (consequence: Q-10). Without active consent, goal content cannot be created. |
| R-PRIV-05 | `GET /v1/me/export` returns all of the user's data as machine-readable JSON (re-auth, rate-limited, audit-logged). |
| R-PRIV-06 | Account deletion revokes all sessions, hard-deletes all rows of the user and destroys the wrapped data key (crypto-shredding; scope and limits in ADR-0006). |
| R-PRIV-07 | `docs/privacy/data-inventory.md` lists every data category with purpose, legal basis, retention, storage location. Defaults: audit log 90 days, IP addresses truncated in logs, backups expire after 30 days, unverified accounts deleted after 7 days. |
| R-PRIV-08 | Data-inventory guard test: introspects the DB schema and fails if any table/column holding user data is not classified in the inventory and covered by export and deletion (exceptions only if documented and PM-approved). |
| R-PRIV-09 | A DPIA draft exists from M0 and is kept current. |

## 5. Assumptions (defaults applied unless the PM objects)

| ID | Assumption |
|----|-----------|
| A-01 | **Nickname**: optional, 1–40 chars, encrypted with the user's DEK; used only for display in the app. |
| A-02 | **Timezone** is an IANA name validated against `Intl.supportedValuesOf('timeZone')`; default `Europe/Zurich` if the client sends none. **Locale** is a BCP 47 tag from an allowlist (`de-CH`, `fr-CH`, `it-CH`, `en`, …), used only to localise emails. |
| A-03 | **Habit check-ins** are count-based: each check-in is one occurrence; several per day are allowed (e.g. "2× per day"); `value` is not used for habits. |
| A-04 | **Week periods** start on Monday (ISO 8601) for all users in v1 (Q-18 if a user setting is wanted). |
| A-05 | **Target quests** accept any number of check-ins; the "current value" is the latest check-in. `start_value = target_value` is a validation error. Values are decimals with ≤ 3 fractional digits, |value| ≤ 10⁹. |
| A-06 | **Badges** in v1: exactly one badge per unlocked achievement. Streak-milestone badges may come later. |
| A-07 | **Re-authentication window**: 10 minutes since the last successful password entry on the current session (`POST /v1/auth/reauth` or login). |
| A-08 | **Check-in dates**: `local_date` must not be in the future (in the account timezone) and may be back-dated at most 7 days. At most 50 check-ins per quest per local day. |
| A-09 | **Limits**: ≤ 200 achievements per user (any status), ≤ 50 quests per achievement, title ≤ 120 chars, description/motivation ≤ 2 000 chars, category ≤ 60 chars, note ≤ 500 chars, unit ≤ 20 chars, device label ≤ 64 chars, body ≤ 64 KiB. |
| A-10 | **Session lifetimes**: access token 15 min; refresh token 30 days, sliding on each rotation; absolute session lifetime 180 days; then full login (documented per ASVS 5.0 §7.1). |
| A-11 | **Export** is synchronous (a single JSON document; user data volumes are small), limited to 2 exports per user per 24 h. |
| A-12 | **Email change** sends a verification link to the new address and a security notice to the old one; the change becomes effective only after verification; the new email must not be registered already (checked without leaking: the user is told "we sent a verification link" in both cases, and the existing owner gets a notice). |
| A-13 | **XP ledger** entries carry the user's local date (computed at write time in the account timezone) so "XP over time" needs no later timezone conversion. |
| A-14 | **Registration** requires acceptance of the privacy policy/terms version (`privacy_policy_version`), which is distinct from the goal-content consent (R-PRIV-04). The goal-content consent is given later in the app (unticked checkbox) via `POST /v1/me/consents`. |
| A-15 | **Idempotency keys** are retained 24 h; stored responses are encrypted with the user's DEK. |
| A-16 | **Prerequisite chains** are limited to depth 20 (validation), which also bounds cycle detection. |
| A-17 | **Achievements without any required quest** have progress 0 and cannot be unlocked (the client should prompt the user to add a quest). |
| A-18 | **Health endpoints** (`/health/live`, `/health/ready`) are unauthenticated, return no version or dependency details beyond `{"status":"ok"}`, and sit outside `/v1`. |
| A-19 | **Email templates** contain no goal content, only the action link and generic text; links point to a universal link / app link scheme provided by the mobile app team (`questline://…` or `https://<domain>/…`). |

## 6. Open questions for the PM

### 6.1 Blocking (need an answer before the stated milestone)

| ID | Needed by | Question | Options | Recommendation |
|----|-----------|----------|---------|----------------|
| Q-01 | M1 (CI/infra), M6 (deploy) | Hosting provider and region | See `docs/hosting-options.md`: (a) Exoscale (CH), (b) Scaleway (EU, FR/NL/PL), (c) Hetzner (DE/FI), (d) AWS/GCP/Azure Switzerland regions | **(a) Exoscale** — Swiss jurisdiction for compute, managed PostgreSQL **and** KMS from one provider; if lower cost/EU-only is acceptable: **(b) Scaleway** (verify its KMS/email maturity first). |
| Q-02 | M2 (per-user keys) | KEK provider (KMS) | Depends on Q-01: cloud KMS of the chosen provider; or self-hosted OpenBao/Vault Transit; or Infisical KMS | KMS of the chosen provider. If Exoscale: **Exoscale KMS** (encrypt/decrypt with encryption context = user ID, same Swiss jurisdiction). Self-hosted OpenBao Transit only if no provider KMS exists. `KeyWrapper` interface keeps this swappable. |
| Q-03 | M2 (verification emails) | Transactional email provider (processor, paid) | Infomaniak (CH), Scaleway TEM (FR), Brevo (FR), Mailjet (FR); non-EU providers not recommended | **Infomaniak** (Swiss) if hosting is Exoscale; Scaleway TEM if hosting is Scaleway. Needs DPA + entry in `processors.md`; tracking disabled. |
| Q-04 | M3 | Habit period semantics. With the formula `Σ min(c_i, N) / (N·K)` over a fixed window of K periods, one missed occurrence makes the quest impossible to complete (e.g. 39/40 forever). | (a) strict fixed window; (b) open-ended: periods count from `start_date` until the sum reaches N·K (K is the plan, not a deadline); (c) fixed window but completion at ≥ 90 % | **(b)** — keeps the formula, keeps the per-period cap (no cramming), and a missed week only delays completion. |
| Q-05 | M3 | Level curve and unlock bonus | Level: (a) `xp_to_reach(L) = 50·L·(L−1)` (L2 = 100, L5 = 1 000, L10 = 4 500); (b) linear 250 XP per level. Bonus: (a) 50 % of the achievement's required-quest XP, min 10; (b) flat 100 XP | Level **(a)**, bonus **(a)** (proportional bonus prevents XP farming with tiny achievements). |
| Q-09 | M2 | Session list needs a human-readable label. Should we store a user-chosen `device_label` (e.g. "My iPhone")? It is a new (minor) data category. | (a) `client` enum (`ios`/`android`) + optional user-chosen label, encrypted, ≤ 64 chars; (b) `client` enum only + created/last-used timestamps | **(a)** — labels are user-provided, not fingerprints, encrypted at rest and deleted with the session. |
| Q-10 | M2/M4 | Consequence of withdrawing the goal-content consent | (a) hard-delete all goal content (achievements, quests, check-ins, XP ledger, badges) immediately, account stays; (b) withdrawal = account deletion; (c) keep data but block access (not compliant: storage is processing) | **(a)**; the app must show a clear confirmation. |
| Q-11 | M4 | Account deletion timing | (a) immediate hard delete; (b) 14-day grace period with cancellation (data retained meanwhile) | **(a)** (more private; the app confirms with re-auth + explicit confirmation). |
| Q-12 | M3 | Deleting an achievement or quest: keep or revoke XP earned through it? | (a) revoke; (b) keep | **(a)** — consistent with undo semantics and prevents farming by create–complete–delete loops. |
| Q-13 | M4 | Keep a `deleted_user_tombstones` table (random user UUID + deletion time, 35 days) so deletions can be replayed after a backup restore? Without it, a restore could resurrect deleted users within the 30-day backup window. | (a) yes; (b) no, rely on manual runbook | **(a)** — a UUID with no other data is not reasonably linkable to a person; documented in the inventory. |
| Q-14 | M2 | Rate limiting needs per-IP state for ~1 h. Approve storing **HMAC-hashed** IPs (daily rotating key) in the DB for abuse prevention (legitimate interest)? | (a) yes, hashed; (b) per-IP limiting only at the edge/WAF | **(a)** — plus per-IP limits at the edge once hosting is chosen. |
| Q-23 | M2 (registration) | Minors: goal content may be sensitive, and consent by children is legally constrained (GDPR Art. 8: 13–16 depending on member state; FADP: capacity of judgement). What is the minimum age, and how is it enforced? | (a) terms require ≥ 16, self-declaration checkbox at registration, no date of birth stored; (b) collect date of birth (new personal data, not recommended); (c) no age requirement | **(a)** — minimisation-friendly; the app shows the age statement next to the policy acceptance. |

### 6.2 Confirm or change (defaults applied otherwise)

| ID | Question | Default |
|----|----------|---------|
| Q-06 | Minimum password length: 8 (NIST SHALL), 12, or 15 (NIST SHOULD)? | **12** with breach list + rate limiting; I will switch to 15 if you prefer the stricter option. |
| Q-07 | Session lifetimes (A-10) and re-auth window (A-07) | 15 min / 30 d sliding / 180 d absolute / 10 min re-auth |
| Q-08 | Back-dating window for check-ins (A-08) | 7 days, no future dates |
| Q-15 | Must the email be verified before login? | **Yes** (unverified accounts can only resend verification). |
| Q-16 | Limits in A-09 | as listed |
| Q-17 | Achievement status transitions (R-ACH-07), incl. whether `archived → active` is allowed | as listed, `archived → active` allowed |
| Q-18 | Week start Monday for everyone (A-04) | yes |
| Q-19 | Domain for problem-type URIs / API docs | URNs until a domain exists (ADR-0007) |
| Q-20 | Node 26 LTS (ADR-0002) | yes |
| Q-21 | Row-Level Security as defence in depth (ADR-0003) | yes |
| Q-22 | Housekeeping: keep `.idea/` tracked in git and keep `master` as default branch name? | keep both as created by your IDE |
| Q-24 | Encrypt `target_date` too (not listed in the brief, but a date next to an encrypted goal is weak metadata; cost is negligible)? | **yes** — I will encrypt it unless you object (DPIA R-5) |

## 7. Traceability

- Threats → mitigations → tests: `docs/security/threat-model.md` (references R-IDs).
- Data categories → tables/columns → export/deletion coverage: `docs/privacy/data-inventory.md`.
- Test layers, coverage/mutation targets and CI gates: `docs/test-strategy.md`.
