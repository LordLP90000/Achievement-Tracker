# STATUS REPORT – M4 Privacy rights – 2026-11-02

**Overall: GREEN.** Every M4 deliverable is built test-first and green on `master`:

- the export
- account deletion with the 30-day reactivation window
- accounts pending deletion: only the login endpoint accepts them, and they get no email except the deletion notice
- the hard delete, which destroys the data key (crypto-shredding) and writes the tombstone in the same transaction

**40 of 40 operations** are implemented, and since contract `0.3.2` all of them are frozen. The M3 review follow-ups
came first: the Q-44 gamble guard, the contract freeze, the mail catcher with the e2e app journey, and
`client-security.md`. CI stayed green on every push (runs #89–#98). You decided Q-46 during M4. Three decisions are
open: two new items (O-11, O-12) and the two dependency exceptions that expire on 2026-11-30.

## Done

All commits are on `master`, each test-first with a `docs/PROGRESS.md` row.

- `4a7faf5` docs: M4 kickoff with the task plan
- **M3 review follow-ups**:
  - `1a1f4d8` the Q-44 guard: while a gamble is pending, a quest edit or deletion that would complete its achievement
    without a check-in → `409 gamble-pending`, and nothing changes (contract `0.2.10-draft`)
  - `1375192` the core contract frozen as `0.3.0` (Q-45), enforced by `test/contract/freeze.test.ts` against a
    committed snapshot
  - `ac41086` Mailpit 1.32.0 in the local Compose stack (TLS only, ADR-0018) and the app journey in the e2e suite
  - `c566982` `docs/client-security.md` (aligned with OWASP MASVS v2, brought forward from M6)
- **Privacy rights**:
  - `acebcaa` the export (contract `0.3.1` with the schema you approved)
  - `008aad1` the deletion request (contract `0.3.2`: `deleteAccount` joins the freeze unchanged)
  - `97d355e` accounts pending deletion: unusable, no email (Q-46), back only through a password login
  - `2b4a300` the hard delete after 30 days
- `95e516e` docs: DPIA v0.4, data inventory, threat model and test strategy for M4
- this commit: docs, this report

**Endpoints (2 new, contract-tested):**

- `GET /me/export`: the whole account as one JSON document. Needs the password entered within the last 10 minutes,
  allows at most 2 exports in any 24 hours, and is audited.
- `DELETE /me`: `202` with `deletion_scheduled_for`.

**Worker:**

- the hourly `purge_deleted_accounts` job
- the outbox withholds anything queued after a deletion request (Q-46)

## Tests

- **Automated tests**: 1 774 in 120 files (M3: 1 676 in 113), plus 13 e2e checks against the built image and the
  Compose stack (M3: 11). The app journey runs: sign-up → emailed link → login → consent → achievement → quests →
  check-ins → gamble → stats → export → deletion, and the deletion notice arrives in the mail catcher. All green
  locally (pre-push hook) and in CI.
- **Coverage**: 99.0 % statements · 97.6 % branches · 99.9 % functions · 99.7 % lines (gate 85 %). The domain engine
  covers 100 % of 250 branches (gate 95 %). Every new M4 file is fully covered except two defensive throws in the
  export's repository (an unknown column name, and the account disappearing mid-export).
- **Mutation** (Stryker, gate 80 %, full run on the final M4 code): **98.98 %**. Domain 100 %, `platform/crypto`
  96.6 %, both unchanged from M3 because M4 didn't touch either. The 13 surviving mutants are the M2 crypto ones
  listed in the M3 report. Stryker doesn't cover `modules/`, so I checked M4's own code by fault injection instead
  (below).
- **Spec coverage**: 40 of 40 operations implemented and contract-tested. `not-yet-implemented.ts` and the freeze's
  list of operations outside the freeze are both empty.
- **Red first, then fault injection**: every task started with a failing test, with one exception.
  `security/deactivation.test.ts` passed at once, because the API guards it checks have existed since M2 and the
  deletion commit. Its value shows in the 6 faults it catches.
  - **76 deliberate faults injected in M4, all caught**, plus 1 equivalent mutant: removing the export's own user
    filter changes nothing, because row-level security still limits the read.
  - One injected fault survived at first: removing the account-row lock from the deletion went unnoticed by a race
    test that relied on timing. The test now holds the row until all three requests are waiting, and catches it.

| Exit criterion (plan and handoff, M4) | Evidence |
|---------------------------------------|----------|
| Export complete against seeded data, with every inventory column | `privacy/export.test.ts`: an account with rows in every exported table, every nullable encrypted column filled, comes back with exactly the `included` columns of every record, decrypted, for every row; step 6 of the inventory guard; 1 001 archived achievements read in batches |
| Deletion complete: every table empty for the user, wrapped key gone, tombstone written | `integration/account-deletion.test.ts`: the user has rows in 11 tables before and none in any table with a `user_id` after (`user_keys` and audit events included), only the tombstone remains, written in the same transaction, and the address can register again |
| A-22 and E-13 tested | `security/deactivation.test.ts`: every authenticated operation → 401 with the former token; public endpoints answer as for an unknown address and send no email; only a rate-limited, audited password login reactivates. `integration/outbox-delivery.test.ts` covers Q-46 |
| 40 of 40 operations implemented | the spec-coverage gate; `test/contract/not-yet-implemented.ts` is empty |
| Generated suites green and covering the new operations | deny-by-default and the rate-limit check list `exportData` and `deleteAccount` by name. Body limits, mass assignment, ownership and consent don't apply: neither operation has a body, a path parameter or goal rows |
| Coverage and mutation gates held | 99.0 % / 97.6 %; domain 100 % of 250 branches; Stryker 98.98 % |

## Security & privacy

**Incidents**: none. CI was green on every M4 push (runs #89–#98) and no pre-push gate failed.

**Findings during M4:**

- **Applied strictly, A-22 would have hidden an account takeover** (found while building the worker side). If every
  email of an account pending deletion were withheld, someone who knows the password could change the address and
  delete the account within seconds. The deletion notice goes to the new address, and the notice to the old address
  would be withheld, so the owner would hear nothing. Your handoff asked that mail queued before the deactivation not
  be sent. I asked you about this case, and you decided **Q-46**: what was queued before the request still goes out;
  anything queued later is withheld, except the deletion notice. It's built that way, and A-22 is refined in the
  requirements to match.
- **Simultaneous deletions from two devices** would have queued two notices and written two audit events. The
  deletion now runs under a lock on the account's row and checks that the requesting session still exists; the other
  requests get 401.
- **A reactivating login racing the hard delete**: the job checks the request time again on every row it deletes,
  and writes tombstones only for rows it actually deleted. A tombstone for a live account would make a later restore
  delete that account.
- **O-11** (found while building Q-44) and **O-12** (found while building Q-46): see *Decisions I need from you*.

**Residual risks** (for the M6 load test, unless you object):

- The export document is built in memory and grows with the archive, which has no limit (Q-40). If the load test
  shows a problem, the export switches to streaming (D-09).
- The hard delete removes at most 1 000 accounts per hourly run, so 24 000 a day; a larger backlog waits for the next
  runs.
- Replaying tombstones after a restore belongs to the M6 restore drill (I-18).

**For the app team** (`client-security.md` §5):

- A deletion ends every session at once.
- Until the deadline, only the password login works, and a forgotten password can't be reset (O-12 may change this).
- The export is a file: hand it to the share sheet without keeping a copy in the app.

**Scan results** (2026-11-02):

- Semgrep: 0 findings (116 rules, 329 files), run before every push.
- CI runs #89–#98 green in all 7 jobs, including osv-scanner, gitleaks over the full history, Trivy and the SBOMs.
- Mailpit image: Trivy found 0 HIGH, CRITICAL or MEDIUM issues.

**Exceptions register**: nothing new in M4.

- The two exceptions you accepted on 2026-11-02 **expire on 2026-11-30**: GHSA-3g3m-2fjr-6pw4 (`glob` 10.5.0) and
  GHSA-g3hv-75wg-m249 (`minimatch` 5.1.9, 9.0.9 and 10.2.6), both dev-only.
- No parent package accepts a fixed version yet. Checked on 2026-11-02: OSV lists fixes only in `glob` 14.0.2 and
  `minimatch` 11.0.1. The latest parent versions still require older ones: Stryker 10.1.1 wants `minimatch` ~10.2.4,
  ESLint 10.14.0 ^10.2.6, typescript-eslint 8.72.1 ^10.2.2, archiver-utils 5.0.2 `glob` ^10, cacache 21.0.1 `glob`
  ^13. Your decision is needed below.
- GHSA-67mh-4wv8-2f99 (`esbuild`, dev-only) runs until 2027-01-31.

**Data inventory**: no new data, table or column in M4.

- The API role now reads the user's own audit events (migration 0008, under row-level security), for the export and
  its rolling limit. It still can't change or delete any.
- The retention texts now describe the deletion.
- The DPIA is updated to draft v0.4.

**Dependencies**: no new npm dependency, runtime or dev. One new development image: Mailpit 1.32.0, approved, pinned
by digest, used only in the local stack. No new external service, processor or cost.

## Decisions I made

| Decision | Reason |
|----------|--------|
| The export's limit of 2 per 24 hours counts the user's own `export_requested` audit events in a rolling window, under the user's goal lock | the rate-limit buckets are keyed per UTC day, and a token bucket would allow a third export after 12 hours (D-09) |
| The API reads the user's own audit events (migration 0008) | the export must include them and the rolling limit counts them. Row-level security limits the read to the user in context, and the API still can't change or delete any |
| A deletion request deletes every one-time token of the account, including used ones | no emailed link works afterwards, not even a replayed verification link (E-13) |
| The deletion runs under a lock on the account's row and needs the requesting session to still be live | simultaneous requests from several devices delete once: one gets `202`, the others `401` |
| `deleteAccount` joined the freeze unchanged as `0.3.2` | your rule of 2026-11-02: an operation joins the freeze once implemented. The contract text didn't change |
| The hard delete runs hourly, not daily as the data model said: 100 accounts per statement, at most 10 statements per run | erasure happens within the hour after the deadline. Each account takes its whole goal archive with it, so the batch limits keep each transaction bounded |
| Withheld emails are deleted unsent and counted, never kept | nothing caused after a deletion request should sit in the outbox waiting for a reactivation |

## Decisions I need from you

| ID | Question | Options | My recommendation |
|----|----------|---------|-------------------|
| O-11 | **A pending gamble can still be made easy to win.** Q-44 refuses an edit or deletion that completes the gamble's achievement by itself. But the user can still delete or demote every open required quest but one, lower that one's target to just above the value already reached, and then win with a single check-in. The win pays at most the remaining required XP (Q-31), but the user keeps the stake without reaching the goal: a gamble without risk | (a) accept it as a change of the goal · (b) while a gamble is pending, refuse with `409 gamble-pending` every change that reduces the remaining work (deleting or demoting an open required quest, lowering an open target), as Q-44 and A-26 do · (c) let such a change lose the gamble | **(b)**: it finishes what Q-44 started. Additive (descriptions only; the error slug exists). About half a day |
| O-12 | **Recovering an account deleted by someone else.** Someone who knows the password can change it and then delete the account. The owner is told about both (Q-46) but can't get the account back: forgot-password sends nothing to an account pending deletion (A-22), only a login with the password reactivates it, and after 30 days the account and all its data are gone | (a) accept it: the data is lost, and the owner can register again after the deletion · (b) a password reset within the 30 days reactivates the account (audited), and the deletion notice says so. The reset link proves control of the address, which already recovers an active account. The downside: anyone controlling the mailbox could also undo a deletion the owner wanted | **(b)**: the address stays the recovery factor it is for every account, and the notice's advice ("log in right away") becomes something the owner can actually do. It changes `deleteAccount`'s description (wording only), A-22 and E-13. About half a day |
| Exceptions | `glob` and `minimatch` (dev only) expire on 2026-11-30, and no parent package accepts a fixed version yet | (a) extend both to 2027-01-31 (like `esbuild`), re-checked at every milestone · (b) force `glob` 14 and `minimatch` 11 with npm overrides, outside the version ranges ESLint, Stryker and testcontainers declare | **(a)**: neither package is in the image, and no pattern comes from an attacker. Forcing new major versions risks breaking the dev tools the gates depend on |

## Scope or plan changes

- **Contract**: `0.2.9-draft` → `0.2.10-draft` (Q-44, descriptions) → **`0.3.0` frozen** (Q-45) → `0.3.1` (the
  export's schema, approved) → `0.3.2` (`deleteAccount` frozen unchanged). The freeze test compares the contract with
  `openapi/frozen/openapi.yaml`.
- **Added beyond the plan**:
  - the freeze's own rule set, with 43 rule tests on synthetic contracts
  - `security/deactivation.test.ts`, run with real rate limits
  - deterministic race tests for the deletion and the hard delete
  - the outbox's withholding (Q-46)
- **Not done in M4**:
  - Node 26.13.0 LTS: the 7-day rule allows it from 2026-11-04 (`.nvmrc`, image digests, local install)
  - the restore drill with tombstone replay stays in M6, as planned
- **Effort**: planned 6.5–9.5 engineering days including the follow-ups; the M4 commits landed on 2026-11-02.

## Next

- **On or after 2026-11-04**: Node 26.13.0 LTS, the last M4 task, as one maintenance commit with the e2e suite run
  before the push. It doesn't need the review.
- **After your "go"**: what you choose for O-11 and O-12 (about half a day each) and the exceptions. Then **M5 Auth
  hardening (7–10 engineering days)**:
  - passkeys (WebAuthn)
  - optional TOTP with recovery codes
  - step-up re-authentication

  M5 needs two approvals from you: a WebAuthn library (I recommend `@simplewebauthn/server` over writing our own
  verification) and the relying-party ID/domain (Q-19).

---

## Addendum 2026-11-02 — review with the PM

**Your decisions** (recorded in `requirements.md` §6.7, `ee01990`): **Q-47** — option (b) for O-11; **Q-48** — option
(b) for O-12; **Q-49** — option (a) for the exceptions. All three are built, each test-first in its own commit with a
`PROGRESS.md` row, and green in CI.

- `3d62fa0` **Q-47 — no work taken away while a gamble is pending.** While a gamble is pending, a quest edit or
  deletion that lowers what an open required quest of its achievement still asks for → `409 gamble-pending`, nothing
  changed: deleting or demoting it, a target brought closer to its current value (rising or falling, also through a
  new start value while no check-in exists), and a habit not yet begun asked for fewer check-ins or a **shorter
  run**. That last part is my reading of "every change that reduces the remaining work": XP counts a habit's length
  (R-XP-02), so "once a week for 4 weeks" may not become "once a day for 4 days" either. Everything that asks for no
  less goes through. The rule is pure domain code, so Stryker covers it (100 %). One Q-44 test changed with the
  requirement: lowering a target without completing the achievement was "allowed" and is now refused. Contract
  `0.3.3` (descriptions).
- `a81c554` **Q-48 — a password reset reactivates an account pending deletion.** Forgot-password emails the link to
  an account pending deletion with the same answer as for any address, the worker sends it, and the completed reset
  reactivates the account (audited); 30 days after the request the account counts as deleted for the reset as for
  the login. **Found while building it:** a reset at the deadline could deadlock with the hard delete, because the
  two locked the same two rows in opposite orders; the reset now locks the account row first, and a race test
  holds both orders. The deletion notice says in all four languages that a reset brings the account back (the copy
  review, O-08, is still open). Two test expectations changed with the requirement (the link now goes to an account
  pending deletion). Contract `0.3.4` (descriptions).
- `e5991e5` **Q-49** — both exceptions in `osv-scanner.toml` now expire on 2027-01-31, each reason recording your
  decision and the check of 2026-11-02; re-checked at every milestone.
- **The frozen contract**: its snapshot is now renewed with every change you approve, after the check against the
  one before, so that an addition is frozen as well (ADR-0010 amendment).

**Numbers on the final code**: 1 812 tests in 120 files (+38) and 13 e2e checks, all green; coverage 99.0 % /
97.7 %; Stryker 99.0 % — the domain 100 % (938 mutants killed, 52 more than in M3), `platform/crypto` 96.6 %
(unchanged). Fault injection: **27 of 27** new deliberate faults caught, two of them only after I added test cases
(a falling target, and a start value moved after a check-in); rerunning the Q-44 probes, 2 of 10 are now equivalent,
because Q-47 refuses every deletion Q-44's deletion check would catch — that check stays as a second layer.
Semgrep 0 findings; CI runs #99–#103 green, the last one with the extended exceptions in the dependency scan.

**Still open**: Node 26.13.0 LTS on or after 2026-11-04 (one maintenance commit). **M5 waits for your "go"** and
two approvals: the WebAuthn library (`@simplewebauthn/server` recommended) and the relying-party ID/domain (Q-19).
