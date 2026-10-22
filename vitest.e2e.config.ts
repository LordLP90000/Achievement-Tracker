import { defineConfig } from 'vitest/config';

/** End-to-end smoke tests against the built container image (Docker required). */
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    retry: 0,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 900_000,
  },
});
