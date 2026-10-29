# Questline API

Backend for **Questline**, a mobile achievement-tracking app. Users set an **Achievement**
(a big goal), break it into **Quests**, and record **Check-ins**; completing quests earns XP
and advances the achievement until it is unlocked.

Security, privacy and test-driven development are core requirements of this project, not extras.

## Status

**M2 – Accounts & sessions** is in progress (M1 – Walking skeleton is done, [report](docs/reports/M1-status-report.md)).
See [`docs/PROGRESS.md`](docs/PROGRESS.md)
for the current milestone and [`docs/DECISIONS.md`](docs/DECISIONS.md) for architecture decisions.

## Documentation map

| Document | Purpose |
|----------|---------|
| [docs/requirements.md](docs/requirements.md) | Restated requirements, assumptions, open questions |
| [docs/architecture.md](docs/architecture.md) | Architecture, folder structure, cross-cutting concerns |
| [docs/data-model.md](docs/data-model.md) | PostgreSQL data model incl. encryption and ownership scoping |
| [openapi/openapi.yaml](openapi/openapi.yaml) | OpenAPI 3.1 contract (written first, enforced by contract tests) |
| [docs/security/threat-model.md](docs/security/threat-model.md) | STRIDE threat model: threat → mitigation → test |
| [docs/privacy/data-inventory.md](docs/privacy/data-inventory.md) | Data inventory (purpose, legal basis, retention, location) |
| [docs/privacy/dpia.md](docs/privacy/dpia.md) | DPIA draft |
| [docs/privacy/processors.md](docs/privacy/processors.md) | External processors (each requires PM approval) |
| [docs/test-strategy.md](docs/test-strategy.md) | Test layers, determinism rules, coverage & mutation targets, CI gates |
| [docs/hosting-options.md](docs/hosting-options.md) | Hosting / KMS / email options in Switzerland and the EU |
| [docs/plan.md](docs/plan.md) | Milestone plan and effort estimates |

## Stack (fixed)

TypeScript (strict) on Node.js LTS · Fastify · PostgreSQL · Zod · Drizzle (parameterized queries only) ·
Vitest + Testcontainers · Docker · REST/JSON under `/v1` · OpenAPI 3.1.

## Development

Prerequisites: Node.js 26 (`.nvmrc`; `npm ci` refuses other versions), a running Docker engine (integration
tests start PostgreSQL with Testcontainers) and [gitleaks](https://github.com/gitleaks/gitleaks) on `PATH` for the
pre-commit secret scan (Windows: `winget install Gitleaks.Gitleaks`).

| Command | Purpose |
|---------|---------|
| `npm ci` | Install exactly the locked dependencies (install scripts are disabled in `.npmrc`; versions younger than 7 days are never resolved) |
| `npx lefthook install` | Once per clone: git hooks — gitleaks on staged changes (pre-commit), commitlint (commit-msg), `npm run check` (pre-push) |
| `npm run check` | All local gates, as run by the pre-push hook: format, lint, typecheck, import boundaries, OpenAPI lint, tests with coverage |
| `npm run lint` · `npm run typecheck` · `npm run format:check` · `npm run lint:openapi` · `npm run deps:check` | Single static checks |
| `npm test` | Unit, integration, contract and security tests (Docker required); fails if an OpenAPI operation is neither tested nor listed in `test/contract/not-yet-implemented.ts` |
| `npm run test:coverage` | Same with coverage thresholds (85 % overall, 95 % branches in `src/domain`) |
| `npm run mutation` | Stryker mutation testing of `src/domain` and `src/platform/crypto` (breaks below 80 %) |
| `npm run test:e2e` | Builds the image and checks the running Compose stack (non-root, read-only, no shell or package manager, no secrets in logs) |
| `docker compose -f docker/compose.yml up --build` | Local stack (copy `docker/.env.example` to `docker/.env` first); API on `127.0.0.1:3000` |

For a partial test run (single files), set `CONTRACT_COVERAGE=off` so the spec-coverage gate does not fail.

Work is pushed directly to `master` (ADR-0001); never bypass a hook with `--no-verify`. CI
(`.github/workflows/ci.yml`) runs every gate on each push and nightly: the checks above, Stryker, Semgrep (registry
rulesets and the tested custom rules in `.semgrep/`), osv-scanner, gitleaks over the full history, Trivy on the
built image, CycloneDX SBOMs (build artifact) and the e2e smoke test. A red pipeline is fixed or reverted first.
