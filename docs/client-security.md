# Client security guidance for the Questline app

Status: M5, 2026-11-04 (§6: passkeys and two-factor sign-in, ADR-0019); first written in M4, 2026-11-02 — brought
forward from M6 for the app team (Q-45). Aligned with OWASP MASVS v2; the category
of each section is in brackets. The backend never trusts the app (threat model §1): every rule there is enforced
server-side. This document covers what only the app can protect — the user's data on the device and in transit
(threat model §2 "compromised client device", DPIA R-11) — and how the app uses the API so that users' data stays
correct. The contract is [`openapi/openapi.yaml`](../openapi/openapi.yaml), frozen since `0.3.0` and grown only additively since.

## 1. Tokens and sessions [MASVS-STORAGE, MASVS-AUTH]

- **Lifetimes** (R-AUTH-10): the access token lives 15 minutes, the refresh token 30 days from its last use, a session
  at most 180 days. Both tokens are opaque random strings (`ql_at_…`, `ql_rt_…`); never parse them.
- **Storage**: only in the platform's secure store — on iOS the Keychain with
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (or `…WhenUnlockedThisDeviceOnly` if the app never refreshes in
  the background); on Android encrypted with a non-exportable AES-GCM key from the Android Keystore (StrongBox when
  available) in app-private storage. Never in plain preferences, files, logs, the clipboard or crash reports.
- **Backups**: the `ThisDeviceOnly` classes keep tokens out of iOS backups and device migrations; on Android exclude
  the token store from backup and device transfer (`dataExtractionRules`). A restored device logs in again.
- **Refresh exactly once at a time.** Each refresh rotates the refresh token; presenting a rotated token again —
  also two refreshes sent in parallel — counts as theft and **ends the session** (R-AUTH-04, S-03). Funnel every
  refresh through one single-flight call that the other requests wait for, store the new refresh token before using
  the new access token, and on a `401` from `POST /auth/refresh` clear both tokens and go to login.
- **On `401` from any other call**: refresh once (single-flight), repeat the call once, then log in again.
- **Logout** calls `POST /auth/logout` (or `POST /auth/logout-all`) and deletes the tokens locally even when offline.
  Show `GET /me/sessions` with the device label (Q-09) so the user can end a lost device's session; a password change
  ends every other session, a password reset all of them (R-AUTH-05). A 21st login ends the least recently used
  session (Q-29).
- **Biometrics** may gate opening the app or reading the tokens (Keychain access control, `BiometricPrompt`), but they
  never replace the password or a passkey where the API asks for them (§5, §6).

## 2. Network [MASVS-NETWORK]

- HTTPS only, TLS 1.2 or newer with the platform's verification: no App Transport Security exceptions on iOS,
  `cleartextTrafficPermitted="false"` in Android's Network Security Config, no custom trust managers or hostname
  verifiers (R-TLS-01, I-08).
- **Pinning (recommended)**: pin the SHA-256 of the SubjectPublicKeyInfo of at least two keys — the current one and a
  backup that is not deployed yet — with the platform mechanism (`NSPinnedDomains` on iOS 14+, `<pin-set>` with an
  `expiration` on Android), so a key rotation never bricks the app. The pins follow once the hosting and the domain
  are known (O-01, Q-19); until then the app relies on the system trust store.
- Cleartext only for the local stack, and only in debug builds (`<debug-overrides>` on Android, a debug-only ATS
  exception for `localhost` on iOS) — never in a release build.
- Responses carry `Cache-Control: no-store` (R-TLS-02): keep it that way in any HTTP cache layer of the app.

## 3. Data on the device, screenshots and notifications [MASVS-STORAGE, MASVS-PLATFORM, MASVS-PRIVACY]

Goal content can be health-related (DPIA): titles, descriptions, motivations, categories, target dates, notes,
target values and check-in notes are encrypted at rest on the server — the device must not undo that.

- Cache as little as possible. An offline cache lives in app-private storage under the strongest data protection that
  still works (iOS `NSFileProtectionComplete` where possible; on Android encrypted with a Keystore key), outside
  backups, and is deleted at logout, account deletion and consent withdrawal (§5).
- **`is_private`** is the user's wish to keep an Achievement out of sight (DPIA R-11): show its title nowhere outside
  the app — no widget, Spotlight or search index, share preview or notification — and blank it in the app switcher.
- **Screenshots and the app switcher**: cover the content when the app goes to the background (iOS: an overlay before
  the snapshot is taken; Android: `FLAG_SECURE` on screens with private content, or everywhere if the user wishes).
  iOS cannot block screenshots; it can hide content while `UIScreen.isCaptured` is true.
- **Notifications** (I-20): there is no server push in v1. Local reminders carry generic text only ("Time for
  today's check-in") — never an Achievement or Quest title, a note or a value — and stay hidden on the lock screen
  where the platform allows.

## 4. Using the API correctly [MASVS-CODE]

- **Problems**: errors are RFC 9457 problem details (`application/problem+json`). Branch on `type`
  (`urn:questline:problem:<slug>`), never on `title` or `detail`, and show your own localized text. Validation errors
  list JSON pointers, never the values sent.
- **Additive contract**: ignore properties and enum values you do not know yet — the contract only grows (Q-45).
- **`Idempotency-Key` on every create** (achievement, quest, check-in, gamble; ADR-0008): a new UUID v4 per user
  action, kept with the pending request and **sent again on every retry of that action** (timeouts, lost
  connections). A replay answers like the first success with `Idempotency-Replayed: true`. Only successes are stored
  (Q-39): after a `403`, `409` or `422` fix the cause and retry with the same key. The same key with another body →
  `422 idempotency-key-reused`; a new action needs a new key.
- **`If-Match` on every change** (ADR-0008, T-07): send the `ETag` (`"<version>"`) of what the user saw. Without it →
  `428`; when someone changed it meanwhile → `409 version-conflict` with `current_version`: reload, show the user the
  current state and let them decide — never resend automatically with the new version, which would overwrite the
  other change.
- **Effects come from the server**: every change answers with its effects — XP gained or lost, total and level,
  unlock or re-lock, rank and execution score, a gamble won, lost or reverted. Show those; never compute XP, levels,
  ranks or gamble outcomes in the app. Any response may also report a habit reset or a gamble lost since the last
  request (A-21).
- **Dates are the account's**: `local_date` and "today" follow the account's time zone (`GET /me`), not the device's.
  When the user travels, offer to update it (`PATCH /me`). Check-ins may be back-dated up to 7 days but then never
  count (R-CHK-04).
- **Undo** a check-in only on the day it was made, in the account's time zone (Q-36); later →
  `409 check-in-final`. Hide the undo once that day is over.
- **Gambles** stake XP only — never money, purchases or anything with real-world value (R-GMB-05, Q-32). Show the
  rules before placing one: double or nothing on unlocking by the target date, at most one pending, never
  cancellable, a loss never lowers the level, and no win pays for an Achievement unlocked within 7 × 24 h of its
  creation (Q-31, A-34). While it is pending, the Achievement's target date is fixed and no quest change may ask for
  less — deleting or demoting an open required quest, a target brought closer, a habit not yet begun made smaller
  (`409 gamble-pending`, A-26, Q-44, Q-47): say so before the user places it, and explain the `409` when it comes.
- **Rate limits** (R-AUTH-08, A-31, Q-30): every operation may answer `429` with `Retry-After` (seconds). Wait at
  least that long, back off exponentially with jitter, never retry in a tight loop; after repeated wrong passwords
  show the wait instead of retrying.
- Pagination cursors are opaque: pass them back unchanged (at most 100 items per page). Request bodies are JSON,
  at most 64 KiB (R-IN-01).

## 5. Sensitive operations [MASVS-AUTH, MASVS-PRIVACY]

- **Re-authentication window** (R-AUTH-06, E-03): changing the email or the password, the data export, the account
  deletion and changes of passkeys or TOTP need a re-authentication within the last 10 minutes. Call
  `POST /auth/reauth`, then run the operation; on `403 reauthentication-required` ask again. Never store the password
  to do this silently. Offer the account's passkey first where there is one: `POST /auth/passkey/options`, the
  platform's passkey API, then `{ passkey }` — no code needed (ADR-0019). With the password and TOTP on (`GET /me`:
  `two_factor_enabled`), send the app's code (or a recovery code) along with it; `401 second-factor-required` means one was missing — ask for it and
  send both again.
- **Consent** (R-PRIV-04, Q-10): goal content needs the explicit, unticked `goal_content` consent, given in the app
  with the consent text's version (`POST /me/consents`; text: O-04). Withdrawing it deletes **all** goal content at
  once, completed Achievements included, and cannot be undone: confirm with the user first, then clear the cache.
- **Export** (R-PRIV-05, M4): `GET /me/export` after re-authentication, at most 2 per 24 hours; the JSON file holds
  all of the user's data. Hand it to the system's share sheet or document picker without keeping a copy in the app.
- **Account deletion** (R-PRIV-06, Q-11, A-22, M4): explain before the user confirms that signing in again within 30
  days — with the password (and its code when TOTP is on) or a passkey — cancels the deletion, and that afterwards
  everything is gone for good. After re-auth, `DELETE /me` answers `202` with `deletion_scheduled_for` and ends
  **every** session, this one included: clear the tokens and all local data, and show the date. Until then a sign-in
  brings the account back, and so does a password reset through the emailed link if the password is forgotten (Q-48):
  say both before the user confirms.

## 6. Passkeys and two-factor sign-in [MASVS-AUTH]

Both are optional and the user's choice (M5, ADR-0019); the password stays, and a password reset keeps both, so a
taken-over mailbox alone removes neither.

- **Prefer passkeys.** They are bound to Questline's domain and cannot be phished, guessed or reused elsewhere
  (threat model S-13); a TOTP code can be relayed by a fake site in real time (RR-7). The platform's passkey APIs
  (iOS `ASAuthorizationPlatformPublicKeyCredentialProvider`, Android Credential Manager) need the domain association
  on the relying party's domain (Q-51): `webcredentials` in `apple-app-site-association`, and in `assetlinks.json` the
  `get_login_creds` permission for each app signing key, whose hash is also one of the server's allowed origins.
- **Creating one** (re-authenticated, §5): `POST /me/passkeys/options` → the platform's create call → `POST
  /me/passkeys` `{ credential, name? }`. At most 10 per account (`422 limit-reached`); a passkey the account already
  has is refused (`422 invalid-passkey`). `GET /me/passkeys` lists them with name, last use and `backed_up` (synced by
  the platform, so it outlives the device); removing one needs re-authentication.
- **Signing in with one**: `POST /auth/passkey/options` names no account; pass the options to the platform, which
  offers the user's passkeys; send the result to `POST /auth/passkey/login` `{ credential, client, device_label? }`.
  Any failure is the same `401 invalid-credentials`: say only that it did not work, and offer the password. A passkey
  needs no TOTP code — it already is two factors (the device and its unlock).
- **Turning TOTP on** (re-authenticated): `POST /me/totp` returns the secret once, as an `otpauth://` URI for a QR
  code and as base32 for typing in; keep it on screen only (§3: covered in the app switcher, no clipboard, no logs),
  then `POST /me/totp/confirm` `{ code }` with the authenticator app's current code. A secret not confirmed within
  24 hours is gone (`409 totp-not-started`: start again, Q-53).
- **Recovery codes**: confirming answers 10 codes, once; so does `POST /me/recovery-codes`, which voids the old ones.
  Let the user save them outside the app (the share sheet to a password manager, or print) and never keep them in the
  app. Say it plainly: **losing the authenticator with no code left locks the account for good** — no one can help,
  and only a request to the controller can erase it (Q-52, RR-6, DPIA R-17). `GET /me` shows `two_factor_enabled` and
  `recovery_codes_left`: suggest new codes when few are left. Each code works once.
- **Signing in with TOTP on**: after the correct password, `POST /auth/login` answers `202` with a
  `second_factor_token`, its lifetime `expires_in` and the `methods` to offer (`recovery_code` only while codes are
  left). Keep the token in memory only and send it with the app's code or a recovery code to `POST
  /auth/login/second-factor` (`client`, `device_label?`). A wrong code → `401 invalid-credentials`, ask again; after 5
  wrong codes, or once it expired → `401 invalid-token`: start again with the password. Wrong codes count against the
  sign-in backoff like wrong passwords (`429`).
- **Turning TOTP off** (`DELETE /me/totp`, re-authenticated) deletes the secret and the recovery codes.
- **Every change** — a passkey added or removed, TOTP on or off, new recovery codes, a recovery code used — sends the
  owner a notice without a link (A-33), so a change the user did not make stands out.

## 7. Email links [MASVS-PLATFORM]

Verification, password-reset and email-change links have the form `<base>/verify-email#token=…`,
`/reset-password#token=…` and `/confirm-email-change#token=…` (A-32): the token sits in the fragment, which never
reaches a server. Handle them as Universal Links / Android App Links with verified domain association
(`apple-app-site-association`, `assetlinks.json` with `autoVerify`) on the production domain (Q-19), and post the
token to `POST /auth/verify-email`, `POST /auth/password/reset` or `POST /me/email-change/confirm`. Never log the link
or put it on the clipboard. Security notices never contain a link (A-33): a "notice" with a link is phishing.

## 8. Third-party code and logs [MASVS-CODE, MASVS-PRIVACY]

- No third-party analytics, trackers, advertising or attribution SDKs and no crash reporters (R-PRIV-02); any SDK
  needs the PM's approval first (R-PRIV-03).
- App logs never contain tokens, passwords, email addresses or goal content; release builds log nothing beyond
  errors without user data.
- The app binary contains no secrets (the API needs none). WebViews, if any, get no JavaScript bridge to tokens.
- Jailbreak and root detection are optional (MASVS-RESILIENCE): the backend does not rely on the device.

## 9. Local development

The local stack (README, "Local stack for the app team") serves the API on `127.0.0.1:3000` and the mail catcher on
`127.0.0.1:8025`, on the developer's machine only. The iOS simulator reaches it directly; the Android emulator at
`10.0.2.2`; a USB-connected Android device after `adb reverse tcp:3000 tcp:3000`. It holds made-up data only — never
use real addresses or real goals (R-SUP-05).

## 10. Traceability

| Guidance | Backend control | Backend tests |
|----------|-----------------|---------------|
| Single-flight refresh (§1) | Rotation; reuse of a rotated refresh token ends the session (R-AUTH-04, S-03) | `integration/refresh.test.ts` |
| Short-lived tokens, revocation (§1) | 15-minute access tokens, revocation at once (S-04, R-AUTH-05) | `integration/auth-guard.test.ts`, `integration/my-sessions.test.ts`, `integration/passwords.test.ts` |
| No cached responses (§2) | `Cache-Control: no-store` (R-TLS-02, I-07) | `security/headers.test.ts` |
| Pinning, TLS (§2) | TLS at the edge, HSTS (R-TLS-01, I-08) | `security/headers.test.ts`; `e2e/tls.test.ts` against staging (M6) |
| Problem types, additive contract (§4) | RFC 9457 (ADR-0007); the `0.3.0` freeze (Q-45) | `contract/problem-details.test.ts`, `contract/freeze.test.ts` |
| `Idempotency-Key` (§4) | Replay of successes only (ADR-0008, Q-39) | `integration/idempotency.test.ts` |
| `If-Match` (§4) | `428` / `409` with `current_version` (ADR-0008, T-07) | `contract/preconditions.test.ts`, `integration/quest-changes.test.ts`, `integration/achievement-changes.test.ts` |
| Effects from the server (§4) | Exactly-once XP, ranks and gambles in the goal engine (R-XP-01, T-06, T-17) | `integration/goal-engine.test.ts`, `integration/check-ins.test.ts`, `integration/quest-changes.test.ts` |
| Undo window (§4) | `409 check-in-final` after the day (Q-36) | `integration/check-ins.test.ts` |
| `429` and `Retry-After` (§4) | Per-client and per-user limits (R-AUTH-08, A-31, Q-30) | `security/rate-limit.test.ts`, `contract/rate-limits.test.ts` |
| Re-authentication (§5) | 10-minute window (R-AUTH-06, E-03); with a code or a passkey (ADR-0019) | `src/modules/sessions/reauth.test.ts`, `integration/passwords.test.ts`, `integration/email-change.test.ts`; export and deletion with M4; `integration/step-up.test.ts` with M5 |
| Consent (§5) | Consent guard; withdrawal deletes all goal content (R-PRIV-04, Q-10) | `security/consent.test.ts`, `integration/consents.test.ts` |
| Passkeys (§6) | Bound to the RP ID and origins (Q-51), user verification, single-use challenges, the counter (S-13…S-15, S-18) | `src/platform/webauthn/webauthn.test.ts`, `integration/passkeys.test.ts`, `integration/passkey-login.test.ts` |
| TOTP and recovery codes (§6) | RFC 6238, no code twice, 5 wrong codes per token, the backoff, codes as digests and single use, kept through a reset (S-15…S-17, I-24) | `src/platform/crypto/totp.test.ts`, `src/platform/crypto/recovery-codes.test.ts`, `integration/totp.test.ts`, `integration/login-second-factor.test.ts`, `integration/sign-in-visibility.test.ts` |
| Token in the link's fragment (§7) | Links built from `PUBLIC_LINK_BASE_URL` with `#token=` (A-32); notices without links (A-33) | `src/platform/email/templates.test.ts` |
