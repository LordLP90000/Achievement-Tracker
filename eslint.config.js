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
      'no-restricted-imports': [
        'error',
        {
          paths: forbiddenModules.map((name) => ({
            name,
            message: 'Spawning processes or evaluating code is not allowed in this codebase.',
          })),
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[object.name=/^(sql|tx)$/][property.name=/^(raw|unsafe)$/]',
          message: 'Raw SQL is only allowed inside src/platform/db (ADR-0003).',
        },
      ],
    },
  },
  {
    files: ['src/platform/db/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // The end-to-end smoke test drives the Docker CLI; nothing else may spawn processes.
    files: ['test/e2e/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'The domain is pure: inject a Clock instead of reading the time.',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'The domain is pure: inject a Clock instead of reading the time.',
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message: 'The domain is pure: no randomness.',
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
