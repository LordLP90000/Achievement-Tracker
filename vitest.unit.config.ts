import { defineConfig } from 'vitest/config';

/** Unit tests only (no Docker): used by Stryker and by the pre-push gate. */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    retry: 0,
    restoreMocks: true,
  },
});
