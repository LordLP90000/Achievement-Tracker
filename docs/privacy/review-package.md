# Review package for the data-protection expert (M6)

Status: 2026-11-05. Complete except the privacy policy, the consent texts and the controller's identity, which the
PM provides (O-04, DPIA open items 3 and 5). Questline has not launched: no real personal data has been processed.

## 1. Questline in brief

A goal-tracking app (iOS and Android) with this backend: users set achievements, break them into quests and record
check-ins; XP, levels, streaks and ranks reward progress. The controller is Swiss; the app is offered in German,
French, Italian and English to people aged 13 or older in Switzerland and the EU, so both the FADP and the GDPR apply
(requirements §4). Goals may reveal health data. No analytics, no advertising, no third-party SDKs (R-PRIV-02).

## 2. The documents

| Document | What it holds | Status |
|----------|---------------|--------|
| `docs/privacy/dpia.md` | The DPIA: necessity, the processing, risks R-1 to R-17 with measures and residual risk, open items | v0.6 |
| `docs/privacy/data-inventory.md`, `data-inventory.yaml` | Every data category (C1–C15): purpose, legal basis, retention, export and deletion; a test fails when a table or column holding user data is missing from it | v2, reviewed in M6 |
| `docs/privacy/processors.md` | 1Password (holds the key-encryption key, no personal data) and the SMTP relay | host and relay not yet named (O-01, O-02) |
| `docs/security/threat-model.md` | STRIDE threats, each with its mitigation and an automated test; accepted residual risks RR-1 to RR-8 | current as of M6 |
| `docs/runbooks/breach.md` | Breach notification to the FDPIC and the EU authorities, and to the people concerned | new in M6 |
| `docs/runbooks/restore.md` | Restoring a backup, then deleting again what users deleted and re-applying what they changed since (Q-13, Q-57) | M6, rehearsed |
| `docs/runbooks/key-rotation.md` | Rotating the key-encryption key and the blind-index key | M6, rehearsed |
| `docs/runbooks/operations.md` | Running the service: processes, releases, what to watch, background jobs | M6 |
| `docs/requirements.md` §4 and §6 | The privacy requirements and every product decision with its date | current |
| `docs/client-security.md` | What the apps must do: secure storage, no content in notifications | M4 |
| `docs/architecture.md`, `docs/DECISIONS.md` | How the data flows and is protected; the architecture decisions | current |
| The API reference (`npm run docs:api`; a CI artifact of every commit) | Every operation of the API, including export, consent and deletion | current |

## 3. The evidence

- **Automated tests on every change**: 2 270 tests (unit, integration, contract, security), 98.9 % of statements
  and 96.9 % of branches covered; mutation testing of the domain, cryptography and passkey code (`platform/crypto`:
  every mutant detected).
- **Privacy in particular**: the inventory guard (`test/privacy/data-inventory-guard.test.ts`); no address, nickname,
  device label, password, token or goal content readable in any table (`test/integration/encryption-at-rest.test.ts`);
  the hard delete of an account, table by table (`test/integration/account-deletion.test.ts`); the export
  (`test/privacy/export.test.ts`, `test/security/export.test.ts`); consent and its withdrawal
  (`test/integration/consents.test.ts`, `test/security/consent.test.ts`); no personal value in any log line
  (`test/security/log-leakage.test.ts`).
- **Drills in the built image on every CI run** (`test/e2e/smoke.test.ts`): a restore with the replay, a KEK rotation
  and a blind-index key rotation.
- **Load test and DAST** (2026-11-05, local stack): the limits per user, per client and on wrong passwords hold
  under bursts, and ordinary use meets none; a
  ZAP API scan, passive and active and signed in, reached every operation, raised no high alert and caused no server
  error. Its one low warning is by design: the export shows the user their own truncated network prefix.
- **Supply chain in CI**: static analysis (Semgrep), vulnerable dependencies (osv-scanner), the container image
  (Trivy, with SBOMs), secrets in the history (gitleaks).

## 4. Questions for the expert

1. **Minimum age 13, self-declared** (DPIA R-12, open item 2): is the consent of 13- to 15-year-olds valid where an
   EU member state sets the age of digital consent higher (GDPR Art. 8)? What should the terms say?
2. **Gambling-like mechanics** (R-15): XP stakes without money or chance; the PM's product review (Q-32) keeps them
   for every user aged 13 or older. Acceptable for minors?
3. **Goal content as possible health data** (R-4): explicit, unticked, versioned consent before any content is
   stored, withdrawal deletes the content (R-PRIV-04). Enough under GDPR Art. 9(2)(a) and FADP Art. 6 para. 7?
4. **Erasure** (R-6, R-16): an account is deactivated at once and hard-deleted after 30 days (Q-11), with its data
   key (crypto-shredding); backups expire after 30 days, and after a restore the replay deletes again every account
   deleted since (Q-13, Q-57). Enough for GDPR Art. 17 and FADP Art. 32?
5. **Breach notification** (`docs/runbooks/breach.md`): are its legal statements right? Without an EU establishment,
   is an EU representative needed (GDPR Art. 27), and which authorities must be notified? Does a leaked database
   without keys — pseudonymous activity data and ciphertext — need an EU notification?
6. **Retention** (data inventory §3): audit events 90 days, tombstones 35 days, dead letters 7 days, unverified
   accounts 7 days. Appropriate?
7. **Processors** (R-7, R-9): once the PM names the host and the SMTP relay; a US relay would receive addresses
   and one-time links only.
8. **Passkeys and two-step sign-in** (R-17, open item 8): an account whose owner loses every authenticator and
   recovery code stays locked; how should the privacy policy describe it?

## 5. Not in this package

- The privacy policy, the consent texts and the controller's identity (O-04; DPIA open items 3 and 5).
- The host and the SMTP relay (O-01, O-02), and so the staging deployment and its tests.