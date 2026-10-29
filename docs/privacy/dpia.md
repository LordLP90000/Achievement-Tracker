# Data Protection Impact Assessment (DPIA) — draft

Status: **draft v0.3** (2026-10-29: the PM's product review of R-15 recorded, Q-32; v0.2 in M0, 2026-10-22, with the PM decisions applied), maintained every milestone; to be reviewed by a data-protection expert
before launch (M6 review package). Legal bases: GDPR Art. 35; Swiss FADP Art. 22 (data protection impact
assessment where processing may entail a high risk, notably large-scale processing of sensitive personal data).

## 1. Is a DPIA required?

Yes. Questline stores free-text goals and measurements that **may** contain health data (weight-loss targets,
therapy goals, addiction recovery), financial or other sensitive information, for a potentially large number of
users, and uses systematic tracking of behaviour over time (check-ins, streaks). Both EDPB criteria "sensitive data"
and "data processed on a large scale / systematic monitoring" apply.

## 2. Description of the processing

| Aspect | Description |
|--------|-------------|
| Controller | Questline (legal entity, address and contact to be provided by the PM for the privacy policy) |
| Data subjects | App users aged **13 or older** (self-declared at registration, no date of birth — Q-23, R-AUTH-11; see R-12) |
| Purposes | (1) Provide the goal-tracking service: achievements, quests, check-ins, progress, XP, streaks, stats. (2) Authenticate users and secure their accounts. (3) Fulfil legal obligations (consent proof, data-subject rights). |
| Data categories | See `data-inventory.md` C1–C15. Sensitive: C6 goal content (possible health data). |
| Sources | Only the user, through the mobile app. No third-party data, no enrichment. |
| Recipients | Hosting provider (PM's own option, to be named — O-01), 1Password (holds the KEK only, no personal data — ADR-0013), SMTP relay operator (addresses + one-time links; to be named — O-02). No other recipients; no sale, no advertising, no analytics. |
| Transfers | None outside CH/EU planned by design; a Gmail/Google Workspace SMTP relay would make Google (USA) a processor for email addresses (R-9, O-02). |
| Retention | Account lifetime for content; 7 d unverified accounts; 30 d deactivated accounts (Q-11); 90 d audit; 24 h idempotency; 30 d backups; 35 d tombstones; 24 h rate-limit state (`data-inventory.md` §3). |
| Technology | TypeScript/Fastify API, PostgreSQL, per-user envelope encryption (XChaCha20-Poly1305, DEKs wrapped by a KEK from a self-hosted 1Password Connect server), Argon2id, opaque rotating tokens, RLS. |
| Scale | Consumer app; design target 10⁴–10⁵ users in year 1 (assumption for sizing only). |

### Data flow summary

1. User registers (email, password, timezone/locale, policy version) → account + per-user DEK created → verification
   email via outbox → provider.
2. User grants explicit consent for goal content in the app (unticked checkbox, versioned text) → stored.
3. User creates achievements/quests, records check-ins → content encrypted with the user's DEK before storage;
   engine computes progress/XP/streaks from decrypted values in memory per request.
4. User may export everything (JSON), revoke sessions, withdraw consent (content deleted), delete the account
   (deactivated at once; hard delete + DEK destroyed after a 30-day reactivation window).

## 3. Necessity and proportionality

| Question | Assessment |
|----------|-----------|
| Is each data element necessary? | Email: account recovery and verification (no username alternative chosen because recovery would be impossible). Password: authentication. Timezone: correctness of local dates/streaks. Locale: email language. Nickname: optional. Goal content: the product itself. Audit/rate-limit data: security, minimised (truncated/hashed IPs). |
| Could the purpose be achieved with less data? | Considered: no email (device-only accounts) — rejected because of recovery and multi-device needs, but **end-to-end encryption** is evaluated for v2 (threat model §2). No analytics or crash reporters by design. |
| Lawfulness | Contract (service), explicit consent for potentially sensitive content, legitimate interest for security-only processing, legal obligation for consent proof. |
| Transparency | Privacy policy in the app (PM/legal), consent text at the point of collection, export shows exactly what is stored. |
| Data-subject rights | All exercisable in-app without manual processing (`data-inventory.md` §5). |
| Processors | Each requires a DPA, CH/EU location, PM approval and an entry in `processors.md`. |
| International transfers | Avoided by design (Q-01…Q-03). |

## 4. Risks to the rights and freedoms of data subjects

Scale: Likelihood (L) and Severity (S) 1–4; Risk = L × S (≤ 4 low, 5–8 medium, ≥ 9 high).

| ID | Risk | L | S | Inherent | Measures (refs) | Residual |
|----|------|---|---|----------|----------------|----------|
| R-1 | Breach of the database or backups exposes goal content/emails (discrimination, embarrassment, blackmail) | 2 | 4 | 8 medium | Per-user envelope encryption, encrypted email + blind index, hashed tokens, Argon2id, RLS, private DB, encrypted disks/backups, 30-day backup expiry (R-ENC-*, threat model I-01, I-18) | 1 × 4 = **4 low** |
| R-2 | Account takeover (credential stuffing, token theft) gives an attacker read/write access to a user's goals | 3 | 3 | 9 high | Argon2id, breach list, rate limits with backoff, no enumeration, rotating refresh tokens with reuse detection, 15-min access tokens, session list/revocation, re-auth for sensitive actions, audit events (R-AUTH-*, S-01…S-09) | 1 × 3 = **3 low** |
| R-3 | Compromise of the application server (RCE, leaked runtime credentials) → decryption of user data | 1 | 4 | 4 low | Minimal non-root read-only container, SAST/dependency/container scanning, no secrets in images, 1Password Connect access logging, alerting (RR-1). **Updated 2026-10-22:** the KEK is loaded into process memory from a self-hosted 1Password Connect server (PM decision Q-02, ADR-0013), so a compromised process can decrypt all users, not only active ones; accepted by the PM, Connect server kept private, rotation runbook in M6 | 1 × 4 = **4 low** (E2E for v2) |
| R-4 | Processing health-related content without a valid legal basis | 2 | 3 | 6 medium | Explicit, unticked, versioned consent before any content is stored; withdrawal deletes content; consent proof retained; content guard on create endpoints (R-PRIV-04, E-10) | 1 × 3 = **3 low** |
| R-5 | Inference from plaintext metadata (counts, check-in dates, statuses, habit cadence, ranks) | 2 | 2 | 4 low | Only structural fields are plaintext; no categories/labels in plaintext; `target_date` encrypted (Q-24) | 2 × 1 = **2 low** |
| R-6 | Excessive retention (data kept after deletion, stale tokens, logs) | 2 | 3 | 6 medium | Cascading hard delete, crypto-shredding, retention jobs with tests, data-inventory guard test, tombstone replay after restores (R-PRIV-06/07/08) | 1 × 2 = **2 low** |
| R-7 | Processor incident (SMTP relay breach exposes addresses; hosting provider access) | 2 | 3 | 6 medium | Processors under DPA (CH/EU preferred; R-9 for a US relay), minimal data shared (addresses + one-time links; no content), short-lived links, relay retention minimised | 1 × 3 = **3 low** |
| R-8 | Loss or corruption of user data (availability/integrity) | 2 | 2 | 4 low | Managed PostgreSQL with backups/PITR, AEAD integrity, restore drills (M6), idempotent retries, optimistic concurrency | 1 × 2 = **2 low** |
| R-9 | Foreign-government access or transfer outside CH/EU (US CLOUD Act if a US provider hosts the service, or if Gmail/Google Workspace is the SMTP relay) | depends on O-01/O-02 | 3 | – | Prefer Swiss/EU-headquartered providers; a US SMTP relay receives only email addresses and one-time links (no goal content); on a US host, goal content stays encrypted with a KEK held in 1Password, outside the host | **to be assessed once O-01 and O-02 are named** |
| R-10 | Insider access by operators/developers | 1 | 4 | 4 low | No admin endpoints, encrypted content, no production data in dev/test, provider access logging, least-privilege roles | 1 × 3 = **3 low** |
| R-11 | Exposure through the user's own device (shared phone, backups of the device, screenshots) | 2 | 3 | 6 medium | `Cache-Control: no-store`, short tokens, `is_private` hint for the app, `docs/client-security.md` (Keychain/Keystore, no content in notifications) — device security is largely outside backend control | 2 × 2 = **4 low** |
| R-12 | Children using the app and providing sensitive goals without valid consent | 2 | 3 | 6 medium | Minimum age **13**, self-declared at registration (`age_confirmed`, R-AUTH-11, Q-23); no date of birth collected (minimisation); parental consent handled by the terms (O-04). Self-declaration can be bypassed, and in EU member states whose age of digital consent is 14–16 (GDPR Art. 8) a 13–15-year-old's own consent may not be valid without a parent — DP-expert review required | 2 × 3 = **6 medium** (until the DP-expert review) |
| R-13 | Function creep (later use of content for analytics, recommendations, training) | 2 | 3 | 6 medium | Purpose limitation written into the inventory; any new purpose needs a new consent version and DPIA update; no analytics SDKs | 1 × 3 = **3 low** |
| R-14 | Re-identification or interception of export files | 1 | 3 | 3 low | Re-auth, rate limiting, audit, `no-store`; the app should store exports only where the user chooses | 1 × 3 = **3 low** |
| R-15 | **Gambling-like mechanics** (double-or-nothing XP stakes, steep rank multipliers) may encourage compulsive behaviour, especially for users aged 13–15 (Q-23) | 2 | 2 | 4 low | XP only — no money, no purchases, no real-world value in v1; no chance element (the outcome depends only on the user finishing their own achievement); one pending gamble per user at a time; a loss removes at most the XP above the current level's threshold, so a level is never lost; a win pays at most the achievement's required XP and nothing within 7 days of the achievement's creation (Q-31); no cancel/re-roll loops. **Product review by the PM on 2026-10-29 (O-05 → Q-32): gambles stay available to all users ≥ 13 with these safeguards.** If a reward currency/coupons arrive in v2, this risk must be re-assessed with legal input (gambling law). | 2 × 1 = **2 low** |
| R-16 | **Deactivated accounts retained 30 days** (Q-11) keeps data longer than an immediate deletion would | 1 | 2 | 2 low | All sessions revoked, account unusable, encrypted at rest, hard-deleted automatically with tombstone; user informed of the deadline | 1 × 2 = **2 low** |

## 5. Measures summary (mapped to requirements)

- Encryption at rest per user with DEKs wrapped by a KEK from 1Password Connect; TLS in transit (R-ENC-*, R-TLS-*).
- Strong authentication and session management (R-AUTH-*), deny-by-default authorization with per-endpoint
  ownership tests (R-AUTHZ-*).
- Minimisation and retention automation (R-PRIV-01/07), guard test (R-PRIV-08).
- Rights handling in-app (R-PRIV-05/06, consent withdrawal).
- No third parties beyond approved processors (R-PRIV-02/03).
- Secure development: TDD, SAST, dependency and container scanning, secret scanning, SBOM (R-SUP-*).
- Logging without personal data, audit trail with minimal data (R-LOG-*).

## 6. Consultation

| Who | When | Status |
|-----|------|--------|
| PM (controller representative) | each milestone report | ongoing |
| Data-protection expert / DPO | before launch (M6 review package: this DPIA, data inventory, threat model, processors, privacy policy draft) | planned |
| Users | consent text and privacy policy usability test with the app team | planned (app team) |

## 7. Open items

| # | Item | Owner |
|---|------|-------|
| 1 | Name the hosting option (O-01) and the SMTP relay operator (O-02) → complete R-9 and `processors.md` (KEK source decided: 1Password Connect, Q-02) | PM |
| 2 | Minimum age decided (13, self-declared, Q-23); DP-expert review of R-12; product review of gambling-like mechanics for 13–15-year-olds done by the PM on 2026-10-29 (R-15, Q-32), part of the M6 review package | DP expert |
| 3 | Consent text and version scheme (`YYYY-MM-DD`) and privacy policy text | PM / legal |
| 4 | Encrypt `target_date` (R-5) — decided by the PM: yes (Q-24) | done |
| 5 | Controller identity and contact for the privacy policy | PM |
| 6 | Breach-notification runbook (FADP Art. 24: notify FDPIC "as soon as possible"; GDPR Art. 33: 72 h) | lead engineer, M6 |

## 8. Sign-off

| Role | Name | Date | Decision |
|------|------|------|----------|
| PM | | | |
| Data-protection expert | | | |
