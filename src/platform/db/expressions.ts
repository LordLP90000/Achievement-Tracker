import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * SQL fragments for repositories, which use the query builder only (ADR-0003): every fragment lives here, where
 * reviews of hand-written SQL happen.
 */

/** `column + 1`: bumps a resource version so its ETag changes (optimistic concurrency, ADR-0008). */
export function increment(column: AnyColumn): SQL {
  return sql`${column} + 1`;
}
