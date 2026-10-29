import { defineConfig } from 'vitest/config';

/** Unit tests only (no Docker): used by Stryker and by the pre-push gate. */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Fixed fast-check seed for the domain property tests, as in vitest.config.ts.
    setupFiles: ['test/helpers/fast-check-setup.ts'],
    retry: 0,
    restoreMocks: true,
  },
});
