# Questline API

Backend for **Questline**, a mobile achievement-tracking app. Users set an **Achievement**
(a big goal), break it into **Quests**, and record **Check-ins**; completing quests earns XP
and advances the achievement until it is unlocked.

Security, privacy and test-driven development are core requirements of this project, not extras.

## Status

**M4 – Privacy rights** is in progress (M3 – Core domain is done, [report](docs/reports/M3-status-report.md)).
See [`docs/PROGRESS.md`](docs/PROGRESS.md)
for the current milestone and [`docs/DECISIONS.md`](docs/DECISIONS.md) for architecture decisions.

## Documentation map

| Document | Purpose |
|----------|---------|
| [docs/requirements.md](docs/requirements.md) | Restated requirements, assumptions, open questions |
| [docs/architecture.md](docs/architecture.md) | Architecture, folder structure, cross-cutting concerns |
| [docs/data-model.md](docs/data-model.md) | PostgreSQL data model incl. encryption and ownership scoping |
| [openapi/openapi.yaml](openapi/openapi.yaml) | OpenAPI 3.1 contract (written first, enforced by contract tests); frozen since `0.3.0` (2026-11-02) — it only grows, each change approved by the PM ([snapshot](openapi/frozen/openapi.yaml)) |
| [docs/security/threat-model.md](docs/security/threat-model.md) | STRIDE threat model: threat → mitigation → test |
| [docs/privacy/data-inventory.md](docs/privacy/data-inventory.md) | Data inventory (purpose, legal basis, retention, location) |
| [docs/privacy/dpia.md](docs/privacy/dpia.md) | DPIA draft |
| [docs/privacy/processors.md](docs/privacy/processors.md) | External processors (each requires PM approval) |
| [docs/test-strategy.md](docs/test-strategy.md) | Test layers, determinism rules, coverage & mutation targets, CI gates |
| [docs/client-security.md](docs/client-security.md) | Security guidance for the mobile app (OWASP MASVS-aligned) |
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
| `npm run build:password-filter` | Rebuilds the committed breached-password filter from the pinned, checksum-verified list (ADR-0012; needs network access) |
| `npm run test:e2e` | Builds the image and checks the running Compose stack (non-root, read-only, no shell or package manager, no secrets in logs) |
| `docker compose -f docker/compose.yml up --build` | Local stack (copy `docker/.env.example` to `docker/.env` first); API on `127.0.0.1:3000`, mail catcher on `127.0.0.1:8025` |

For a partial test run (single files), set `CONTRACT_COVERAGE=off` so the spec-coverage gate does not fail.

Work is pushed directly to `master` (ADR-0001); never bypass a hook with `--no-verify`. CI
(`.github/workflows/ci.yml`) runs every gate on each push and nightly: the checks above, Stryker, Semgrep (registry
rulesets and the tested custom rules in `.semgrep/`), osv-scanner, gitleaks over the full history, Trivy on the
built image, CycloneDX SBOMs (build artifact) and the e2e smoke test. A red pipeline is fixed or reverted first.

## Local stack for the app team

Needs only Docker. The stack runs the API, the worker, PostgreSQL and a mail catcher on your machine; nothing is sent
anywhere, so use made-up addresses only.

1. Copy `docker/.env.example` to `docker/.env` and replace every placeholder with a random value (the file shows how).
2. Start it: `docker compose -f docker/compose.yml up --build`. The API listens on `http://127.0.0.1:3000/v1`
   (`API_PORT`), the mail catcher's inbox on `http://127.0.0.1:8025` (`MAIL_UI_PORT`); both only on your machine.
3. Sign up with `POST /v1/auth/register`: the verification email appears in the mail catcher. Its link ends in
   `#token=…` — the app sends that token to `POST /v1/auth/verify-email` (A-32). Set `PUBLIC_LINK_BASE_URL` in
   `docker/.env` to the address your app's links use; it is `https://questline.test` otherwise.

The contract is [`openapi/openapi.yaml`](openapi/openapi.yaml), frozen as `0.3.0`: it only grows, so ignore
properties and enum values you do not know yet. Read [`docs/client-security.md`](docs/client-security.md) before
building against it (token storage, refreshing, retries, sensitive operations). The iOS simulator reaches the stack
directly, the Android emulator at `10.0.2.2`, a USB-connected Android device after `adb reverse tcp:3000 tcp:3000`.
Emails go over TLS only, with a throw-away certificate made inside Docker on the first start and kept for a year
(ADR-0018). `docker compose -f docker/compose.yml down --volumes` resets everything: database, emails and
certificate.
