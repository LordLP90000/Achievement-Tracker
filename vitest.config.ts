import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    retry: 0,
    restoreMocks: true,
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'] } },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/**/*.test.ts'],
          exclude: ['test/e2e/**'],
          globalSetup: ['test/helpers/global-setup.ts'],
          // Real Argon2id (64 MiB) and PostgreSQL work runs in parallel across files; 5 s timed out once under load.
          testTimeout: 20_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The four process entry files are three-line wrappers around tested src/main modules; they are exercised
      // by the end-to-end smoke test against the built container image (test/e2e).
      exclude: ['src/**/*.test.ts', 'src/server.ts', 'src/worker.ts', 'src/migrate.ts', 'src/bootstrap-db.ts'],
      thresholds: {
        lines: 85,
        branches: 85,
        functions: 85,
        statements: 85,
        'src/domain/**': { branches: 95 },
      },
    },
  },
});
