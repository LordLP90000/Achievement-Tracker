# Data inventory

Status: M0 draft v2 (2026-10-22, PM decisions applied). Legal frameworks: Swiss FADP (nDSG/revFADP, in force 2023-09-01) and GDPR.
Controller: Questline (PM to confirm legal entity and address for the privacy policy). This document has a
machine-readable twin, `data-inventory.yaml`, which the **data-inventory guard test** (R-PRIV-08) reads: the test
introspects `information_schema` and fails if any table or column holding user data is missing from the YAML or
lacks an export/deletion classification.

## 1. Principles applied

- **Minimisation**: account = email + password hash + timezone/locale/week start + optional nickname + age self-declaration flag (no date of birth). No name, phone,
  location, contacts, advertising IDs, device fingerprints, analytics or crash reporters (R-PRIV-01/02).
- **Purpose limitation**: each category below has exactly one purpose set; no secondary use (no marketing, no
  profiling, no model training).
- **Storage limitation**: every category has a retention rule and an automated job or cascade that enforces it.
- **Security**: content encrypted per user (envelope encryption), tokens hashed, TLS everywhere, RLS.
- **Transparency & control**: export (`GET /v1/me/export`), deletion (`DELETE /v1/me`), consent withdrawal
  (`DELETE /v1/me/consents/goal_content`), session list/revocation.

## 2. Legal bases used

| Code | GDPR | FADP | Used for |
|------|------|------|----------|
| LB-CONTRACT | Art. 6(1)(b) performance of a contract | Art. 31(2)(a) processing directly connected with the contract | Account, authentication, sessions, goal content processing needed to provide the service |
| LB-CONSENT-HEALTH | Art. 9(2)(a) explicit consent (special categories) | Art. 6(7)(a) express consent for sensitive personal data | Goal content, because it **may** contain health or other sensitive data |
| LB-LEGIT-SEC | Art. 6(1)(f) legitimate interest (security, abuse prevention) | Art. 31(1) overriding private interest (security) | Audit events, rate limiting, security notices |
| LB-LEGAL | Art. 6(1)(c) legal obligation | Art. 31(1) | Keeping consent proof; answering access requests |

## 3. Categories

Retention codes: `ACCOUNT` = until account deletion (cascade), `SESSION` = until session end + 7 d,
`TOKEN` = ≤ 30 min or until used, then purged hourly.

| # | Category | Data elements | Purpose | Legal basis | Retention | Storage (tables · columns) | Protection | Export | Deletion |
|---|----------|---------------|---------|-------------|-----------|---------------------------|------------|--------|----------|
| C1 | Account identifier | Email address; HMAC blind index of the email | Login, uniqueness, verification/reset emails, security notices | LB-CONTRACT | ACCOUNT; unverified accounts purged after **7 days** | `users.email_enc`, `users.email_blind_index`; transient copies in `one_time_tokens.new_email_*` (TOKEN), `email_outbox.payload_enc` (until sent) | Encrypted with user DEK; blind index keyed HMAC | yes (email) ; blind index no (derived secret) | cascade |
| C2 | Authentication secrets | Argon2id password hash; SHA-256 hashes of access/refresh/verification/reset tokens; password-changed timestamp | Authenticate the user; session continuity; single-use flows | LB-CONTRACT | Password hash: ACCOUNT. Session tokens: SESSION. One-time tokens: TOKEN | `users.password_hash`, `users.password_changed_at`, `session_tokens.*`, `one_time_tokens.*` | Hashes only; constant-time comparison | **no** (secret material, documented exception) | cascade |
| C3 | Account settings & status | Timezone (IANA), locale, week start, optional nickname, accepted privacy-policy version, age self-declaration (≥ 13, no date of birth), deactivation time of a pending deletion | Correct local dates/streaks/week periods; localised emails; display; proof of acceptance and of the age declaration; 30-day reactivation window | LB-CONTRACT (LB-LEGAL for policy version and age declaration) | ACCOUNT; a deactivated account is hard-deleted **30 days** after the deletion request (Q-11) | `users.timezone`, `users.locale`, `users.week_start`, `users.nickname_enc`, `users.privacy_policy_version`, `users.age_confirmed`, `users.deactivated_at` | Nickname encrypted | yes | cascade / purge-job |
| C4 | Device sessions | Session ID, client platform (`ios`/`android`), optional user-chosen device label, created/last-used/re-auth timestamps, revocation reason | Let users see and revoke sessions; enforce re-auth; detect token reuse | LB-CONTRACT, LB-LEGIT-SEC | SESSION | `sessions.*` | Label encrypted | yes | cascade |
| C5 | Consents | Type (`goal_content`), text version, granted/withdrawn timestamps | Lawful basis for storing potentially sensitive goal content; proof | LB-LEGAL | ACCOUNT (history kept while the account exists) | `consents.*` | – | yes | cascade |
| C6 | Goal content (**potentially sensitive / health**) | Achievement title, description, motivation, category, target date and the attempt's deadline (earliest target date of the attempt, Q-31), status, privacy flag; quest title, notes, type, size, required flag, order, prerequisite, habit parameters, unit, start/target values; check-in values and notes | Core service: track goals and progress | LB-CONTRACT + **LB-CONSENT-HEALTH** | ACCOUNT, or immediately on consent withdrawal (Q-10) | `achievements.*`, `quests.*`, `check_ins.*` (except the C7 columns) | Free-text and numeric content and the target date encrypted with user DEK (Q-24); structure plaintext (DPIA R-5) | yes | cascade / consent withdrawal |
| C7 | Behavioural & derived data | Check-in dates, attempt numbers and counts-for-progress flags; completion times; habit reset counts and restart flags; execution scores and ranks; gambles (stake, status, loss reason, times); XP ledger (kind, amount, local date); rank badges; streaks (derived at read time) | Progress, XP, level, streak, rank, gamble and stats features | LB-CONTRACT | ACCOUNT (follows C6, incl. consent withdrawal) | `check_ins.local_date/attempt/counts_for_progress`, `achievements.attempt/completed_at/execution_score/rank`, `quests.reset_count/needs_restart/completed_at`, `gambles.*`, `xp_events.*`, `badges.*` | – | yes | cascade / consent withdrawal |
| C8 | Security audit events | Event type, outcome, truncated IP (/24 or /48), client platform, session ID, reason codes | Detect/investigate account takeover; let users review security events via export | LB-LEGIT-SEC | **90 days** (worker job), or ACCOUNT if earlier | `audit_events.*` | IP truncated; no emails/tokens/content | yes | cascade |
| C9 | Request idempotency records | Idempotency key, route, hash of request body, stored response (may contain C6) | Safe retries from mobile clients | LB-CONTRACT | **24 hours** | `idempotency_keys.*` | Response encrypted with user DEK | no (transient duplicate of C6; documented exception) | cascade / 24 h purge |
| C10 | Email outbox | Recipient address, locale, template name, raw token/link, attempt metadata | Deliver verification, reset and security emails reliably | LB-CONTRACT, LB-LEGIT-SEC | Deleted on send; dead letters **7 days** | `email_outbox.*` | Payload encrypted with user DEK | no (transient; contents are C1 + secrets) | cascade / purge |
| C11 | Rate-limit state | HMAC (daily key) of `scope:IP` or `scope:email-blind-index`, counters, block-until | Abuse prevention (brute force, enumeration, email bombing) | LB-LEGIT-SEC (Q-14) | **24 hours** | `rate_limit_buckets.*` | Keyed hash, not reversible without the daily key; not linkable across days | n/a (not attributable to a user) | n/a (no user relation) |
| C12 | Deletion tombstones | Random UUID of a deleted account + deletion timestamp | Replay deletions after a backup restore (Q-13) | LB-LEGAL (effective erasure) | **35 days** | `deleted_user_tombstones.*` | Contains no identifier other than the former random ID | n/a | n/a (the record of deletion) |
| C13 | Application logs | Request ID, method, route pattern, status, duration, error class, job metrics | Operate and debug the service | LB-LEGIT-SEC | **30 days** (provider log retention, M6) | Provider log storage (not the DB) | No PII by design (allowlist serializer, tested) | n/a | n/a |
| C14 | Backups | Encrypted snapshots of the whole database (all categories above, ciphertext + wrapped DEKs) | Disaster recovery | LB-CONTRACT | **30 days** rolling | Provider backup storage, encrypted at rest | DEKs wrapped by the KEK held in 1Password (ADR-0013); see ADR-0006 | n/a | expiry; tombstone replay after restore |
| C15 | Email delivery metadata at the SMTP relay | Recipient address, send timestamps, delivery status | Email delivery | LB-CONTRACT | Relay default (to be minimised in configuration, target ≤ 30 days) | SMTP relay operator (processor, Q-03; to be named, O-02) | DPA; CH/EU preferred — a Gmail/Google Workspace relay is a US processor (DPIA R-9) | n/a | relay retention |

Not collected at all: real name, phone number, postal address, precise or coarse location, contacts, photos,
advertising identifiers, device identifiers (IDFA/GAID/IMEI), push tokens (no server push in v1), analytics events,
crash reports.

## 4. Storage locations and transfers

| Location | What | Country | Status |
|----------|------|---------|--------|
| PostgreSQL (primary + backups) | C1–C12, C14 | CH or EU — PM's own hosting option (Q-01) | to be named (O-01) |
| 1Password vault + self-hosted Connect server | KEK only (never user data) | vault: 1Password cloud (EU region to confirm); Connect: our private network (Q-02, ADR-0013) | decided |
| SMTP relay | C15 (+ C1 and one-time links in transit) | depends on the operator (Q-03); Google = USA | to be named (O-02) |
| Log storage | C13 | same as hosting | to be named (O-01) |
| Developer machines / CI | synthetic data only (R-SUP-05); no production data ever | – | enforced by process |

No transfers outside CH/EU are planned. If the PM chooses a US-headquartered provider's Swiss region (AWS/GCP/Azure),
the DPIA must record the CLOUD Act consideration (see `dpia.md` R-9); the same applies to a Gmail/Google Workspace SMTP
relay (O-02).

## 5. Data-subject rights — how each is fulfilled

| Right | Mechanism | Latency |
|-------|-----------|---------|
| Access & portability (GDPR 15/20, FADP 25/28) | `GET /v1/me/export` — complete JSON, re-auth, 2/24 h, audit-logged | immediate |
| Rectification (GDPR 16, FADP 32) | `PATCH /v1/me`, `PATCH /v1/achievements/{id}`, `PATCH /v1/quests/{id}`; check-ins are undo + re-create | immediate |
| Erasure (GDPR 17, FADP 32) | `DELETE /v1/me` — immediate deactivation (all sessions revoked); hard delete + crypto-shredding after the 30-day reactivation window (Q-11); backups expire ≤ 30 d later; tombstone replay | deactivation immediate; erasure after 30 d (+ ≤ 30 d backups) |
| Restriction / withdrawal of consent (GDPR 7(3), 18) | `DELETE /v1/me/consents/goal_content` — deletes goal content (Q-10) | immediate |
| Objection (GDPR 21) | Only legitimate-interest processing is security-related (C8, C11); users may object by email to the controller; evaluated case by case | manual |
| Information (GDPR 13/14, FADP 19) | Privacy policy in the app (PM/legal) referencing this inventory | n/a |

## 6. Guard test specification (R-PRIV-08)

`test/privacy/data-inventory-guard.test.ts` (implemented in M2 for steps 1–5 and 7; step 6 follows with the export
service in M4):

1. Connects to the migrated test database and lists every table/column in schema `public` (ignoring `drizzle.*`).
2. Loads `docs/privacy/data-inventory.yaml`.
3. Fails if a table or column is not listed, or is listed but absent from the schema (stale inventory).
4. For every column with `personal: true`: requires `export: included | excluded-with-reason` and
   `deletion: cascade | purge-job | consent-withdrawal | not-applicable-with-reason`.
5. Cross-checks `deletion: cascade` columns against the actual FK graph from `users` (ON DELETE CASCADE path exists).
6. Cross-checks `export: included` tables against the keys produced by the export service on a seeded account.
7. Exceptions must carry `approved_by: PM` and a date.

Additionally (M2): the YAML is parsed strictly, so a misspelled key fails instead of silently dropping a rule;
`*_enc` columns and `encrypted: true` must coincide and be `bytea`; inventory tables that are not migrated yet must
be named in a shrink-only list in the test.

## 7. Change log

| Date | Change |
|------|--------|
| 2026-10-22 | Initial inventory for M0. |
| 2026-10-22 (v2) | PM decisions applied: approved Q-09 (device label), Q-13 (tombstones), Q-14 (hashed IPs). New elements: `users.week_start`, `users.age_confirmed` (C3), `users.deactivated_at` (C3; **deactivated accounts retained 30 days, then hard-deleted**, Q-11), `achievements.attempt/rank/execution_score`, `quests.reset_count/needs_restart`, `check_ins.attempt/counts_for_progress` (C6/C7), new table `gambles` (C7: stake, status, loss reason — derived gamification data, exported, cascade/consent-withdrawal), `target_date` now encrypted (C6), `achievement_pauses` removed. Processors: 1Password (Connect, holds the KEK — no personal data), SMTP relay operator (email addresses + one-time links; **Google = US jurisdiction if Gmail is used**, DPIA R-9). Hosting: PM's own option, location TBD. Minimum age 13 self-declared (Q-23). The machine-readable `data-inventory.yaml` was updated in the next row. |
| 2026-10-22 (yaml v2) | `data-inventory.yaml` v2: the columns and table above added, `achievement_pauses` removed, approvals for Q-09/Q-13/Q-14 recorded (`approved_by: PM`, `approved_on`); C3/C6/C7 rows of this document aligned. Fixed two `export_reason` values that contained an unquoted comma inside a YAML flow mapping and therefore silently produced bogus keys. Checked against `docs/data-model.md`: 18 tables, 175 columns, no differences. |
| 2026-10-29 (M2) | Guard test implemented (`test/privacy/data-inventory-guard.test.ts`) against the migrated account tables. It found that `quests`, `check_ins`, `xp_events` and `badges` were deleted on consent withdrawal without a retention rule, contrary to the inventory's own rule; added the same rule as for `achievements`. No new data categories; `audit_events.ip_prefix` is now stored as `cidr` with a /24 or /48 limit (same data, enforced truncation). |
| 2026-10-29 (M2 review) | PM decision Q-31 (rank and gamble integrity): new column `achievements.deadline_enc` (C6, encrypted like `target_date`): the earliest target date in effect during the current attempt, used for lateness and Champion (A-35); derived from the target date the user already entered, so no new kind of personal data. `gambles` now allows one pending gamble per user instead of per achievement (an index, no new data). |
| 2026-10-29 (M3, Q-34) | New column `quests.habit_week_start` (C6): the account's week start copied into a weekly habit when it starts or restarts, so a later change of the setting does not move its periods. A copy of an existing setting; no new kind of personal data. |
| 2026-10-29 (M3, R-STR-01) | New column `quests.habit_best_streak` (C7): the longest streak of the quest's ended runs, derived from its check-ins before a restart replaces the run's start date; shown as the best streak and in the stats. Derived behavioural data like `reset_count`; no new kind of personal data. |
