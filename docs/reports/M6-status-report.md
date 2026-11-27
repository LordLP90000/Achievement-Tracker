# STATUS REPORT – M6 Hardening & handover – 2026-11-05

*Addendum of 2026-11-25 at the end: CI was red, and I fixed its cause without an exception, by a change to the
runtime image that waits for your approval (O-14); M6 cannot close without your decisions, and how it ends is one of
them.*

**Overall: AMBER.** Everything in M6 that needs no decision from you is built test-first and green on `master`:

- the restore with its replay, which also re-applies what users changed since the restore point (Q-57)
- the KEK rotation and the blind-index key rotation, as maintenance commands
- the load and limit test (k6) and the ZAP API scan, passive and active and signed in, against the local stack
- the four runbooks: restore, key rotation, breach notification, operations
- the API reference, and the review package for the data-protection expert

The rest waits for your decisions: the staging deployment, the real relay and Connect server, the domain and the
policy texts (see *Decisions I need from you*). CI was red on runs #125–#129, from a new CVE in the base image's
`zlib1g` until your exception Q-54, and green on every push since (#130–#148). You decided Q-54 to Q-60 during M6.

## Done

All commits are on `master`, each test-first with a `docs/PROGRESS.md` row.

- `9bea04c` M6 kickoff with the task plan; `d5cf4a7` closed M5
- `3334086`, `8936b81` the API reference: a static page built offline from the contract, a CI artifact of every
  commit
- `ceeaec9` the Trivy exception for `zlib1g` until 2026-11-30 (Q-54); `8695989` the languages stay en, de, fr, it
  (Q-55)
- `a843b8d`, `95ac9e9`, `88dbb71`, `4f14755`, `b53e54a`, `95c722d` restore: the maintenance entrypoint
  (ADR-0020), the restore drill in the built image, and `replay-after-restore`, which deletes again what users
  deleted and re-applies what they changed since the restore point, then ends every session (Q-57)
- `d083571` data keys unwrap by the KEK's 1Password item, not by its version (Q-56): one edit of the item would
  otherwise have made every key unreadable
- `5c27cfc`, `7792834`, `8bd675a` key rotation: `rewrap-data-keys` and `reindex-email-blind-index`, each with a drill
  in the built image
- `cd04cc7` the last mutation survivors in `platform/crypto`: every mutant detected
- `86fc7c4` the key-rotation runbook, and the restore runbook re-keys before the replay (see *Security*)
- `ad0ed6b`, `72fc2fc` k6 and ZAP (Q-58, Q-59), `RATE_LIMIT_SCALE` for the scan's stack only (Q-60), a nightly CI job
- `68e3868`, `716ca67` the breach-notification and operations runbooks
- `ea6119d` the review package and DPIA v0.6
- this commit: this report

## Tests

- **Automated tests**: 2 270 in 140 files (M5: 2 138 in 130), coverage 98.9 % of statements and 96.9 % of branches,
  plus 16 e2e checks against the built image (M5: 13). All green locally and in CI.
- **Drills in the built image, every CI run**: a restore with the replay; a KEK rotation; a blind-index key rotation.
- **Mutation testing**: every mutant in `platform/crypto` detected. The 11 survivors left from M2: 3 equivalent,
  removed by simplifying the code; 8 real gaps, now tested.
- **Load and limits (k6, local stack)**: 150 requests of one user at once get 120 answers, 40 sign-ins of one client
  get 20, the sixth wrong password starts a 1-minute block; ten users in ordinary use meet no limit, p95 54–89 ms,
  no `5xx`. The limits of A-31 stand as they are.
- **DAST (ZAP, local stack)**: passive and active, signed in, about 16 400 requests; every one of the 34 operations
  that need a session reached; no high alert and no `5xx`. One low warning, by design: the export shows the user
  their own truncated network prefix.

## Security & privacy

- **Found and fixed while writing the key-rotation runbook**: the restore runbook rotated keys after the replay. But
  the replay compares addresses by their blind index, so after a blind-index rotation it would have taken every
  address for a move and missed a purged account holding a moved address under the old key. The keys now come first;
  an integration test shows both orders.
- **Found and fixed by the scan's own coverage check**: the first ZAP runs never sent the token (ZAP split the header
  value at its space), so they covered only the public operations. The runner now fails unless every operation that
  needs a session answered the scan, no `5xx` occurred and the session survived.
- **`RATE_LIMIT_SCALE`** (Q-60) exists for the scan only: production refuses it at start, and a scaled API warns.
- **The ZAP image** carries 17 critical and 460 high CVEs (Debian base, Firefox, OpenJDK). You accepted it for test
  use only (Q-59): no capabilities, an internal network with no route out, re-pinned regularly. k6 has 7 high, all
  fixable.
- **Trivy exception Q-54** (`zlib1g`, unreachable) expires on 2026-11-30: I check Debian's fix before then.
- **DPIA v0.6**: R-1, R-3 and R-8 updated with M6's measures; residual risks unchanged.

## Decisions I made

- The restore runbook brings the keys up to date before the replay: re-wrap, then re-index, then replay.
- The scan leaves out the four operations that would end its session or withdraw its consent: deleting the account,
  logout, logout everywhere, withdrawing consent. The integration and e2e tests cover them.
- The tool containers run without capabilities on an internal network shared with the API alone; the token reaches
  ZAP through a file, never a command line.
- `kekField` checks the size of a 1Password item before parsing it, and keeps JSON errors, which quote the body and
  with it the key, out of the log.
- The breach runbook uses `replay-after-restore` without a replaced database to end every session; no new command.

## Decisions I need from you

Unchanged since M5, and still blocking the rest of M6:

| ID | Decision | Blocks |
|----|----------|--------|
| O-01 | The hosting option, a staging budget, and the IaC tool for `deploy/` | Staging, and the restore, rotation, k6 and ZAP runs there |
| O-02 | The SMTP relay operator | Real email delivery; DPIA R-7 and R-9 |
| O-03 | The 1Password Connect details (vault, item, server) | The real KEK source |
| Q-19 | The domain | The TLS check (I-08) and the files the apps need for passkeys |
| O-04 | The consent text, the privacy policy and the controller's identity | The policy draft in the review package |

New, from the runbooks, for the M6 review:

- **A schedule for planned key rotations**: decided on 2026-11-05 (Q-63): the KEK and its Connect token yearly.
- **How to inform many users at once after a breach**: decided on 2026-11-05 (Q-61): a maintenance command.
- **A tabletop exercise of the breach runbook** with you.

## Scope or plan changes

- k6 and ZAP ran against the local stack first (Q-58), not staging; both repeat on staging once it exists.
- M6 grew by Q-57 (+1.5 days, recorded in the plan) and by `RATE_LIMIT_SCALE` (Q-60, a few hours).
- The DP-expert review package went out without the policy draft (O-04), as agreed at the M5 review.

## Next

- Check the first nightly run of the new `perf` job (2026-11-06): its Linux path has not run yet.
- Once you decide O-01: the IaC in `deploy/`, the staging deployment, and the restore, rotation, k6 and ZAP runs
  there. Then O-02, O-03 and Q-19 as you decide them.
- Add the policy draft to the review package with O-04.
- Before 2026-11-30: the Trivy exception Q-54.

**Status**: M6 is **IN PROGRESS**: the work without your decisions is done; staging and the real services wait for
them.

## Addendum – 2026-11-25

Where M6 stands twenty days later. The sections above are as written on 2026-11-05. Updated on 2026-11-27 with the
CI runs of `1e19d32`, which are green; everything else is as written on 2026-11-25.

### Done since

- `c5b308f` contract 0.4.8: the export lists every audit event type (Q-64)
- `0e7c2a3` the runtime image with Debian's zlib fix. The exception Q-54 is gone, so the lines above about its expiry
  no longer apply
- `c6b6502` the app design package (`docs/design/`): pass 2 and the prototype are for your review
- `7afc5b4` the incident notice (Q-61): two maintenance commands, ADR-0021 proposed, rehearsed in the e2e suite
- `82d6519` the red CI analysed and put to you (O-14)
- `779c79f` English drafts of the privacy policy and the consent text (Q-62), now in the review package
- `1713bad` the backend follow-ups of the design review as open items with proposals (O-17 to O-19)

You then asked me to finish M6. Its four remaining tasks wait for your decisions, so I looked for what M6 could
still finish without one:

- `5296abc` four ADRs named test files that were never created under those names; each now names the tests that
  cover it
- `e023441` the local stack builds its image once. On Docker's containerd image store, the default of new
  installations, `docker compose up --build` failed now and then, the app team's command in the README included
- `5563300` a finding I did not fix, made while measuring the export: the cost of every read grows with the
  check-ins of an attempt (threat D-12, O-20)
- `a73cf4b` **the export is read and sent in bounded parts** (threat D-09, ADR-0022 proposed, migration 0012). The
  threat model had left "streaming if a maxed-out account needs it" to M6's load test, and that test never covered
  the export. It needed it: with 345 600 check-ins, two days of one account at its rate limit, one export took
  1.2 GB of memory and kept the API from answering anyone for 2.8 s. Now memory stays near 20 MB and the longest
  pause under 50 ms, whatever the account holds; the document is the same byte for byte
- `324930a` a second finding I did not fix. The threat model and the test strategy have named a nightly timing
  comparison against account enumeration since M0; it was never built, so I measured it. A login and a registration
  take the same time for every address, within a millisecond in a hundred. Forgot-password and resend-verification
  do not: 2.4 to 3.5 ms longer for an account (O-21)

Then you told me that the jobs still fail:

- `1e19d32` **the runtime image without the libraries that nothing in it uses.** Trivy had a third finding by
  then, in the system zstd. Every finding that ever failed the image job was in one of three Debian packages of the
  base image: its system OpenSSL, and the zstd and zlib that only that OpenSSL needs. Node.js brings its own and
  loads none of them. The image is now built without the three, and the build fails if anything that stays needs
  them (ADR-0017, an amendment proposed for your approval; O-14). No exception was added

### CI and tests

- **CI was red from the nightly run of 2026-11-21 to that of 2026-11-25** (#170–#176), only in Trivy. First two HIGH
  findings in the system OpenSSL of the base image (`libssl3t64`), both denial-of-service bugs in OpenSSL's QUIC code
  that OpenSSL itself rates Low; from 2026-11-25 a third, in the system zstd (`libzstd1`). In those days Debian had
  no fix for the first two, the newest base image carried all three, and nothing in our image could reach the code:
  Node never loads these libraries and cannot speak QUIC.
- Every other job stayed green, the nightly `perf` job included: k6 and ZAP now run on CI's Linux runners. Run #175,
  your push of `324930a` today, shows the same: the static checks, the tests, mutation testing, Semgrep, osv-scanner
  and gitleaks green, the image job stopped at Trivy.
- **`1e19d32` took the cause away, without an exception, and CI is green again.** Before the push I ran CI's image
  job on this machine, step by step with CI's own images and commands: the build; Trivy, which passes on the 12
  Debian packages that remain, with `.trivyignore.yaml` empty; both SBOMs; and the e2e suite on the new image, 19 of
  19 — the 17 of before and two new checks that compare our image with the distroless image, path by path. CI then
  showed the same. Run #177, your push of `1e19d32` on 2026-11-25, is green in all seven jobs of a push; in its image
  job the build, Trivy, both SBOMs and the e2e smoke test passed. Run #178, the nightly run of 2026-11-26 on the same
  commit, is green in all eight: the `perf` job, which I had not run here, ran k6 and ZAP on the new image for the
  first time.
- While CI was red its image job stopped before the e2e smoke test, and the README's rule is that a red pipeline is
  fixed first. Up to `1713bad` I therefore changed documents only. **The export (`a73cf4b`) was the exception**: it
  changes the image and adds a migration. I judged closing a way to exhaust the API's memory worth more than keeping
  the image still, and verified it with every local gate and the e2e suite on the built image. CI had not run that
  suite since #169, on 2026-11-20; run #177 was the first to run it on the export change, and it passed.
- Local gates on `1e19d32` (`npm run check`): 2 353 tests in 146 files, coverage 98.8 % of statements and 96.6 %
  of branches; Semgrep 0 findings; gitleaks no leaks.

### Decisions I made

- **The runtime image without its system OpenSSL, zstd and zlib (ADR-0017, an amendment proposed).** This morning I
  recommended an exception and did not propose this. Three things changed. Trivy failed for the third time in three
  weeks on a library that nothing in the image uses. You told me the jobs still fail, and an exception is yours to
  decide, not mine to add. And I found a simpler way than the one I had ruled out: not a runtime assembled by us,
  but the same pinned distroless image minus three packages, with a build step that refuses if anything left needs
  them. It amends a decision you accepted, so it is yours to confirm; it is one commit, and reverting it undoes it.
  Two things you should know before you decide. The image now holds the distroless image's files, no longer its
  layers; an e2e check compares the two, path by path, on every run. And no scanner in CI ever saw the OpenSSL, zlib
  and zstd that Node.js itself bundles, which are now the only ones in the image. That limit is not new, but I had
  not written it down: it is in the threat model now (T-10), and the weekly routine reads Node.js's security
  releases. Today Node's bundled zstd is in the range of the zstd finding; I found no way to reach it.
- **The export's design (ADR-0022, proposed).** Three things change for the user, and they are yours to approve:
  the parts of the document are no longer read at one instant, so what the user changes while it is written may
  show in one section and not in another; the audit event is stored before the document is read and stays if the
  document fails, so a failed export counts as one of the two a day; a failure after the first piece cannot become
  a problem response any more, so the connection is cut and the API logs `export interrupted`. The contract is
  unchanged.
- **I did not build the fix for O-20.** Two of its three options are product decisions, and the fix is in the core
  of M3: not a change to stack on a red CI without your word.
- **Nor the one for O-21.** M2's report put that residual to you as impractical to exploit, and you accepted it on
  my word. The figures show it is practical for an attacker close to the server, so it is yours to decide again.
- **One service builds the image** in the local stack (`db-init`); no command changes.

### Decisions I need from you, the most urgent first

| ID | Decision | I recommend | It blocks |
|----|----------|-------------|-----------|
| O-14 | ADR-0017's amendment, the runtime image without its unused system OpenSSL, zstd and zlib: accept it, or prefer exceptions for the three findings | Accept it as built. If you prefer exceptions, I revert the commit and add the three, until 2027-01-31 | Nothing while it stands. Reverted, CI is red again until the exceptions are in |
| O-04 | The two drafts: approve or correct them; the controller's name, address and privacy contact; who writes the terms of use | – | The translations; the review package complete |
| O-15 | Recording a newer version of the consent text for accounts that already agreed | An additive contract change, before launch | Changing the consent text later without deleting anyone's goals |
| O-16 | How requests the app cannot serve are handled | The expert's answer first, then a maintenance command that deletes one account | What the policy draft promises in §8 |
| O-17 | `Quest.reminder` and `Achievement.hide_numbers`: the shape (contract 0.4.9) | As proposed in O-17, the reminder stored encrypted | Reminders that follow the user to every device |
| O-18 | The smaller rank-bonus scale | Each rank twice the one below: ×0.5 to ×32 | – |
| O-19 | The email when a deletion is complete: the address is kept up to 24 hours longer | As proposed in O-19 | – |
| O-20 | Reads that get slower with every check-in of an attempt: 36 ms at 2 500, 533 ms at 100 000, and the last blocks everyone for 282 ms | The engine reads the counts per quest and day from the database instead of the rows: about two days, no rule and no contract changes | Launch: one patient account can slow the service for all |
| O-21 | Forgot-password and resend-verification answer 2.4 to 3.5 ms later for an account than for an unknown address: one request per address tells them apart from a machine close to the server | The mail endpoints answer no sooner than about 100 ms after the request arrived, so the work no longer shows; the measurement becomes the nightly check that was planned | Launch: R-AUTH-07 does not hold against such an attacker |
| ADR-0021 | The incident notice's design | Accept it as built | – |
| ADR-0022 | The export in bounded parts, with the three changes under *Decisions I made* | Accept it as built | – |
| – | **How M6 ends.** Four of its tasks cannot start: staging (O-01 and a budget), the runs on staging, the real relay and Connect server (O-02, O-03), the domain (Q-19). Either M6 stays open until they are done, or it closes with what needs no host and the four move into a new milestone M7, "Staging & launch", with what launch still needs (O-15, O-16, O-20, O-21, the translations) | Close M6 and open M7, once O-14, ADR-0021 and ADR-0022 are decided. The work is the same either way; a milestone that waits for a host for weeks tells you less than one that is closed with its open ends named | The M6 review and your "go"; the plan for M7 |
| – | App design: pass 2 and the prototype | – | The app team's work on those screens |

Unchanged: O-01, O-02, O-03 and Q-19 (staging, the real relay and Connect server, the domain), O-08 (a native
speaker's review of the email texts) and the tabletop exercise of the breach runbook.

### Next

- From 2026-11-29: the update to Node 26.13.1, a security release, with the distroless image of 2026-11-22, as a
  step of its own. Only the 7-day rule holds it until then, no finding any more: built on that image today, ours
  passes Trivy.
- With your decision on how M6 ends: either the final M6 report for your review and a plan for M7 with its effort,
  or the staging tasks as soon as O-01 is decided.
- With your answers: O-20 and O-21 first, then O-15, O-17, O-18 and O-19, test-first, each with its change to the
  contract or the requirements.
- With the approved drafts: the German, French and Italian versions.

**Status**: M6 is still **IN PROGRESS**. What it can finish without your decisions is finished.
