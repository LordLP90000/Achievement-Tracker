/** Architecture rules (docs/architecture.md §2, ADR-0003), checked in CI and before every push. */
/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Circular imports make layering and test seams impossible to reason about.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-is-pure',
      comment: 'src/domain holds pure functions: no platform, modules, Node.js built-ins or packages.',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { pathNot: '^src/domain/' },
    },
    {
      name: 'database-drivers-only-in-platform-db',
      comment: 'Only src/platform/db opens connections and runs migrations (ADR-0003).',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/platform/db/' },
      to: { path: 'node_modules/(postgres|drizzle-kit)/' },
    },
    {
      name: 'query-builder-only-in-repositories',
      comment:
        'Queries are built only in src/platform/db and in repository files (`*repository.ts`, architecture §2); ' +
        'services and routes call repositories (ADR-0003).',
      severity: 'error',
      from: { path: '^src/', pathNot: '(^src/platform/db/|repository\\.ts$)' },
      to: { path: 'node_modules/drizzle-orm/' },
    },
    {
      name: 'crypto-library-only-in-platform-crypto',
      comment: 'libsodium is used only behind src/platform/crypto (ADR-0005), so every use is reviewed in one place.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/platform/crypto/' },
      to: { path: 'node_modules/sodium-native/' },
    },
    {
      name: 'production-code-not-to-tests',
      severity: 'error',
      from: { path: '^src/', pathNot: '\\.test\\.ts$' },
      to: { path: '(^test/|\\.test\\.ts$)' },
    },
    {
      name: 'production-code-not-to-dev-dependencies',
      comment: 'Dev dependencies are not installed in the container image.',
      severity: 'error',
      from: { path: '^src/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-unresolvable-imports',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.d.ts'],
    },
  },
};
