import postgres, { type Sql } from 'postgres';

/** The three database roles of ADR-0003. None of them is privileged; only the migrator owns objects. */
export const DATABASE_ROLES = {
  migrator: 'questline_migrator',
  app: 'questline_app',
  worker: 'questline_worker',
} as const;

export type RolePasswords = Readonly<Record<keyof typeof DATABASE_ROLES, string>>;

export interface BootstrapOptions {
  readonly database: string;
  readonly passwords: RolePasswords;
}

const IDENTIFIER = /^[a-z_][a-z\d_]{0,62}$/;

function assertIdentifier(name: string): void {
  if (!IDENTIFIER.test(name)) throw new TypeError('database names must be lower-case PostgreSQL identifiers');
}

/** Returns `baseUrl` pointing at another database, optionally with other credentials. */
export function databaseUrl(
  baseUrl: string,
  database: string,
  credentials?: { user: string; password: string },
): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  if (credentials !== undefined) {
    url.username = credentials.user;
    url.password = credentials.password;
  }
  return url.toString();
}

async function withAdminSession<T>(url: string, work: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    return await work(sql);
  } finally {
    await sql.end();
  }
}

/**
 * Runs a DDL statement whose identifiers (%I) and literals (%L) are quoted by PostgreSQL's own format(),
 * with every value bound as a parameter — DDL cannot take bind parameters directly.
 */
async function executeFormatted(sql: Sql, template: string, ...values: string[]): Promise<void> {
  const placeholders = values.map((_value, index) => `, $${String(index + 2)}::text`).join('');
  const [row] = await sql.unsafe<{ statement: string }[]>(`select format($1::text${placeholders}) as statement`, [
    template,
    ...values,
  ]);
  if (row === undefined) throw new Error('format() returned no statement');
  await sql.unsafe(row.statement);
}

async function grantDatabaseAccess(sql: Sql, database: string): Promise<void> {
  const { migrator, app, worker } = DATABASE_ROLES;
  await executeFormatted(sql, 'revoke all on database %I from public', database);
  await executeFormatted(sql, 'grant connect on database %I to %I, %I, %I', database, migrator, app, worker);
}

/**
 * One-off, idempotent setup run with an administrator account (Compose `db-init`, operations runbook):
 * creates the unprivileged roles, the database owned by the migrator, and restricts database access.
 */
export async function bootstrapDatabase(adminUrl: string, options: BootstrapOptions): Promise<void> {
  assertIdentifier(options.database);

  await withAdminSession(adminUrl, async (sql) => {
    for (const [key, role] of Object.entries(DATABASE_ROLES) as [keyof typeof DATABASE_ROLES, string][]) {
      const existing = await sql`select 1 from pg_roles where rolname = ${role}`;
      if (existing.length === 0) await executeFormatted(sql, 'create role %I', role);
      await executeFormatted(
        sql,
        'alter role %I with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L',
        role,
        options.passwords[key],
      );
    }

    const database = await sql`select 1 from pg_database where datname = ${options.database}`;
    if (database.length === 0) {
      await executeFormatted(sql, 'create database %I owner %I', options.database, DATABASE_ROLES.migrator);
    }
    await grantDatabaseAccess(sql, options.database);
  });

  await withAdminSession(databaseUrl(adminUrl, options.database), (sql) =>
    executeFormatted(sql, 'alter schema public owner to %I', DATABASE_ROLES.migrator),
  );
}

/** Test helper: clones a migrated template database (no session may be connected to the template). */
export async function createDatabaseFromTemplate(adminUrl: string, database: string, template: string): Promise<void> {
  assertIdentifier(database);
  assertIdentifier(template);
  await withAdminSession(adminUrl, async (sql) => {
    await executeFormatted(sql, 'create database %I template %I owner %I', database, template, DATABASE_ROLES.migrator);
    await grantDatabaseAccess(sql, database);
  });
}

export async function dropDatabase(adminUrl: string, database: string): Promise<void> {
  assertIdentifier(database);
  await withAdminSession(adminUrl, (sql) => executeFormatted(sql, 'drop database if exists %I with (force)', database));
}
