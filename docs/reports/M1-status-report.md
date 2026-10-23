# STATUS REPORT – M1 Walking skeleton – 2026-10-22

**Overall: GREEN** — every M1 exit criterion is met and proven by tests; CI is green on `master` (runs #1–#3, all
7 jobs). Three small items are deferred to M2 with reasons (see *Scope or plan changes*). One decision is needed to
start M2 (O-02/O-03 handling), one before the first M2 endpoint ships (413/415 in the contract).

## Done

All commits are on `master` (direct pushes, ADR-0001 as amended).

- `07ed426` docs: trunk-based workflow (ADR-0001 amended); ADR-0002…0012 and the ADR-0015 engineering shape accepted
- `7d9f672` chore: toolchain — Node 26.12.1 pinned (`.nvmrc`, `engines`, `engine-strict`), TypeScript 6.0.3 strict,
  ESLint 10 strict type-checked + `eslint-plugin-regexp` + restricted imports/syntax, Prettier, Vitest 5
- `82297b7` feat(config): per-process config loaders (Zod) with production guards — `sslmode=verify-full`,
  trusted-proxy hops required, no debug logging, weak/placeholder/duplicate passwords refused; errors name the
  variable, never the value
- `b7056b2` feat(http): `buildApp()` — server-generated request IDs, security headers + `no-store` on every
  response, no CORS, JSON-only bodies (64 KiB, prototype poisoning rejected), RFC 9457 problems without internals
- `ae77e90` feat(logging): allowlist JSON logs — one line per request with the route *pattern*; never URL, query,
  headers, bodies, emails or tokens; errors by name/code; redaction as a second line of defence
- `3a3f74a` feat(health): `/health/live`, `/health/ready` (bounded DB probe → 503) and the contract harness: Ajv 2020
  strict validation of every response, spec-coverage gate with a shrink-only "not yet implemented" list (38 of 40
  operations), route-vs-spec test
- `0a0aba7` feat(db): idempotent bootstrap of three `NOBYPASSRLS` roles, Drizzle migrations (schema privileges,
  fail-closed RLS helper `app_current_user_id()`, worker-only `job_runs`), pooled client with statement and
  idle-in-transaction timeouts, transaction-scoped user context; Testcontainers harness (PostgreSQL 17 by digest)
- `0417bf7` feat: API, worker, migrate and db-init entrypoints (signals, exit codes, no values in messages)
- `a6db695` build(docker): image and Compose stack (database not published, API on 127.0.0.1 only, read-only root
  FS, `cap_drop: ALL`, `no-new-privileges`) and the e2e smoke test
- `8dcb87d` ci: GitHub Actions with 7 parallel jobs, lefthook hooks, Semgrep custom rules, dependency-cruiser rules,
  npm hardening (details under *Security & privacy*)
- `8d311d2` test(supply-chain): runtime dependency allowlist (threat T-10), exact versions, no payment SDK (R-GMB-05)
- `b236771` build(docker): distroless Node 26 runtime — no shell, no package manager (threat E-06, ADR-0017)
- this commit — docs: this report, ADR-0016/0017 (proposed), folder-structure corrections

## Tests

- **145 automated tests**: 59 unit tests (`src/**`) and 86 integration, contract, security and supply-chain tests
  (`test/**`, real PostgreSQL 17 via Testcontainers); plus **7 e2e checks** against the built image and the running
  Compose stack. All green locally (pre-push hook) and in CI.
- **Coverage**: 98.4 % statements · 96.9 % branches · 97.6 % functions · 100 % lines (gate 85 %; `src/domain` 95 %
  branches — no domain code yet). Excluded: the four three-line CLI wrappers, exercised by the e2e test.
- **Mutation**: the Stryker gate (break < 80 %) runs in CI but has nothing to mutate yet (`allowEmpty`, removed with
  the first `src/platform/crypto` file in M2).
- **Spec coverage**: 2 of 40 operations implemented and contract-tested (health); 38 listed as not yet implemented.
- **Red first, and proof that the guards bite**: every task started red; harness meta-tests reject contract
  violations; dependency-cruiser fired 5/5 rules on deliberate violations; the Semgrep rule tests were red first
  (3 missed member expressions); deleting the `fastify` row from the allowlist fails the supply-chain test; the
  e2e "no shell" check was red on the Alpine image.

| Exit criterion (plan M1) | Evidence |
|--------------------------|----------|
| All gates green on `master` | CI runs #1–#3 green, 7/7 jobs each (~1.5 min) |
| `docker compose up` serves `/health/ready` | e2e: Compose stack up with health checks → `GET /health/ready` 200 with security headers |
| Config refusal | `src/platform/config/config.test.ts` (35 tests); e2e: production start with weak settings → exit 1, no value printed |
| Security headers | `test/security/headers.test.ts`, `request-id.test.ts`, `trust-proxy.test.ts` |
| Problem format | `test/contract/problem-details.test.ts` (404/413/500 problems, no internals, I-03) |
| Log allowlist | `test/security/log-leakage.test.ts`, logger unit tests (I-02) |
| RLS fail-closed on a sample table | `test/security/rls.test.ts` (no context → no rows and no writes; invalid context → closed; I-04) |
| App role has no DDL | `test/security/db-roles.test.ts` (`create table` → 42501 for app and worker; no privileged role) |

## Security & privacy

- **New risks found and handled**
  - The first image (Alpine) still had a shell, contrary to the E-06 mitigation in the threat model → switched to
    distroless Node 26 (ADR-0017); the e2e test now proves there is no shell and no npm.
  - The Semgrep supply-chain rules flagged that npm resolved brand-new versions → `min-release-age=7` (ADR-0016).
  - Install scripts: lefthook's postinstall ran once before scripts were denied (it only wrote an example config
    and a no-op git hook in my clone) → npm now never runs install scripts (`ignore-scripts=true`).
  - Timing-unsafe secret comparison (I-10) and SSRF via non-constant URLs (I-21) are now CI-enforced by tested
    custom Semgrep rules, as the threat model promises; plus rules for `Math.random` and MD5/SHA-1.
- **Scan results** (CI and local, 2026-10-22): Semgrep 0 findings (116 rules incl. `p/typescript`, `p/nodejs`,
  `p/owasp-top-ten` and 4 custom rules, 83 files) · osv-scanner 0 · gitleaks 0 over the full history · Trivy 0
  HIGH/CRITICAL *including unfixed* (Debian 13.7 distroless) · `npm audit --omit=dev` 0 · CycloneDX SBOMs (npm:
  50 components; image) kept 90 days as CI artifacts.
- **Exceptions register** (each reviewed, all in the repository):
  - `osv-scanner.toml`: GHSA-67mh-4wv8-2f99 (esbuild dev-server CORS) — reachable only through drizzle-kit's
    dev-only loader, never in the image; expires 2027-01-31. It is also the 4 "moderate" findings of a full
    `npm audit`.
  - `.gitleaksignore`: 4 exact fingerprints for synthetic test passwords in `config.test.ts` history; the current
    lines carry `gitleaks:allow`.
  - 2 × `nosemgrep` in `src/platform/config/config.ts`: startup checks that DB passwords differ from the user name
    and from each other — operator input, compared once, no timing oracle.
- **Data-inventory changes**: none. M1 stores no personal data (only `job_runs`); logs contain none (tested).
- **New runtime dependencies** (R-SUP-01; 51 production packages in total, 0 known vulnerabilities):

  | Package | Version | Reason |
  |---------|---------|--------|
  | `fastify` | 5.12.7 | HTTP framework mandated by the stack |
  | `zod` | 4.6.7 | validation mandated by the stack; configuration parsing |
  | `pino` | 10.4.0 | structured logging (Fastify's own logger, used directly by the worker) |
  | `postgres` | 3.4.9 | PostgreSQL driver with zero dependencies |
  | `drizzle-orm` | 0.45.4 | parameterized query layer (ADR-0003) |

- **New dev dependencies**: `typescript`, `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-regexp`,
  `prettier`, `vitest`, `@vitest/coverage-v8`, `@redocly/cli`, `ajv`, `ajv-formats`, `yaml`, `testcontainers`,
  `@testcontainers/postgresql`, `drizzle-kit`, `@types/node`, `dependency-cruiser`, `@commitlint/cli`,
  `@commitlint/config-conventional`, `lefthook`, `@stryker-mutator/core`, `@stryker-mutator/vitest-runner`,
  `@cyclonedx/cyclonedx-npm`. Outside npm: gitleaks 8.30.1 on this machine (winget, user scope) for the pre-commit
  hook; CI scanners run as digest-pinned containers (Semgrep 1.182.0, osv-scanner 2.7.0, gitleaks 8.30.1, Trivy
  0.76.1, actionlint). No new external service, processor or cost (the repository is public, so CI is free).

## Decisions I made

| Decision | Reason |
|----------|--------|
| ADR-0016 (proposed): no install scripts, 7-day minimum release age, exact pins, runtime allowlist test, SHA/digest pinning, read-only CI token, exceptions only with reason (+ expiry) | R-SUP-01/02, T-10/T-11/E-07; trunk-based pushes have no review step |
| ADR-0017 (proposed): distroless Node 26 runtime instead of Alpine | E-06 "no shell"; passes the strict Trivy gate; similar size (290 MB vs 298 MB) |
| TypeScript 6.0.3 instead of 7 | typescript-eslint does not support TypeScript 7 yet; revisit when it does |
| Pre-push hook runs *all* local gates incl. integration tests (~25 s, Docker required) — more than ADR-0001 required | fast enough; keeps `master` green |
| Trivy fails on HIGH/CRITICAL *including unfixed*; osv-scanner fails on any severity | literal R-SUP-02 (and stricter for dependencies); exceptions only with expiry |
| CI: every push gets its own run, plus a nightly run; PR runs replace their predecessors | commitlint never skips a range; new advisories surface without pushes |
| Commit types = ADR-0001 list + `build`, `revert` | `build` was already in use; `revert` serves the fix-or-revert rule |
| ESLint security intent covered by core rules, restricted imports/syntax and Semgrep, not `eslint-plugin-security` | that plugin is mostly heuristic with many false positives; the Semgrep rules are tested |

## Decisions I need from you

| ID | Question | Options | My recommendation |
|----|----------|---------|-------------------|
| O-02 / O-03 | SMTP relay operator and 1Password Connect details are due "at the start of M2" | **start M2 against local test doubles** (local SMTP test server, fake Connect server), wire the real ones when you send the details (needed before staging, M6) · wait for the details | **start with test doubles** — no security control is skipped: TLS-only SMTP and the KEK rules will be tested against the doubles |
| Contract | The server already answers oversized and non-JSON bodies with 413/415 problems (R-IN-01, D-02), but `openapi.yaml` documents neither, so contract tests will fail as soon as the first of the 19 body-accepting operations is implemented | add `413` and `415` problem responses to those 19 operations (additive, non-breaking) · keep the contract and drop the statuses | **add them** (before the first M2 endpoint) |
| Privacy | The repository is public and every commit carries your e-mail address (`'laurent_scherrer@sluz.ch'`, with a stray apostrophe, also in the name `'Laurent`) | keep public and use your GitHub no-reply address for future commits · make the repository private (CI then counts against 2,000 free minutes/month; ≈ 10 billed minutes per push) · leave as is | **no-reply address for future commits** (`git config --global user.email 272163696+LordLP90000@users.noreply.github.com`); rewriting history to remove past addresses is destructive and only with your explicit OK |
| O-06 | Rank and gamble integrity rules | see the M0 report | needed before M3, not now |

ADR-0016/0017 and the assumptions A-26…A-28 become *accepted* with your "go" unless you object.

## Scope or plan changes

- **Deferred to M2** (no M2 work is blocked by them):
  - `FakeClock` (an M1 harness deliverable): nothing in M1 depends on time beyond durations and job timestamps; it
    is the first M2 task, needed by token lifetimes.
  - Readiness does not check the KEK source yet — there is no cryptography before M2.
  - 413/415 in the contract — your decision above.
- **Changed**: the runtime image moved from Alpine to distroless after the Docker task (ADR-0017). Rate limiting
  (and thus 429 on health/auth) arrives in M2 as planned.
- **Added beyond the plan**: nightly CI run, supply-chain allowlist test, `min-release-age`, actionlint, image SBOM
  next to the npm SBOM.
- **Docs corrected**: the folder structure promised `scripts/db-roles.sql`, `rls.sql` and a root `.env.example`;
  the code has `src/platform/db/bootstrap.ts`, the RLS helpers in migration 0000 and `docker/.env.example`.

## Next

**M2 Accounts & sessions (10–14 engineering days)**, test-first in this order: `FakeClock` → `platform/crypto`
(AEAD, envelope encryption, `LocalKeyWrapper`, `KekSource` with the 1Password Connect client, Argon2id with a
semaphore, blind index, tokens; Stryker gate becomes active) → `users`/`user_keys` → register, verify, login,
refresh, logout/logout-all, sessions, re-auth, password change/forgot/reset, two-step email change, consents, audit
events → rate limiting with progressive backoff → outbox + worker + `SmtpEmailSender` → retention jobs; security
suites S-01…S-12, E-01…E-03, E-07, E-08, E-11, E-12, I-02, I-03, I-07. Runtime dependencies to be added (already in
the allowlist, will be reported): `sodium-native`, `nodemailer`; dev: `smtp-server`, `fast-check`.

Housekeeping: pushing from your IDE now runs the hooks — Docker must be running (pre-push) and gitleaks must be on
`PATH` (restart the IDE once after the winget install). The fully merged `m0-plan` branch still exists on GitHub;
deleting it is your call.

---

## Addendum 2026-10-23 — review with the PM

**Live demo** (stack started with the README command, random local secrets in the git-ignored `docker/.env`):

| Shown | Result |
|-------|--------|
| Health | `/health/live` and `/health/ready` → 200 with all security headers and `no-store`; no server banner |
| Hostile requests | no CORS headers (also on a preflight); a spoofed `X-Request-Id` is ignored; unknown route → 404 problem whose `instance` drops `?token=…` |
| Logs | one allowlisted JSON line per request with the route pattern; the token, origin, spoofed ID, path and the four database passwords appear 0 times |
| Container | uid 65532, read-only root, `cap_drop: ALL`, `no-new-privileges`; no `sh` or `/bin/sh`; write to `/app` → `EROFS` |
| Database outage | `/health/ready` → 503 `degraded` after 2.0 s while `/health/live` stays 200; back to 200 1.7 s after the database restarted; no crash |
| Unsafe production settings | 3 of 3 refused with exit code 1 (weak password + no `verify-full` + no proxy setting; `debug` logging; placeholder password); messages name the variable and the rule, never the value |

**Findings**: (1) Docker's health probe produced one log line every 3 s (~29 000 per day and container);
(2) Fastify's own "Server listening at …" lines duplicated `api listening` and carried the container's internal
IP address. Neither is a security issue; both fixed before M2 (Q-28).

**Decisions** (recorded in `docs/requirements.md` §6.1): Q-25 document `413`/`415` on the 19 operations that accept a
body · Q-26 commits use the PM's no-reply address (repository-local git config, set the same day) · Q-27 M2 builds
against local stand-ins for SMTP and 1Password Connect; O-02/O-03 now needed before M6 · Q-28 fix both findings.

**Also observed**: the nightly CI run (03:17 UTC) has not fired yet — 0 scheduled runs while the workflow is active.
GitHub schedules are best-effort; checked again on the next day, investigated if still missing.

**Status**: M1 stays in REVIEW until the follow-ups (Q-25, Q-28) are pushed and green and the PM gives the "go".
