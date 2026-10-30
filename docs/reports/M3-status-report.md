# STATUS REPORT – M3 Core domain – 2026-10-30

**Overall: GREEN** — every M3 deliverable is built test-first and green on `master`: the domain engine, achievements,
quests, check-ins, gambles, streaks, ranks, the daily goal evaluation and the stats, behind idempotency keys,
optimistic concurrency and cursor pagination, with every goal field encrypted. 38 of the contract's 40 operations are
implemented; export and account deletion are M4. CI was red twice (runs #50 and #68, both in the e2e job, both fixed
within the next pushes; see *Security & privacy*). Ten proposals need your confirmation and two items need a decision,
one of them about starting the app.

## Done

All commits are on `master` (trunk-based, ADR-0001 as amended), each test-first with a `docs/PROGRESS.md` row.

- `fe62e92` docs: M3 kickoff with the task plan
- `83a6634` feat(rate-limit): a per-user limit on every authenticated operation (Q-30, contract 0.2.2)
- `4603c1f` test(crypto): `password.ts` 79.3 % → 100 % and `field-cipher.ts` 75 % → 100 % mutation score (M2
  carry-over); `d2e1b57` test(e2e): fix for CI #50
- **Domain engine** (`src/domain`, pure, property tests with `fast-check`): `d837a97` levels and the duration
  factor, `81e5beb` calendar dates, habit periods and the back-dating rule, `44e8dc0` progress with exact decimals,
  `62d3556` habit evaluation (resets, completion, the open period), `f029a75` streaks, `09da544` execution score,
  ranks and the rank bonus, `4593f3f` gamble placement and settlement, `a2528b8` status and quest state machines,
  prerequisites and locked habits, `f527bcd` the effects engine (exactly-once XP, unlock and re-lock, gambles, pause
  and deletion revocations), `4cfbc19` quest evaluation; `a0e8915`, `5beb082` docs: decisions Q-33…Q-38
- **Platform**: `70ae112` goal tables with composite ownership keys, forced RLS and delete guards; `ef06c0f` cursor
  pagination over `(created_at, id)`; `9f39d38` idempotency keys that commit with their effect (Q-39), `28b552e`
  fix for CI #68; `0e0183d` test: integration hook timeouts
- **Goal engine and API**: `c91e174` achievements (create, list, show; Q-40), `9983314` the goal engine — evaluate,
  reconcile and store every goal operation in one transaction under the user's lock, `a42170d` quests (create, list,
  show), `5d69551` quest edits and deletion (Q-41), `4925e71` check-ins with undo (Q-42, Q-43), `e9315f2` achievement
  edits, pause, resume and deletion, `2a057ab` gambles, `7cc0106` the daily goal evaluation in the worker, `13fa7fd`
  stats
- **Security suites**: `ccf58c6` ownership and consent across the contract, `375a12a` mass assignment, identifiers
  and validation patterns, `86337a8` goal content at rest, injection and body limits; the test strategy and the
  threat model now name only test files that exist
- this commit — docs: this report

**Endpoints (16 new, all contract-tested):** `GET`/`POST /achievements`, `GET`/`PATCH`/`DELETE /achievements/{id}`,
`GET`/`POST /achievements/{id}/quests`, `GET`/`POST /achievements/{id}/gambles`, `GET`/`PATCH`/`DELETE /quests/{id}`,
`GET`/`POST /quests/{id}/check-ins`, `DELETE /check-ins/{id}`, `GET /me/stats`. `GET /me` now shows the ledger's XP
total and level. Still listed as not implemented: export and account deletion (M4). **Worker**: the daily goal
evaluation after each user's local midnight (A-20, A-21) and the 24 h purge of idempotency records.

## Tests

- **1 676 automated tests** in 113 files — unit tests next to the code (`src/**`), integration, contract, security,
  privacy and supply-chain tests (`test/**`, real PostgreSQL 17 via Testcontainers) — plus **11 e2e checks** against
  the built image and the running Compose stack (run locally on the final M3 code, 2026-10-30). All green locally
  (pre-push hook) and in CI.
- **Coverage**: 99.0 % statements · 97.6 % branches · 99.9 % functions · 99.7 % lines (gate 85 %); the domain
  engine: **100 % of 250 branches** (gate 95 %).
- **Mutation** (Stryker, gate 80 %), a full run on the final M3 code: **99.0 %** — 1 253 killed, 3 timed out, 13
  survived. The domain engine **100 %** (886 killed, 0 survived; several files reached it only after survivors
  were analysed and equivalent code simplified); `platform/crypto` **96.6 %** with `password.ts` and
  `field-cipher.ts` raised to 100 %. The 13 survivors are in M2 files that M3 did not touch (`kek-source.ts` 7,
  `aead.ts` 3, `blind-index.ts`, `key-material.ts`, `tokens.ts` 1 each), every file ≥ 92 %; two are equivalent
  (Node reads an empty encoding as UTF-8), the rest are boundary checks of the 1Password Connect response and key
  material — candidates for the M6 key-rotation hardening.
- **Spec coverage**: 38 of 40 operations implemented and contract-tested; 2 listed as not yet implemented (M4).
- **Red first and fault injection**: every task started red; after each one I broke the code on purpose and checked
  that a test failed — **222 deliberate faults in M3, all caught** (counted in `PROGRESS.md`); where a probe first
  survived, the test was sharpened before the commit and the row says so. Equivalent probes are named, not counted.

| Exit criterion (plan M3) | Evidence |
|--------------------------|----------|
| Every operation in `openapi.yaml` implemented and exercised (export and deletion are M4) | the spec-coverage gate: 38 of 40; `test/contract/not-yet-implemented.ts` lists only `exportData` and `deleteAccount` |
| Domain branch coverage ≥ 95 %, mutation ≥ 80 % (domain and crypto) | 100 % of 250 branches; Stryker 100 % on the domain, 96.6 % on crypto, every file ≥ 92 % |
| Ownership matrix green | `security/ownership.test.ts`, generated from the contract: each of the 14 operations with a path ID answers another user's, an unknown and a malformed ID with 404, never 403, and nothing changes for either user |
| `GET /v1/me/stats` correct against seeded scenarios | `integration/stats.test.ts`: 13 scenarios — per-day sums with a negative day, defaults and bounds, counts by status and rank, the 200 newest badges, streaks cross-checked with `GET /quests/{id}`, an archive of 1 001 achievements, gambles settled before they are counted |
| Field encryption for all listed fields (incl. `target_date`, Q-24) | `integration/encryption-at-rest.test.ts`: a raw dump of every table shows no goal content; ciphertext swapped between rows or moved to another field fails closed |
| Idempotency, optimistic concurrency, pagination, limits | `integration/idempotency.test.ts`, `contract/preconditions.test.ts` and the `If-Match` suites, `integration/pagination.test.ts`, `integration/limits.test.ts` |
| Consent guard, deny-by-default for every operation | `security/consent.test.ts` and `contract/deny-by-default.test.ts`, both generated from the contract |

## Security & privacy

- **Incidents and findings**
  - **CI was red twice**, both times in the e2e job, which runs against the built image in CI only. Run #50 (the
    kickoff commit): the e2e test registered random passwords, which the breached-password filter sometimes refuses,
    so it failed only now and then — runs #51 and #52 passed, and I noticed it at the second check after it; fixed in
    `d2e1b57`. Run #68: the idempotency purge became the 10th retention job and the e2e test still expected 9; fixed
    in the next push (`28b552e`, it now counts `retentionJobs()`). Since then I run the e2e suite locally whenever
    the worker or the container changes.
  - **Bugs found by the tests during M3**: the Q-38 move of a habit's run wrote a week start for daily habits
    (a 500, fixed in `5d69551`); an undo that would make a second gamble pending was a 500 before Q-43 made it a
    `409`; stats for dates near the year 0 would have been a 500 — dates before 1970 are refused (A-43).
  - **Traceability**: the threat model and the test strategy named 14 test files (17 references) that never existed
    under those names (planned in M0). Every control was tested elsewhere except one: parallel check-ins on
    different quests (T-06), now tested. The names point at the real tests; those of M4/M6 are marked as such.
  - **Residual risk for the M6 load test (D-06)**: a user's goal operations run one at a time under the goal lock,
    and a request waiting for it holds a database connection for up to the 5 s statement timeout. For a maxed-out
    account some reads take long (a list page syncs up to 100 achievements; the stats read the whole archive, which
    has no limit, Q-40 — in batches of 1 000, so the number of queries stays bounded but the work grows). If the load
    test shows it, a busy lock can answer `429` with `Retry-After` instead of waiting. Rate limits bound it meanwhile.
  - **For the app team**: every change answers with its effects (XP, unlock, rank, a gamble settled since the last
    request); a check-in can be undone only on its own day (Q-36); `If-Match` is required on every change (428).
- **Scan results** (2026-10-30): Semgrep 0 findings (116 rules, 311 files) before every push · CI runs #69–#81 green
  in all 7 jobs, including osv-scanner, gitleaks over the full history, Trivy (HIGH/CRITICAL incl. unfixed) and the
  SBOMs.
- **Exceptions register**: nothing new in M3.
- **Data inventory**: M3 stores goal content — titles, descriptions, motivations, categories, target dates, quest
  notes, target values and units, check-in values and notes, all encrypted with the user's data key and bound to
  record and column — plus the XP ledger, badges, gambles and the daily-evaluation bookkeeping. Every column is in
  `data-inventory.yaml` (enforced by the inventory guard). Stored responses of idempotent requests (encrypted) are
  purged after 24 h; withdrawing the `goal_content` consent deletes all goal content, stored responses included
  (Q-10).
- **Dependencies**: no new runtime dependency (73 production packages, 0 known vulnerabilities); one new dev
  dependency, `fast-check` 4.10.2 (exact pin, older than 7 days), for the property tests. No new external service,
  processor or cost.

## Decisions I made

| Decision | Reason |
|----------|--------|
| One goal engine for every goal operation, API and worker alike: one transaction under a per-user lock that evaluates, reconciles the ledger by appending only differences, and stores the outcome | exactly-once XP and gamble settlement under retries and parallel requests, also across achievements (T-06) |
| Reads evaluate before they answer (A-21); the worker evaluates each user after their local midnight, in small batches with a time budget | resets and passed target dates take effect without the app open, and the scheduler's transaction stays short |
| A change syncs first, checks `404`, then `409` for state, then `If-Match`, then the `422` rules, applies itself and syncs again; its `Effects` report both syncs | RFC 9110's order of preconditions; a gamble lost since the last request is reported, not hidden |
| A path ID that cannot exist answers `404` | the contract documents no `400` for path IDs; nothing tells a malformed ID from someone else's |
| Paused and archived habits are evaluated read-only for the stats, by the engine's own code, in batches of 1 000 IDs | the archive has no limit (Q-40): bounded queries, below PostgreSQL's 65 535 parameters, and the same streaks as `GET /quests/{id}` |

## Decisions I need from you

| ID | Question | Options | My recommendation |
|----|----------|---------|-------------------|
| A-34…A-43 | Ten proposals recorded during M3 (`docs/requirements.md` §5): the 7-day rule compares instants (A-34); the attempt's deadline, stored encrypted and not an API field (A-35); a counting check-in before a habit's run begins → `422` (A-36); a completed quest keeps its target values (A-37); the `xp_floor` and `gamble_reverted` ledger events (A-38); a paused achievement shows as reset and its habits' settings may change (A-39); the archive as of its unlock day (A-40); an edited habit takes the current week start (A-41); the check-in limit counts by date (A-42); the stats' details (A-43) | confirm all · change individual ones | **confirm all** — they become accepted with your "go" unless you object |
| O-09 | **A pending gamble can be won without the work.** While a gamble is pending, three changes can complete the achievement without a check-in: deleting the last open required quest, making it a bonus, or lowering an open target quest's target to what was already reached. The win then pays at most the remaining required XP (Q-31), but the likely loss is avoided | (a) accept — changing the goal is the user's right · (b) while a gamble is pending, refuse those three changes with `409 gamble-pending`, as for the target date (A-26) · (c) let such a change lose the gamble | **(b)** — consistent with A-26 and with the purpose of a gamble; additive (new problem slug on documented `409`s, descriptions), about half a day |
| O-10 | **When the mobile app starts** (your question of 2026-10-30) | right after this review, in parallel with M4–M6 · after M6 | **after this review**: every core screen has a working endpoint now; I freeze the core contract as `0.3.0` (only additive changes afterwards) and prepare, in about 1–2 days, a mail catcher in the local Compose stack (sign-up cannot be verified locally today) and `client-security.md`, brought forward from M6. A shared staging server needs O-01 (hosting). Export and deletion screens wait for M4, passkeys and 2FA for M5 (new login steps). The app is outside this backend plan: it needs its own team, plan and budget |

## Scope or plan changes

- **Contract**: `0.2.1` → `0.2.9-draft` during M3, all additive, each with your decision — `429` everywhere (Q-30),
  `current_period` (Q-35), `409 check-in-final` (Q-36), the frozen habit settings (Q-37, Q-38), idempotency replays
  (Q-39), `422 limit-reached` (Q-40), `TargetConfigUpdate` (Q-41), `409 quest-completed` and `gamble-pending` on undo
  (Q-42, Q-43).
- **Added beyond the plan**: the daily goal evaluation as its own worker job with per-user due times (migration
  0007); the read-only `current_period`; security suites generated from the contract (ownership, consent, mass
  assignment) that fail when a new operation is not covered; batched reads for the unbounded archive.
- **Deferred**: Node 26.13.0 LTS — allowed from 2026-11-04 by the 7-day rule (`.nvmrc`, image digests, local
  install, CI), the first task of M4; the e2e user journey through the built image (verify → login → consent →
  achievement → quest → check-in → gamble → stats) needs the verification email locally, so it comes with the mail
  catcher (O-10) or with M4's export and deletion steps.
- **Effort**: planned 13–17 engineering days; the M3 commits landed on 2026-10-29 and 2026-10-30.

## Next

**M4 Privacy rights (5–7 engineering days)** after your "go": export (recent re-authentication, 2 per 24 h, audited),
account deletion with the 30-day grace period, crypto-shredding and tombstones, the retention of deactivated
accounts, no emails to accounts pending deletion (A-22). First Node 26.13.0 (on or after 2026-11-04). If you choose
(b) for O-09, I build it before M4 (about half a day); if you approve O-10, the contract freeze, the mail catcher and
`client-security.md` come first (about 1–2 days).
