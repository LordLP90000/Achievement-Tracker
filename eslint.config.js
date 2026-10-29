// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import regexp from 'eslint-plugin-regexp';
import tseslint from 'typescript-eslint';

const forbiddenModules = [
  'child_process',
  'node:child_process',
  'vm',
  'node:vm',
  'worker_threads',
  'node:worker_threads',
];

const FORBIDDEN_MODULE_PATHS = forbiddenModules.map((name) => ({
  name,
  message: 'Spawning processes or evaluating code is not allowed in this codebase.',
}));

/** Repositories use the query builder; hand-written SQL fragments are reviewed in src/platform/db only. */
const SQL_FRAGMENTS = {
  group: ['drizzle-orm'],
  importNames: ['sql'],
  message:
    'Write SQL fragments in src/platform/db (e.g. expressions.ts); repositories use the query builder (ADR-0003).',
};

const RAW_SQL = {
  selector: 'MemberExpression[object.name=/^(sql|tx)$/][property.name=/^(raw|unsafe)$/]',
  message: 'Raw SQL is only allowed inside src/platform/db (ADR-0003).',
};

const CLOCK_MESSAGE = 'Inject a Clock (src/platform/time) instead of reading the time (architecture §4.6).';
const CLOCK_READS = [
  { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: CLOCK_MESSAGE },
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: CLOCK_MESSAGE },
  { selector: "CallExpression[callee.type='Identifier'][callee.name='Date']", message: CLOCK_MESSAGE },
  { selector: "MemberExpression[object.name='Temporal'][property.name='Now']", message: CLOCK_MESSAGE },
];

const RANDOMNESS = {
  selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
  message: 'The domain is pure: no randomness.',
};

export default defineConfig(
  // .semgrep/ holds Semgrep rule tests with deliberate violations; they are checked by `semgrep --test` in CI.
  globalIgnores([
    'dist/',
    'coverage/',
    'reports/',
    '.stryker-tmp/',
    '.semgrep/',
    'docs/',
    'openapi/',
    '.idea/',
    '.remember/',
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  regexp.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      'no-console': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': ['error', { paths: FORBIDDEN_MODULE_PATHS }],
      'no-restricted-syntax': ['error', RAW_SQL],
    },
  },
  {
    // Production code reads the time only through an injected Clock; platform/time is where the real clock lives.
    files: ['src/**/*.ts'],
    ignores: ['src/platform/time/**'],
    rules: { 'no-restricted-syntax': ['error', RAW_SQL, ...CLOCK_READS] },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/platform/db/**'],
    rules: { 'no-restricted-imports': ['error', { paths: FORBIDDEN_MODULE_PATHS, patterns: [SQL_FRAGMENTS] }] },
  },
  {
    files: ['src/platform/db/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...CLOCK_READS] },
  },
  {
    // The end-to-end smoke test drives the Docker CLI; nothing else may spawn processes.
    files: ['test/e2e/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', RAW_SQL, ...CLOCK_READS, RANDOMNESS] },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
