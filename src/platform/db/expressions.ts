import { sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * SQL fragments for repositories, which use the query builder only (ADR-0003): every fragment lives here, where
 * reviews of hand-written SQL happen.
 */

/** `column + 1`: bumps a resource version so its ETag changes (optimistic concurrency, ADR-0008). */
export function increment(column: AnyColumn): SQL {
  return sql`${column} + 1`;
}

/**
 * The rows after `position` in `created_at desc, id desc` order (cursor pagination, R-IN-01). One row comparison, so
 * an index ending in `(created_at, id)` serves it as a single range scan; the values are encoded like their columns.
 */
export function afterPosition(
  createdAt: AnyColumn,
  id: AnyColumn,
  position: { readonly createdAt: Date; readonly id: string },
): SQL {
  return sql`(${createdAt}, ${id}) < (${sql.param(position.createdAt, createdAt)}, ${sql.param(position.id, id)})`;
}

/** Ascending, with NULLs first (PostgreSQL puts them last by default): rows never handled come before all others. */
export function ascNullsFirst(column: AnyColumn): SQL {
  return sql`${column} asc nulls first`;
}
