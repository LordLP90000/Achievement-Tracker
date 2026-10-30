import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';

/** Tables whose rows the API may only see for the user in `app.user_id` (docs/data-model.md §4). */
const RLS_TABLES = [
  'achievements',
  'audit_events',
  'badges',
  'check_ins',
  'consents',
  'email_outbox',
  'gambles',
  'idempotency_keys',
  'quests',
  'sessions',
  'user_keys',
  'xp_events',
];

/** Tables without row-level security, each with the reason documented in docs/data-model.md §3. */
const RLS_EXEMPT: Readonly<Record<string, string>> = {
  users: 'looked up by email blind index before the user is known; narrow repository API',
  one_time_tokens: 'looked up by token hash before the user is known',
  session_tokens: 'looked up by token hash before the user is known',
  rate_limit_buckets: 'no user relation (daily-keyed hashes)',
  deleted_user_tombstones: 'no user relation; worker only',
  job_runs: 'no personal data; worker only',
};

interface TableSecurity {
  table: string;
  enabled: boolean;
  forced: boolean;
}

interface Policy {
  table: string;
  name: string;
  roles: string[];
  permissive: string;
  command: string;
  using: string | null;
  check: string | null;
}

/** Every table is classified, and every API policy is bound to the current user [R-AUTHZ-02, I-04, ADR-0003]. */
describe('row-level security coverage', () => {
  let database: TestDatabase;
  let migrator: DatabaseClient;
  let tables: TableSecurity[];
  let policies: Policy[];

  beforeAll(async () => {
    database = await createTestDatabase();
    migrator = createDatabaseClient({ url: database.urls.migrator, applicationName: 'questline-test' });
    tables = await migrator.sql<TableSecurity[]>`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' order by c.relname`;
    policies = await migrator.sql<Policy[]>`
      select tablename as table, policyname as name, roles::text[] as roles, permissive, cmd as command, qual as using,
             with_check as check
      from pg_policies where schemaname = 'public' order by tablename, policyname`;
  });

  afterAll(async () => {
    await migrator.close();
    await database.drop();
  });

  it('classifies every table as either protected by row-level security or exempt with a documented reason', () => {
    const unclassified = tables
      .map((row) => row.table)
      .filter((table) => !RLS_TABLES.includes(table) && !(table in RLS_EXEMPT));
    const missing = [...RLS_TABLES, ...Object.keys(RLS_EXEMPT)].filter(
      (table) => !tables.some((row) => row.table === table),
    );

    expect({ unclassified, missing }).toEqual({ unclassified: [], missing: [] });
  });

  it('enables and forces row-level security on every protected table, so not even the owner bypasses it', () => {
    const protectedTables = tables.filter((row) => RLS_TABLES.includes(row.table));

    expect(protectedTables.map((row) => ({ ...row }))).toEqual(
      RLS_TABLES.map((table) => ({ table, enabled: true, forced: true })),
    );
  });

  it('keeps the exempt tables exempt, so the documentation stays true', () => {
    const exempt = tables.filter((row) => row.table in RLS_EXEMPT);

    expect(exempt.filter((row) => row.enabled || row.forced).map((row) => row.table)).toEqual([]);
  });

  it('binds every API policy to the user of the transaction and never allows all rows', () => {
    const apiPolicies = policies.filter((policy) => policy.roles.includes('questline_app'));
    const unbound = apiPolicies.filter(
      (policy) =>
        [policy.using, policy.check].every((expression) => expression === null) ||
        [policy.using, policy.check].some(
          (expression) => expression !== null && !expression.includes('app_current_user_id()'),
        ),
    );

    expect([...new Set(apiPolicies.map((policy) => policy.table))].sort()).toEqual(RLS_TABLES);
    expect(unbound.map((policy) => policy.name)).toEqual([]);
  });

  it('narrows deletion of the XP ledger and of completed achievements with restrictive API policies [R-XP-01, R-ACH-07]', () => {
    const restrictive = policies.filter((policy) => policy.permissive === 'RESTRICTIVE');

    expect(restrictive.map(({ table, name, command }) => ({ table, name, command }))).toEqual([
      { table: 'achievements', name: 'achievements_app_delete_guard', command: 'DELETE' },
      { table: 'xp_events', name: 'xp_events_app_delete_guard', command: 'DELETE' },
    ]);
  });

  it('has no policy for PUBLIC, which would apply to every role', () => {
    expect(policies.filter((policy) => policy.roles.includes('public')).map((policy) => policy.name)).toEqual([]);
  });

  it('grants the worker cross-user policies only on protected tables', () => {
    const workerTables = policies.filter((policy) => policy.roles.includes('questline_worker')).map((p) => p.table);

    expect(workerTables.filter((table) => !RLS_TABLES.includes(table))).toEqual([]);
  });
});
