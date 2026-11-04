# STATUS REPORT – M5 Auth hardening – 2026-11-04

**Overall: GREEN.** Every M5 deliverable is built test-first and green on `master`:

- passkeys: creating, listing and removing them, and signing in without an address
- optional two-factor sign-in with TOTP and 10 single-use recovery codes, as a second login step
- step-up re-authentication with a passkey, or with the password and a code when TOTP is on
- the account shows whether TOTP is on and how many recovery codes are left; the session list shows how each session
  signed in

**51 of 51 operations** are implemented, contract-tested and frozen. That is M4's 40 plus M5's 11, with additive
changes to `login`, `reauthenticate`, `Account`, `Session` and the export, as you approved them with ADR-0019 (Q-52).
CI stayed green on every push (runs #108–#121). You decided Q-50 and Q-51 at M5's start, and Q-52 and Q-53 during
it. No decision is needed to close M5. M6 needs the hosting option, the email relay, the Connect details and the
domain (see *Decisions I need from you*).

## Done

All commits are on `master`, each test-first with a `docs/PROGRESS.md` row.

- `6eacee5` docs: M5 kickoff with the task plan and the design (ADR-0019)
- `63cb209` docs: your approval of the design (Q-52)
- `a61462d` contract `0.4.0`: M5's 11 operations, kept outside the freeze until each was built
- `918143e` `@simplewebauthn/server` 14.0.3 (Q-50), imported only by `src/platform/webauthn`
- `804a228` TOTP (RFC 6238) and recovery codes in `platform/crypto`, on `node:crypto`, with no new dependency
- `e63a501` migration 0009: the five tables of the sign-in methods and each session's `auth_method`; an unconfirmed
  TOTP secret is deleted after 24 hours (Q-53)
- `7853822` passkey verification, its options and the relying-party settings (Q-51)
- `511c33f` turning TOTP on and off, and replacing the recovery codes
- `0ca9803` the second login step: with TOTP on, a correct password answers `202` and a code completes the login
- `96f8bb6` passkeys: create, list, remove (at most 10)
- `a826f68` signing in with a passkey; every M5 operation is now frozen (`0.4.5`)
- `4d4f852` step-up with a code or a passkey (`0.4.6`)
- `4e8ce1b` the sign-in methods on the account and its sessions (`0.4.7`)
- `b994845` docs: threat model, DPIA v0.5, client guide §6, architecture §4.9
- this commit: this report

**Endpoints (11 new, contract-tested):**

- Passkeys, signed in and re-authenticated within 10 minutes: `POST /me/passkeys/options`, `POST /me/passkeys`,
  `DELETE /me/passkeys/{passkeyId}`; the list, `GET /me/passkeys`, needs no re-authentication.
- Passkey sign-in, public: `POST /auth/passkey/options` names no account; `POST /auth/passkey/login` signs in.
- TOTP, re-authenticated: `POST /me/totp`, `POST /me/totp/confirm` (answers the 10 recovery codes once),
  `DELETE /me/totp`, `POST /me/recovery-codes`.
- The second login step: `POST /auth/login/second-factor`.

**Changed (additive):**

- `POST /auth/login` answers `202` with a 5-minute second-factor token when TOTP is on.
- `POST /auth/reauth` also takes a passkey, or the password with a code. With TOTP on, the password alone gets
  `401 second-factor-required`.
- `GET /me` shows `two_factor_enabled` and `recovery_codes_left`.
- `GET /me/sessions` shows each session's `auth_method`.
- The export gains `passkeys` and `two_factor`: dates only, never a secret, key or digest.

**Worker:** 3 new hourly purges (14 jobs in total):

- WebAuthn challenges after 5 minutes
- second-factor tokens after 5 minutes
- unconfirmed TOTP secrets after 24 hours

**Email:** one new notice without a link, `sign_in_methods_changed_notice`, in en, de, fr and it. It is sent after
every change of passkeys, TOTP or recovery codes, and after every use of a recovery code.

## Tests

- **Automated tests**: 2 138 in 130 files (M4: 1 812 in 120), plus 13 e2e checks against the built image and the
  Compose stack. All are green locally (pre-push hook) and in CI.
  - **Passkeys run real ceremonies**: a software authenticator written from the WebAuthn spec, not with the library.
    It covers EdDSA, ES256 and RS256, and the `none` and `packed` attestations, and can bend every field a verifier
    must check.
- **Coverage**: 98.99 % statements · 97.5 % branches · 99.9 % functions · 99.79 % lines (gate 85 %). The domain
  engine covers all 268 of its branches (gate 95 %).
- **Mutation** (Stryker, gate 80 %, full run on the final M5 code): **99.26 %**.
  - Stryker now also covers `platform/webauthn`: **100 %** (214 mutants killed).
  - `platform/crypto` 97.4 %, with the new TOTP and recovery-code code at 100 %. The one M2 survivor in `tokens.ts`
    is gone; the other 12 survivors are the M2 ones listed in the M3 report.
  - The domain stays at 100 % (938 killed); M5 didn't touch it.
- **Spec coverage**: 51 of 51 operations implemented and contract-tested. `not-yet-implemented.ts` and the freeze's
  list of operations outside the freeze are both empty again.
- **Fault injection.** Stryker doesn't cover `modules/`, so I checked M5's module code by fault injection, as in M4.
  - **142 deliberate faults were injected, and all are caught.** 4 survived at first and are caught since I added
    tests for them:
    - 3 were masked by row-level security: two conditions of the TOTP purge, and the owner condition of the passkey
      lookup. Those conditions are now tested as the owner role, which no policy restricts.
    - 1 derived `two_factor_enabled` from the codes left. It is now caught by a test of TOTP on with every recovery
      code used.
  - For the passkey sign-in and the step-up, I added 7 tests after green and before the fault runs, for faults I
    could see they would miss.
- **Red first**: every task started with failing tests. Two tests passed at once, and both are kept as guards:
  - the step-up's body-validation test: the old schema refused those bodies too
  - the test that a password reset keeps TOTP and the passkeys: that already held, because the reset never touches
    those tables. Two injected faults prove it catches a reset that drops either

| Exit criterion (plan, M5) | Evidence |
|---------------------------|----------|
| Passkeys: registration and sign-in ceremonies, several per account, the counter, attestation `none` | `src/platform/webauthn/webauthn.test.ts` (every refusal ADR-0019 lists, a clone only for a valid signature), `integration/passkeys.test.ts` (up to 10, duplicates refused, re-authentication), `integration/passkey-login.test.ts` (sign-in without an address, the counter, the same 401 for every failure) |
| Optional TOTP: RFC 6238, secret encrypted, recovery codes hashed | `src/platform/crypto/totp.test.ts` (the RFC 4226 and 6238 vectors), `recovery-codes.test.ts`, `integration/totp.test.ts` (the secret encrypted at rest, the codes as digests only), `integration/login-second-factor.test.ts` |
| Step-up with a passkey or TOTP | `integration/step-up.test.ts`, including the backoff with the real limiter and deterministic lock tests |
| The session list shows the sign-in method | `integration/sign-in-visibility.test.ts`, `integration/my-sessions.test.ts` |
| Audit events | each suite checks its events: passkey added, removed, suspected clone; TOTP on and off; codes generated and used; failed second factor; passkey sign-ins and step-ups (`method: passkey`) |
| Threat-model update | S-13…S-19, I-24, I-25, D-11, RR-6…RR-8 (`b994845`) |
| 51 of 51 operations, frozen | the spec-coverage gate and the freeze test against the `0.4.7` snapshot |
| Coverage and mutation gates held | 98.99 % / 97.5 %; domain 268 of 268 branches; Stryker 99.26 % |

## Security & privacy

**Incidents**: none. CI was green on every M5 push (runs #108–#121) and no pre-push gate failed.

**Findings during M5:**

- **The WebAuthn library judges the signature counter before the signature** (found while building `7853822`). A
  forged assertion carrying a low counter would have been reported as a cloned passkey. That would put a false alarm
  on a real user's passkey and hide the forgery. The library's check is off, and ours runs only after a valid
  signature.
- **The library's options include `hints`**, which the closed contract schemas refuse. Our wrapper builds the
  options exactly as the contract describes them. The library still does all the verification.
- **A crafted user handle gave a 500** on the public passkey sign-in (found while building `a826f68`). Any 16 bytes
  were taken as an account ID, and the database layer, which accepts only v4 UUIDs, threw. Such a handle now claims
  no account, and the request gets the same 401 as every other failure, before any lookup.
- **Checks that row-level security hid.** Three owner and purge conditions could be removed without any test
  failing, because RLS still restricted the rows. They are now tested without RLS. The step-up looks the passkey up
  under the session's own account, so its check that the handle names that account can be tested directly.
- **A promise nobody had tested** (`b994845`): ADR-0019 says a password reset keeps TOTP and the passkeys, so a
  taken-over mailbox alone removes neither. That held because the reset never touches those tables; a test now pins
  it.
- **Lock order**: every sign-in and step-up takes the account row before its child rows, as the deletion's cascade
  does. A race with the hard delete waits instead of deadlocking, and tests that hold the row prove both ways wait.

**Residual risks** (in the threat model; the first one you accepted with Q-52):

- **RR-6**: an account whose authenticator is lost with no recovery code left is locked out for good, and only a
  request to the controller can erase it. The app must say this plainly (client guide §6; DPIA R-17, low).
- **RR-7**: a TOTP code can be relayed by a fake site in real time. Passkeys can't be, so the app should offer them
  first.
- **RR-8**: a synced passkey (iCloud Keychain, Google Password Manager) always reports counter 0, so it gets no clone
  detection. Refusing such passkeys would refuse most passkeys.
- **D-11**: the public `POST /auth/passkey/options` writes a row per call. The per-network limit, the 5-minute
  expiry and the hourly purge bound it. The M6 k6 run will measure it.

**For the app team** (`client-security.md` §6, new):

- Offer passkeys first. They need the domain association files on the production domain (`webcredentials` in
  `apple-app-site-association`, `get_login_creds` in `assetlinks.json`), so passkeys work in the apps only once the
  domain exists (Q-19, Q-51). Until then the local stack can point at any domain the app is associated with
  (README).
- Recovery codes are shown once. The app should let the user save them outside the app, never keep them, and say
  plainly what losing them means. `GET /me` shows `recovery_codes_left`, so the app can suggest new codes when few
  are left.
- A login with TOTP on answers `202` with a token for the second step. A step-up with the password alone answers
  `401 second-factor-required`: ask for the code and send both again.

**Scan results** (2026-11-04):

- Semgrep: 0 findings (116 rules, 356 files), run before every push.
- CI runs #108–#121 green in all 7 jobs, including osv-scanner, gitleaks over the full history, Trivy and the SBOMs.
- osv-scanner found no issues with `@simplewebauthn/server` and its 25 packages when they were added.

**Exceptions register**: nothing new.

- The three dev-only exceptions run until 2027-01-31 (Q-49).
- Re-checked today: no parent package accepts a fixed version yet. Stryker 10.1.1 wants `minimatch` ~10.2.4,
  ESLint 10.14.0 ^10.2.6, archiver-utils 5.0.2 `glob` ^10, cacache 21.0.1 `glob` ^13. Unchanged since 2026-11-02.

**Data inventory**: migration 0009, all in C2 (authentication secrets) and C4 (sessions).

- New tables:
  - `passkeys`: public keys, counters, an optional name encrypted
  - `totp_secrets`: the secret encrypted with the user's data key
  - `recovery_codes`: digests only
  - `webauthn_challenges` and `second_factor_challenges`: digests, 5 minutes
- Each session's `auth_method`.
- All under row-level security except the two challenge tables, which are looked up by hash before an account is
  known.
- No biometric data ever reaches the service: the device checks it.
- The DPIA is updated to draft v0.5 (new R-17, open item 8: the privacy policy must describe the sign-in methods and
  the lock-out).

**Dependencies**: one new runtime dependency, `@simplewebauthn/server` 14.0.3 (Q-50, pinned exactly). No new dev
dependency, image, external service, processor or cost.

## Decisions I made

| Decision | Reason |
|----------|--------|
| Our wrapper builds the WebAuthn options; the library only verifies | the library's own options carry `hints`, which the closed contract schemas refuse |
| The library's counter check is off; ours runs after a valid signature | the library checks the counter first, so a forgery could pass for a clone |
| A user handle counts only if its bytes are a v4 UUID | every account ID is one; anything else names no account and must not reach the database |
| The first login step never clears the address's backoff; wrong codes count against it | otherwise a new first step after the correct password would reset the guessing of codes (S-01) |
| With TOTP on, the step-up names a missing code before it checks the password, and that answer neither counts nor clears the backoff | the session can see whether TOTP is on anyway (`GET /me`). This way the step-up is no password oracle, costs no Argon2id run, and cannot be used to reset the backoff |
| At step-up, a wrong code is the same 401 as a wrong password, but audited `second_factor_failed`; after a wrong password no code is checked | the caller can't tell which factor failed, the owner's audit trail can, and a valid code isn't spent by a wrong password |
| A code sent while TOTP is off isn't checked | TOTP turned off on another device between the app's last `GET /me` and the step-up shouldn't fail it |
| Passkeys stay outside both password backoffs | a passkey can't be guessed. A user whose password is blocked can still step up with a passkey, and refused passkeys don't count |
| A refused passkey result still uses up its challenge | each challenge answers exactly one attempt; the refusal returns instead of throwing, so the consumption commits |
| At step-up, the passkey is looked up under the session's account, and a handle naming anyone else is refused | the session's account is the one to prove. It also makes the handle check testable under RLS |
| Failed passkey sign-ins and all passkey step-ups are audited with `method: passkey` | the audit trail tells them apart from password events |
| `recovery_codes_left` is 0 while TOTP is off; `AuthMethod` is one shared schema | one meaning for the app, and the export and the session list can't drift apart |
| The second login step relies on the account row lock alone | an extra lock on the token was redundant: the account row already serialises the steps |

## Decisions I need from you

| ID | Question | Options | My recommendation |
|----|----------|---------|-------------------|
| O-01, O-02, O-03 | **Before M6's staging work**: your hosting option (Q-01), the SMTP relay operator and the 1Password Connect deployment details | name them; `docs/hosting-options.md` lists what each must provide (H-1…H-7) | Name them by M6's start. Without them, M6 can build everything except the staging deployment and the scans and load tests that run against it |
| Q-19 | **The production domain**: passkeys and email links need it, and so do the association files the apps need for passkeys | name it, or keep `questline.test` until launch | Name it with the hosting option: it becomes the passkey relying-party ID (Q-51), which can't change later without every passkey being re-created |

## Scope or plan changes

- **Contract**:
  - `0.3.4` → `0.4.0`: M5's 11 operations, outside the freeze until each was built
  - `0.4.1`: the export's sign-in methods, Q-53
  - `0.4.2`: TOTP
  - `0.4.3`: the second login step
  - `0.4.4`: passkey management
  - `0.4.5`: passkey sign-in; all operations frozen
  - `0.4.6`: step-up
  - `0.4.7`: the account and session fields

  Each change was checked against the snapshot before it, then the snapshot was renewed.
- **Added beyond the plan**:
  - the software authenticator for real ceremonies
  - Stryker on `platform/webauthn`
  - the owner-role tests for conditions that RLS masks
  - deterministic lock tests for the sign-in paths
  - the visibility fields on the account
  - the test that a reset keeps the second factor
- **Not done in M5**:
  - Node 26.13.0 LTS: the 7-day rule allows it from 22:35 today, since both images were published on 2026-10-28
  - passkeys inside the apps, which wait for the domain (Q-19)
  - O-08 now covers 8 emails in 4 languages (the new notice included); the copy review stays before launch
- **Effort**: planned 7–10 engineering days; the M5 commits landed on 2026-11-04.

## Next

- **Today from 22:35**: Node 26.13.0 LTS, the last M4 task, as one maintenance commit with the e2e suite and Trivy
  run before the push. It doesn't need the review.
- **After your "go": M6 Hardening & handover (5.5–8.5 engineering days)**:
  - a staging deployment on your hosting option, which needs O-01…O-03 and the domain
  - ZAP against the OpenAPI spec
  - k6 for limits and backoff under load, the public passkey options included
  - the restore drill with tombstone replay
  - the key-rotation, breach and operations runbooks
  - the API reference
  - the review package for the data-protection expert

---

## Addendum 2026-11-04 — Node 26.13.0

- **Node 26.13.0 LTS is done**, in its own commit at 22:39. `.nvmrc` and both images now pin Node 26.13.0, each
  image by its digest and adopted only once 7 days old. The full suite, e2e (13/13) and Trivy (0 HIGH or CRITICAL,
  unfixed included) are green on the new image. Nothing is left open from M4.
