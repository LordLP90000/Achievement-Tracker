/** Conventional Commits with the types listed in ADR-0001 (incl. `security` for security fixes). */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'security', 'test'],
    ],
  },
};
