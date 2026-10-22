// @ts-check
/**
 * Mutation testing (test strategy §6): break below 80 % on the domain engine and the crypto platform.
 * M1 scaffold: neither src/domain nor src/platform/crypto exists yet, so `allowEmpty` is set; remove it as soon
 * as the first file matches (M2 crypto).
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.unit.config.ts' },
  mutate: ['src/domain/**/*.ts', 'src/platform/crypto/**/*.ts', '!src/**/*.test.ts'],
  coverageAnalysis: 'perTest',
  thresholds: { high: 90, low: 80, break: 80 },
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  tempDirName: '.stryker-tmp',
  allowEmpty: true,
};
