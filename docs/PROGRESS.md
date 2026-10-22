# Progress log

Updated after every completed task (date, task, tests, commit). Newest entries at the bottom of each milestone.

## Milestone status

| Milestone | Name | Status | Branch | Report |
|-----------|------|--------|--------|--------|
| M0 | Plan | REVIEW | `m0-plan` | [docs/reports/M0-status-report.md](reports/M0-status-report.md) |
| M1 | Walking skeleton | not started | – | – |
| M2 | Accounts & sessions | not started | – | – |
| M3 | Core domain | not started | – | – |
| M4 | Privacy rights | not started | – | – |
| M5 | Auth hardening | not started | – | – |
| M6 | Hardening & handover | not started | – | – |

Legend: `not started` · `IN PROGRESS` · `REVIEW` (report sent, waiting for PM "go") · `DONE`

## M0 – Plan

Goal: no production code. Restate requirements, list assumptions and open questions, propose architecture,
folder structure, data model and OpenAPI draft, threat model (STRIDE), data inventory, DPIA draft,
test strategy, hosting options and effort per milestone.

| Date | Task | Tests | Commit |
|------|------|-------|--------|
| 2026-10-22 | Repository set up: GitHub remote `LordLP90000/Achievement-Tracker` (default branch `master`), PM reporting docs created, branch `m0-plan` opened | n/a (docs only) | `2c1ddee` |
| 2026-10-22 | Requirements restated with IDs; assumptions A-01…A-19; open questions Q-01…Q-24 with options and recommendations (`docs/requirements.md`) | n/a | `b59efdb`, `499fbfc`, `ea5856d` |
| 2026-10-22 | Architecture, request lifecycle, platform components, folder structure, planned runtime dependencies (`docs/architecture.md`) | n/a | `639d97a` |
| 2026-10-22 | Data model: 18 tables, encryption markers, RLS policies, roles/grants, deletion cascade, export shape (`docs/data-model.md`) | n/a | `92b8e7a` |
| 2026-10-22 | OpenAPI 3.1 draft: 33 operations, problem schemas, idempotency/concurrency conventions (`openapi/openapi.yaml`) | Redocly lint: valid, 0 warnings | `9a74220` |
| 2026-10-22 | STRIDE threat model: 60+ threats → mitigations → planned tests; encryption scope statement; E2E evaluation; residual risks (`docs/security/threat-model.md`) | n/a | `a4d9321` |
| 2026-10-22 | Data inventory (md + machine-readable yaml), DPIA draft (14 risks), processors register (`docs/privacy/*`) | n/a | `499fbfc` |
| 2026-10-22 | Test strategy: layers, harness, domain test plan incl. DST vectors, requirement→test catalogue, gates, CI pipeline (`docs/test-strategy.md`) | n/a | `2bd8cd4` |
| 2026-10-22 | Hosting/KMS/email options with recommendation; milestone plan with effort 44–62 days (`docs/hosting-options.md`, `docs/plan.md`) | n/a | `ea5856d` |
| 2026-10-22 | M0 status report written, branch pushed, PR requested | n/a | `0531c4f` |
| 2026-10-22 | PM answered all open questions Q-01…Q-24 (incl. sub-questions); requirements v2, ADR-0013…0015, data model, plan, threat model (T-16…T-18, E-11…E-13), DPIA (R-15, R-16), processors, hosting note updated | n/a | `87acdae`, `db38345`, `eb3f024` |
| 2026-10-22 | OpenAPI v2 (`0.2.0-draft`, 40 operations — v1 had 38, not 33 as logged above): statuses without `archived`, rank/score/attempt, quest `needs_restart`/effective `xp`/`duration_factor`/`reset_count`, check-in `attempt`/`counts_for_progress`, gamble endpoints, `Effects`/`Stats` extended, `age_confirmed`, `week_start`, `DELETE /me` → `202`; fixed `allOf` + `additionalProperties` bug in `CheckInResult`/`AchievementDetail`; proposed A-26…A-28; open item O-06 (rank/gamble integrity) | Redocly lint: valid, 0 warnings; Ajv 2020 strict check of 42 sample instances (scratch script, not committed): all as expected | this commit |
| **open** | Remaining M0 docs: `data-inventory.yaml` v2, test-strategy rows, architecture (1Password Connect, SMTP), cross-reference check, final report. Then **PM "go" for M1**. | – | – |
