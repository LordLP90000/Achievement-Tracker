import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { NOT_YET_IMPLEMENTED } from '../contract/not-yet-implemented.ts';
import { specOperations } from './openapi.ts';

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

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const dir = await mkdtemp(join(tmpdir(), 'questline-contract-'));
  project.provide('contractCoverageDir', dir);

  return async () => {
    const covered = await coveredOperations(dir);
    await rm(dir, { recursive: true, force: true });
    if (process.env['CONTRACT_COVERAGE'] === 'off') return;
    const problems = specCoverageProblems(covered);
    if (problems.length > 0) {
      throw new Error(
        `OpenAPI spec coverage failed (set CONTRACT_COVERAGE=off only for partial runs):\n${problems.join('\n')}`,
      );
    }
  };
}
