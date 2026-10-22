import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('migrations', import.meta.url));

/** Applies pending migrations as the migrator role (the only role allowed to run DDL, ADR-0003). */
export async function runMigrations(url: string, migrationsFolder: string = MIGRATIONS_FOLDER): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(sql), { migrationsFolder });
  } finally {
    await sql.end();
  }
}
