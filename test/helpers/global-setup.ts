import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { bootstrapDatabase, databaseUrl } from '../../src/platform/db/bootstrap.ts';
import { runMigrations } from '../../src/platform/db/migrate.ts';
import { NOT_YET_IMPLEMENTED } from '../contract/not-yet-implemented.ts';
import type { DatabaseServer } from './database.ts';
import { specOperations } from './openapi.ts';
import { POSTGRES_IMAGE } from './postgres-image.ts';

const TEMPLATE_DATABASE = 'questline_template';
const randomSecret = () => randomBytes(24).toString('base64url');

async function coveredOperations(dir: string): Promise<Set<string>> {
  const files = await readdir(dir);
  const contents = await Promise.all(files.map((file) => readFile(join(dir, file), 'utf8')));
  return new Set(contents.flatMap((text) => text.split('\n')).filter((line) => line.length > 0));
}

/** Problems with spec coverage (ADR-0010): every operation must be tested or explicitly pending. */
export function specCoverageProblems(covered: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const { operationId } of specOperations) {
    const pending = NOT_YET_IMPLEMENTED.has(operationId);
    if (!pending && !covered.has(operationId)) {
      problems.push(`- ${operationId}: no contract-validated test exercises it`);
    }
    if (pending && covered.has(operationId)) {
      problems.push(`- ${operationId}: is tested — remove it from NOT_YET_IMPLEMENTED`);
    }
  }
  return problems;
}

/** One PostgreSQL container per run; a hardened, migrated template database is cloned per test file. */
async function startDatabaseServer(): Promise<{ server: DatabaseServer; stop: () => Promise<void> }> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('postgres')
    .withUsername('test_superuser')
    .withPassword(randomSecret())
    .start();
  const passwords = { migrator: randomSecret(), app: randomSecret(), worker: randomSecret() };
  const adminUrl = container.getConnectionUri();

  await bootstrapDatabase(adminUrl, { database: TEMPLATE_DATABASE, passwords });
  await runMigrations(
    databaseUrl(adminUrl, TEMPLATE_DATABASE, { user: 'questline_migrator', password: passwords.migrator }),
  );

  return {
    server: { adminUrl, host: container.getHost(), port: container.getPort(), template: TEMPLATE_DATABASE, passwords },
    stop: async () => {
      await container.stop();
    },
  };
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const coverageDir = await mkdtemp(join(tmpdir(), 'questline-contract-'));
  const database = await startDatabaseServer();
  project.provide('contractCoverageDir', coverageDir);
  project.provide('database', database.server);

  return async () => {
    await database.stop();
    const covered = await coveredOperations(coverageDir);
    await rm(coverageDir, { recursive: true, force: true });
    if (process.env['CONTRACT_COVERAGE'] === 'off') return;
    const problems = specCoverageProblems(covered);
    if (problems.length > 0) {
      throw new Error(
        `OpenAPI spec coverage failed (set CONTRACT_COVERAGE=off only for partial runs):\n${problems.join('\n')}`,
      );
    }
  };
}
