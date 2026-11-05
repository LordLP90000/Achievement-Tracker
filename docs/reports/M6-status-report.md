# STATUS REPORT – M6 Hardening & handover – 2026-11-05

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