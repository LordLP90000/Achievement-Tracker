import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  documentedRuntimeDependencies,
  inexactVersions,
  paymentPackages,
  undocumentedDependencies,
} from '../helpers/dependency-allowlist.ts';

interface PackageJson {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface PackageLock {
  packages: Record<string, { dev?: boolean; devOptional?: boolean }>;
}

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;

const FIXTURE = [
  '## 6. Folder structure',
  '| `not-a-dependency` | listed in another section |',
  '## 7. Runtime dependencies',
  '| Package | Version | Why |',
  '|---------|---------|-----|',
  '| `fastify` | 5.12.7 | HTTP |',
  '| `postgres` (postgres.js) | 3.4.9 | driver |',
  '## 8. Deployment',
  '| `also-not-a-dependency` | x |',
].join('\n');

describe('runtime dependency allowlist (architecture §7)', () => {
  it('reads the package names of section 7 only', () => {
    expect(documentedRuntimeDependencies(FIXTURE)).toEqual(['fastify', 'postgres']);
  });

  it('fails closed when section 7 is missing', () => {
    expect(() => documentedRuntimeDependencies('# Architecture\n## 6. Folder structure\n')).toThrow(/section 7/);
  });

  it('reports runtime dependencies that are not documented', () => {
    expect(undocumentedDependencies({ fastify: '5.12.7', 'left-pad': '1.3.0' }, ['fastify'])).toEqual(['left-pad']);
  });

  it('allows only runtime dependencies that are documented with a reason [T-10, R-SUP-01]', async () => {
    const [manifest, architecture] = await Promise.all([
      readJson<PackageJson>('package.json'),
      readFile('docs/architecture.md', 'utf8'),
    ]);

    expect(undocumentedDependencies(manifest.dependencies, documentedRuntimeDependencies(architecture))).toEqual([]);
  });
});

describe('dependency versions', () => {
  it('recognises ranges, tags and non-registry sources', () => {
    expect(
      inexactVersions({
        exact: '1.2.3',
        prerelease: '2.0.0-rc.1',
        caret: '^1.2.3',
        tilde: '~1.2.3',
        tag: 'latest',
        git: 'github:someone/package',
        file: 'file:../package',
        alias: 'npm:other@1.0.0',
      }),
    ).toEqual(['caret', 'tilde', 'tag', 'git', 'file', 'alias']);
  });

  it('pins every dependency to an exact registry version [R-SUP-01]', async () => {
    const manifest = await readJson<PackageJson>('package.json');

    expect(inexactVersions({ ...manifest.dependencies, ...manifest.devDependencies })).toEqual([]);
  });
});

describe('no payment software', () => {
  it('recognises payment SDKs by name', () => {
    expect(
      paymentPackages(['node_modules/stripe', 'node_modules/@paypal/checkout-server-sdk', 'node_modules/fastify']),
    ).toEqual(['node_modules/stripe', 'node_modules/@paypal/checkout-server-sdk']);
  });

  it('ships no payment SDK, directly or transitively [R-GMB-05]', async () => {
    const lock = await readJson<PackageLock>('package-lock.json');
    const production = Object.entries(lock.packages)
      .filter(([path, entry]) => path !== '' && entry.dev !== true && entry.devOptional !== true)
      .map(([path]) => path);

    expect(production.length).toBeGreaterThan(0);
    expect(paymentPackages(production)).toEqual([]);
  });
});
