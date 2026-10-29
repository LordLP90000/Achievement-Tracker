# Threat model (STRIDE)

Status: M0 draft (2026-10-22). Baseline: OWASP ASVS 5.0 Level 2, OWASP API Security Top 10 (2023).
Every threat maps to at least one mitigation and at least one automated test; "Test" names are the planned test
files (layer prefixes: `unit/`, `integration/`, `contract/`, `security/`, `e2e/`, `ci`). Requirement IDs refer to
`docs/requirements.md`.

## 1. Scope, assets and trust boundaries

```
                 ┌────────────────────────── Internet ──────────────────────────┐
  [User] ──▶ [Mobile app] ══ TLS ══▶ ║ Edge LB ║ ──▶ [questline-api] ──▶ [PostgreSQL]
                                     ║ (TB1)   ║        │   (TB2)             ▲ (TB3)
                                     ╚═════════╝        │                     │
                           (TB4) [1Password Connect] ◀──┤                     │
                                                        │                     │
                                    [SMTP relay] ◀── [questline-worker] ──────┘
                                     (TB5)
  [Developers / CI] ──▶ [Container registry] ──▶ deployment (TB6: supply chain)
  [Backups] (TB7: encrypted, 30-day expiry)   [Logs/metrics] (TB8)
```

| Asset | Sensitivity | Where |
|-------|-------------|-------|
| Goal content (titles, descriptions, motivation, category, notes, values, units) | **High** — may reveal health, finances, relationships | `achievements`, `quests`, `check_ins`, `idempotency_keys`, `email_outbox` (encrypted) |
| Email address | High (identifier, contact) | `users.email_enc`, blind index |
| Credentials: password hashes, access/refresh/one-time token hashes | High | `users`, `session_tokens`, `one_time_tokens` |
| Data encryption keys (DEK), KEK, blind-index key, rate-limit key | **Critical** | `user_keys` (wrapped), 1Password vault + self-hosted Connect server (KEK), secret store, process memory |
| Behavioural data: check-in dates, XP ledger, streaks, audit events | Medium | `check_ins`, `xp_events`, `audit_events` |
| Availability of the service | Medium | all |

Trust boundaries: TB1 client↔edge (untrusted network), TB2 edge↔API (trusted network, proxy headers),
TB3 API↔DB (private network, TLS), TB4 API↔1Password Connect (KEK, once at startup), TB5 worker↔SMTP relay (processor), TB6 supply chain,
TB7 backups, TB8 logs/observability.

### Trusted / assumed

- The mobile app binary is not trusted (anyone can call the API); the API never relies on client-side checks.
- The hosting infrastructure (hypervisor, network isolation) and 1Password (vault encryption, Connect server) behave as documented.
- Operators with production access are trusted but **their access is logged by the provider** and they never need
  plaintext goal content to operate the service (no admin endpoints, encrypted at rest, no content in logs).

## 2. What application-level encryption does and does not protect against (R-ENC-04)

| Scenario | Protected? | Why |
|----------|-----------|-----|
| Leaked database dump or SQL export (e.g. misconfigured bucket, stolen laptop with a dump) | **Yes** | Goal content, email, nickname, outbox payloads are AEAD-encrypted with per-user DEKs wrapped by a KEK the dump does not contain (it lives only in 1Password and in app memory); tokens are hashed; passwords are Argon2id. The attacker learns only structure (counts, dates, statuses, XP). |
| Leaked backup (TB7) | **Yes**, same as above | Backups contain the same ciphertext and wrapped DEKs. |
| Database compromise via SQL injection or a DB credential leak (read access, no app host) | **Yes** for content | Same reasoning; plus RLS limits what the app role can see without `app.user_id`. |
| Curious/malicious DBA or provider staff with DB access only | **Yes** | They have no access to the KEK (1Password vault, app memory). |
| Compromised **app server** (RCE, stolen runtime credentials incl. the Connect token) | **No** | The process holds the KEK (ADR-0013), so an attacker in the process can decrypt **all** users' data (RR-1). Mitigations: minimal container, read-only FS, non-root, KEK in guarded memory, DEK cache ≤ 5 min, Connect access logs, alerting. |
| Compromised client device | **No** (out of scope for the backend) | See `docs/client-security.md` (M6): Keychain/Keystore, no content in notifications. |
| Metadata inference (number of quests, check-in cadence, target dates) | **Partially** | Structural columns (check-in dates, counts, statuses, ranks, scores) are plaintext for progress/streak maths; `target_date` is encrypted (Q-24). Documented in the DPIA as residual risk R-5. |
| Email guessing against the blind index by someone holding the DB **and** the blind-index key | **No** | Deterministic HMAC allows offline guessing of candidate emails. Mitigation: key lives in the secret store (1Password), never in the DB; rotation procedure re-indexes. |

**End-to-end encryption (v2 evaluation).** Encrypting goal content on the device with a key the server never sees
would also cover the "compromised server" row. Costs: the server could no longer compute progress, XP, streaks or
stats (they would move to the client and be reported as derived, unverifiable values), key recovery on device loss
needs a recovery code or passkey-PRF-derived key, and export/portability must happen client-side. A middle ground
for v2: client-side encryption of **free-text** fields only (title, description, motivation, notes) while numeric
values and dates stay server-readable so the engine keeps working. Recommendation: revisit after M6 with real
usage data; the current design keeps field boundaries so this is an additive change.

## 3. Threats, mitigations, tests

### 3.1 Spoofing (authentication)

| ID | Threat | Mitigation | Test |
|----|--------|-----------|------|
| S-01 | Credential stuffing / brute force on `login` | Argon2id (ADR-0005); per-IP and per-account token buckets with progressive backoff (R-AUTH-08); breached-password block list; audit `login_failed` | `security/rate-limit.test.ts`, `security/login-bruteforce.test.ts` (N failures → 429 + Retry-After, backoff grows, success after window) |
| S-02 | Account enumeration through response differences or timing on register/login/forgot/resend | Uniform `202`/`401` bodies; dummy Argon2 verification on unknown accounts; identical side effects (always an email to a registered address) (R-AUTH-07) | `security/enumeration.test.ts` (bodies byte-identical; hasher spy proves exactly one verify per request in both branches); nightly non-CI timing comparison |
| S-03 | Replay of a stolen refresh token | Rotation on every use; reuse of a rotated token revokes the whole session and audits `refresh_reuse_detected` (R-AUTH-04) | `security/refresh-rotation.test.ts` |
| S-04 | Use of a stolen access token | TTL ≤ 15 min; `Cache-Control: no-store`; immediate invalidation when the session is revoked | `security/sessions.test.ts` (token of a revoked session → 401 on the next request), `unit/accounts/token-ttl.test.ts` |
| S-05 | Token guessing / forgery | 256-bit CSPRNG tokens, SHA-256 lookup, prefixes, constant-time compare (ADR-0004) | `unit/crypto/tokens.test.ts` (length, alphabet, uniqueness over 10⁵ samples, hash-only storage) |
| S-06 | Reuse or late use of verification / reset tokens | Single use (`used_at`), ≤ 30 min, newest token invalidates older ones (R-AUTH-03) | `security/one-time-tokens.test.ts` (second use → 401; expired → 401 with injected clock; superseded → 401) |
| S-07 | Password-reset flow abused to take over an account | Token only reaches the registered email; reset revokes **all** sessions; notice email; rate-limited | `security/password-reset.test.ts` |
| S-08 | Attacker with a hijacked session changes the email to lock out the owner | Recent re-auth required (R-AUTH-06); new address must be verified; notice to the old address; old address can still log in until confirmed | `security/email-change.test.ts`, `security/reauth.test.ts` |
| S-09 | Session fixation / token confusion between sessions | All tokens server-generated and bound to `session_id`; refresh only rotates within its own session | `security/sessions.test.ts` |
| S-10 | Spoofed `X-Forwarded-For` to evade per-IP limits or poison audit IP prefixes | `trustProxy` set to the exact hop count of the edge; headers beyond that are ignored | `security/trust-proxy.test.ts` |
| S-11 | Phishing-style content injected into our emails | Templates contain only static text + link with token; link base URL from config; no user-supplied text in emails | `unit/email/templates.test.ts` |
| S-12 | Login before email ownership is proven (account squatting of someone else's address) | Login blocked until verified (R-AUTH-09); unverified accounts purged after 7 days | `security/login-unverified.test.ts`, `integration/retention.test.ts` |

### 3.2 Tampering (integrity)

| ID | Threat | Mitigation | Test |
|----|--------|-----------|------|
| T-01 | BOLA/IDOR: user A modifies or deletes user B's achievement/quest/check-in/session/consent | Every repository call scoped by `user_id`; RLS second layer; `404` for foreign objects (R-AUTHZ-02/03) | `security/ownership.test.ts` — generated from the OpenAPI document: for **every** operation with a path ID, A creates, B attempts GET/PATCH/DELETE/POST-child → 404 and no change |
| T-02 | Mass assignment: client supplies `xp`, `status: completed`, `completed_at`, `user_id`, `version`, `created_at` | Strict Zod schemas (`additionalProperties: false`), allowlisted fields only (R-AUTHZ-04) | `security/mass-assignment.test.ts` (each forbidden field → 400, state unchanged) |
| T-03 | SQL injection | Drizzle parameterized queries only; ESLint bans `sql.raw`/string concatenation into SQL; RLS limits blast radius | `security/injection.test.ts` (SQL meta-characters in every string field round-trip unchanged), `ci` lint rule |
| T-04 | Prototype pollution / constructor poisoning via JSON | Fastify `onProtoPoisoning: 'error'`, `onConstructorPoisoning: 'error'`; Zod strict | `security/proto-pollution.test.ts` |
| T-05 | Ciphertext tampering or swapping between rows/users/fields by someone with DB write access | AEAD tag; AD binds user ID + record ID + field (ADR-0006) → decryption fails closed (generic 500, alert) | `unit/crypto/aead.test.ts`, `integration/encryption-at-rest.test.ts` (swap two rows' ciphertext → request fails, nothing decrypted) |
| T-06 | XP double-award via retries or concurrent check-ins | Effects engine runs under `SELECT … FOR UPDATE` on quest + achievement; idempotency keys; append-only ledger (R-XP-01) | `integration/xp-exactly-once.test.ts` (20 parallel identical requests → one award; parallel distinct check-ins → consistent totals) |
| T-07 | Lost updates between two devices | `version` + `If-Match`, `409` on mismatch, `428` when missing (ADR-0008) | `integration/concurrency.test.ts` |
| T-08 | Prerequisite cycles or cross-achievement prerequisites to corrupt lock logic | Service validation (same achievement, acyclic, depth ≤ 20) | `unit/quests/prerequisite.test.ts`, `integration/quests.test.ts` |
| T-09 | Manipulated `local_date` (future / far past) to fabricate streaks | Validation against today in the account timezone; ≤ 7 days back-dating, and back-dated check-ins never count (R-CHK-04) | `integration/check-ins.test.ts` with injected clock and `Europe/Zurich` DST dates |
| T-10 | Malicious or vulnerable dependency (typosquat, compromised release) | Lockfile, `npm ci`, minimal deps, `osv-scanner`, Semgrep, dependency review in reports (R-SUP-01/02) | `ci` gates; `supply-chain/dependency-allowlist.test.ts` (runtime deps must be in the documented allowlist, architecture §7; exact versions; no payment SDK) |
| T-11 | Tampered container image | Images built in CI, digest-pinned deployments, Trivy scan, SBOM | `ci` |
| T-12 | Schema changes or DDL through the app connection | `questline_app` has no DDL rights; migrations by a separate role in a separate job (ADR-0003) | `security/db-roles.test.ts` |
| T-13 | Idempotency key reused with a different body to overwrite/replay | Request hash compared; mismatch → 422 | `integration/idempotency.test.ts` |
| T-14 | Tampered pagination cursor | Cursor parsed with Zod, rejected → 400; even a valid cursor from A yields only B's rows under B's scope | `integration/pagination.test.ts` |
| T-15 | Edits to habit/target parameters to retroactively "complete" quests and farm XP | Allowed by design (goals change), but XP is awarded once per completion transition and revoked on un-completion; deletion revokes XP (Q-12) | `integration/quest-edit-effects.test.ts` |
| T-16 | XP farming through pause/resume or reset loops (complete quests → pause → resume → complete again) | Pause revokes all XP of the attempt (R-ACH-06); rank bonus only on unlock, reverted on undo; gambles cannot be re-placed after a loss on the same attempt | `integration/pause-reset.test.ts` (net XP after N loops = XP of one honest run) |
| T-17 | Gamble manipulation: stake inflated via client, placed after the fact, cancelled, or settled twice | Stake computed server-side from the ledger at placement; one pending gamble per achievement (partial unique index); no cancel endpoint; settlement under `FOR UPDATE`, idempotent by `status` transition | `integration/gamble.test.ts`, `security/mass-assignment.test.ts` (client `stake`/`status` → 400) |
| T-18 | Rank/score manipulation via back-dated check-ins, timezone changes or clock skew | Back-dated check-ins never count (R-CHK-04); "today" computed server-side in the account timezone; timezone changes re-bucket nothing retroactively (A-23); score uses server-recorded resets/gambles only | `unit/domain/rank.test.ts`, `integration/check-ins.test.ts` |

### 3.3 Repudiation

| ID | Threat | Mitigation | Test |
|----|--------|-----------|------|
| R-01 | A user disputes a login, password change, export or deletion; investigating an account takeover | `audit_events` with event type, outcome, truncated IP, client, session ID (R-LOG-03); shown nowhere but export; 90-day retention | `integration/audit.test.ts` (each flow writes exactly the expected event; no email/token/content in metadata) |
| R-02 | Operator actions are untraceable | No admin endpoints exist; infrastructure access is logged by the provider (M6 runbook) | n/a (process control, documented) |
| R-03 | Logs altered after an incident | Logs shipped to provider log storage append-only (M6) | n/a (infrastructure) |
| R-04 | Dispute over whether consent was given for goal content | Consent version + timestamps stored; withdrawn consents kept while the account exists (R-PRIV-04) | `integration/consent.test.ts` |

### 3.4 Information disclosure

| ID | Threat | Mitigation | Test |
|----|--------|-----------|------|
| I-01 | Database dump / backup leak exposes goal content and emails | Field-level envelope encryption, encrypted email + blind index, hashed tokens, Argon2id (R-ENC-01/02) | `integration/encryption-at-rest.test.ts` (dump every table as raw bytes; assert no seeded plaintext appears) |
| I-02 | Logs contain passwords, tokens, emails, goal content or bodies | Allowlist log serializers, pino redaction, no body logging (R-LOG-02) | `security/log-leakage.test.ts` (captures all logs of the entire run, scans for every seeded secret/value) |
| I-03 | Error responses leak stack traces, SQL, paths | RFC 9457 problems with static text; generic 500 (ADR-0007) | `contract/problem-details.test.ts` (fuzzed malformed requests; body matches schema; forbidden substrings absent) |
| I-04 | Cross-user read of objects or lists | Scoping + RLS; lists filtered by `user_id`; 404 for foreign IDs | `security/ownership.test.ts`, `security/rls.test.ts` |
| I-05 | Existence of an account revealed by `403 email-not-verified` on login | Only returned when the password is correct (the caller already proved knowledge) — accepted, documented | `security/enumeration.test.ts` (wrong password on unverified account → identical 401) |
| I-06 | Email-change reveals whether the new address is registered | Uniform `202`; owner of the existing address gets a notice | `security/enumeration.test.ts` |
| I-07 | Authenticated responses cached by intermediaries or the OS | `Cache-Control: no-store`, `Pragma: no-cache` (R-TLS-02) | `security/headers.test.ts` (every authenticated route from the spec) |
| I-08 | Traffic interception | TLS 1.2+/1.3 at the edge, HSTS preload, DB `sslmode=verify-full`, client pinning recommendation (M6) | `security/headers.test.ts`, `unit/config.test.ts` (production refuses non-TLS DB URLs), `e2e/tls.test.ts` against staging |
| I-09 | Offline email guessing against the blind index | Separate HMAC key in the secret store, never in the DB; documented rotation | residual (see §4) |
| I-10 | Timing side channel on token/secret comparison | `sodium_memcmp` / `crypto.timingSafeEqual` everywhere; hashes compared, not plaintext (R-TLS-04) | `src/platform/crypto/compare.test.ts` + Semgrep rule banning `===` on token variables |
| I-11 | DEKs exposed via memory dumps or swap | `sodium_malloc` guarded buffers, `sodium_memzero` on eviction, cache TTL ≤ 5 min, no DEK in logs | `unit/crypto/key-service.test.ts` (eviction zeroes buffer; cache misses after TTL) |
| I-12 | Bulk exfiltration through the export endpoint with a stolen session | Recent re-auth, 2 exports / 24 h, audit event (R-PRIV-05) | `security/export.test.ts` |
| I-13 | Idempotency replay returns another user's stored response | Keys scoped to (user, route); stored response encrypted with the user's DEK | `integration/idempotency.test.ts` |
| I-14 | `403` vs `404` discloses existence of other users' objects | Always `404` | `security/ownership.test.ts` |
| I-15 | Health endpoints leak versions or dependency details | Body limited to `{status}` | `contract/health.test.ts` |
| I-16 | SMTP relay operator sees addresses and tokens | Necessary processor under DPA (PM approval, `processors.md`); tokens single-use, ≤ 30 min; emails contain no goal content | `unit/email/templates.test.ts`, `docs/privacy/processors.md` |
| I-17 | 1Password holds the KEK | The KEK is stored end-to-end encrypted in the 1Password vault and fetched once by the private Connect server; DEK unwrap happens in-process, so 1Password never sees DEKs or field data; Connect access logged (ADR-0013) | documented; `unit/crypto/kek-source.test.ts` |
| I-18 | Backups readable after account deletion | Wrapped DEK deleted with the user; backups expire after 30 days; tombstone replay after restore (ADR-0006, Q-13) | `integration/account-deletion.test.ts`, M6 restore drill checklist |
| I-19 | Rate-limit storage reveals IPs/emails | Bucket keys are HMACs with a daily-rotated key (Q-14) | `unit/rate-limit/keys.test.ts` (no raw subject persisted; keys differ per day) |
| I-20 | Goal content in push notifications | No server push in v1; client guidance (M6) | n/a |
| I-21 | SSRF via user-supplied URLs | No feature fetches user URLs; Semgrep rule flags `fetch`/`http.request` with non-constant URLs | `ci` SAST |
| I-22 | Verbose validation errors echo submitted values (e.g. a password that failed policy) | Static messages + JSON pointers only | `contract/problem-details.test.ts` |

### 3.5 Denial of service

| ID | Threat | Mitigation | Test |
|----|--------|-----------|------|
| D-01 | Flooding auth endpoints to exhaust CPU with Argon2id | Per-IP/per-account limits before hashing; bounded hashing concurrency (semaphore) → `503`/`429` instead of collapse | `security/rate-limit.test.ts`, `src/platform/crypto/semaphore.test.ts` + `password.test.ts` (queue overflow refused), M6 load test |
| D-02 | Oversized or deeply nested bodies | `bodyLimit` 64 KiB (`413`), JSON only (`415`) | `contract/problem-details.test.ts`, `contract/body-errors.test.ts` (413/415, documented on every operation with a body); deep nesting: `security/limits.test.ts` (M2) |
| D-03 | Unbounded collections per user | ≤ 200 achievements, ≤ 50 quests/achievement, ≤ 50 check-ins/quest/day, ≤ 20 sessions (A-09) | `integration/limits.test.ts` |
| D-04 | Locking a victim out through per-account backoff | Backoff capped (15 min), per-IP limits hit first; victim notified of unusual failures only via audit/export | `security/rate-limit.test.ts` (legitimate login from another IP succeeds after cap) |
| D-05 | Email bombing via resend/forgot/email-change | Per-account 3 emails / h, per-IP limits, outbox dedupe of identical pending templates | `security/email-abuse.test.ts` |
| D-06 | DB connection or query exhaustion | Pool ≤ 10/instance, `statement_timeout` 5 s, `idle_in_transaction_session_timeout` 10 s, indexes for every pagination path | `integration/db-config.test.ts` |
| D-07 | Outbox / retention job starvation or runaway | Batch sizes, exponential backoff, dead-lettering, advisory locks | `integration/outbox.test.ts`, `integration/retention.test.ts` |
| D-08 | ReDoS through validation patterns | Only bounded, linear patterns; `eslint-plugin-regexp` | `ci` lint; `unit/validation/patterns.test.ts` (adversarial inputs complete < 5 ms) |
| D-09 | Export endpoint used to generate load | 2 / 24 h per user; data volume bounded by D-03 | `security/export.test.ts` |
| D-10 | Health endpoints hammered | Per-IP limit, trivial handlers | `security/rate-limit.test.ts` |

### 3.6 Elevation of privilege

| ID | Threat | Mitigation | Test |
|----|--------|-----------|------|
| E-01 | Unauthenticated access to a protected route (forgotten guard) | Global auth hook; routes opt **out** via an explicit allowlist that must match the spec's `security: []` | `security/deny-by-default.test.ts` (every operation in the OpenAPI document without `security: []` → 401 without token; allowlist equals the spec) |
| E-02 | Continued access after logout, revocation, password change or reset | Token lookup per request; revocation deletes tokens | `security/sessions.test.ts`, `security/password-change.test.ts` |
| E-03 | Sensitive operation without recent authentication | Re-auth guard (A-07) on email change, password change, export, deletion | `security/reauth.test.ts` (fresh login OK; after 10 min + 1 s → 403; after `reauth` OK) |
| E-04 | Client-controlled status/XP/ownership | see T-02 | `security/mass-assignment.test.ts` |
| E-05 | App role bypasses RLS or alters schema | `NOBYPASSRLS`, `FORCE ROW LEVEL SECURITY`, DML-only grants | `security/rls.test.ts`, `security/db-roles.test.ts` |
| E-06 | Container breakout / privilege escalation on the host | Non-root UID, read-only root FS, no shell in distroless image, dropped capabilities, Trivy | `e2e/smoke.test.ts` (uid ≠ 0, write to `/app` fails, no shell, no package manager), `ci` |
| E-07 | Secrets committed or baked into images | gitleaks (CI + pre-commit), `.dockerignore`, env-only config | `ci`, `unit/config.test.ts` |
| E-08 | Service starts with weak/missing secrets or dev crypto in production | Startup validation (R-SUP-04) | `unit/config.test.ts` (each missing/weak variable → refuses to start; `KEK_SOURCE=env` in production → refuses, R-SUP-04) |
| E-09 | Worker code path used for cross-user access from the API | Worker role credentials only in the worker process; dependency-cruiser forbids API modules importing retention code | `ci` (dependency-cruiser), `security/db-roles.test.ts` |
| E-10 | Goal content created without consent | Consent guard on create endpoints (R-PRIV-04) | `security/consent.test.ts` |
| E-11 | Compromise of the 1Password Connect server or its token yields the KEK (ADR-0013) | Connect server in the private network only; token scoped to one vault, rotated with the KEK; KEK fetched once at startup and held in guarded memory; startup refused if Connect is unreachable; access logged | `unit/crypto/kek-source.test.ts`, M6 runbook (rotation drill) |
| E-12 | Stolen SMTP relay credentials used to send phishing as Questline | Credentials only in 1Password/env, TLS-only transport, dedicated sending sub-domain with DMARC `p=reject`, outbox rate limits | `unit/email/smtp-sender.test.ts`, `unit/config.test.ts` |
| E-13 | Deactivated (pending deletion) account used or reactivated by an attacker | All sessions/tokens revoked at deactivation; reactivation only by password login (rate-limited, audited) and notice email to the user; no other endpoint accepts the account | `security/deactivation.test.ts` |

## 4. Residual risks (accepted for v1, revisited each milestone)

| ID | Risk | Why accepted | Review |
|----|------|-------------|--------|
| RR-1 | Compromised app server can decrypt data of **all** users (the KEK is in process memory because it is sourced from 1Password Connect instead of a KMS — PM decision Q-02, ADR-0013) | Accepted by PM; mitigated by hardening, private Connect server, rotation; a KMS adapter can replace it later | E2E encryption evaluation for v2 (§2); revisit when hosting is chosen |
| RR-2 | Structural metadata (check-in dates, counts, statuses, ranks, scores) is plaintext | Needed for progress/streak engine and pagination; low sensitivity alone | DPIA R-5 (`target_date` encrypted since Q-24) |
| RR-3 | Deterministic blind index allows email guessing with DB + key | Required for login lookup/uniqueness; key kept outside the DB | Key rotation runbook (M6) |
| RR-4 | Backups within 30 days may hold deleted users' ciphertext + wrapped DEK | Reading them requires the KEK (1Password, app memory); tombstone replay after restore (Q-13) | Restore drill in M6 |
| RR-5 | Per-account rate limiting can be used to slow a victim's login | Capped backoff, per-IP limits first | Consider device-bound trust signals in M5 (passkeys) |

## 5. Abuse cases exercised by the security test layer

1. XP farming: complete → undo → complete loops; create/complete/delete loops; editing targets to auto-complete.
2. Mass account creation and email bombing from one IP / against one address.
3. Token theft: refresh replay, access token after logout, token from a deleted account.
4. Device loss: user revokes a session from another device; attacker's in-flight refresh fails.
5. Malicious insider with DB access: raw rows reveal no content; swapped ciphertext fails closed.
6. Hijacked session attempts email change, export and deletion without re-auth.
7. Client manipulates `local_date`, `version`, `status`, `xp`, `user_id`.
8. Operator restores a backup: tombstone replay removes deleted users again.
