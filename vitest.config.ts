import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    retry: 0,
    restoreMocks: true,
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'] } },
      { extends: true, test: { name: 'integration', include: ['test/**/*.test.ts'], exclude: ['test/e2e/**'] } },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
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
