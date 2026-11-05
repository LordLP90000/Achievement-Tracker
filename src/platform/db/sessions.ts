import { sql } from 'drizzle-orm';
import type { Database } from './database.ts';

/**
 * Which of the given application names other sessions of this database are connected under. Every role may read the
 * application name of every session (pg_stat_activity), so the migrator can tell whether an API or a worker still runs
 * against a database a maintenance command is about to change (ADR-0020).
 */
export async function connectedApplications(db: Database, names: readonly string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const rows = await db.execute<{ application_name: string }>(sql`
    select distinct application_name from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid()
      and application_name in (${sql.join(
        names.map((name) => sql`${name}`),
        sql`, `,
      )})
    order by application_name`);
  return rows.map((row) => row.application_name);
}
