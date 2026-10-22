# Questline API

Backend for **Questline**, a mobile achievement-tracking app. Users set an **Achievement**
(a big goal), break it into **Quests**, and record **Check-ins**; completing quests earns XP
and advances the achievement until it is unlocked.

Security, privacy and test-driven development are core requirements of this project, not extras.

## Status

The project is in **M1 – Walking skeleton**. See [`docs/PROGRESS.md`](docs/PROGRESS.md)
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
