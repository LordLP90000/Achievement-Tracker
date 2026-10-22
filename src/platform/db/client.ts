import postgres, { type Sql, type TransactionSql } from 'postgres';
import type { ReadinessProbe } from '../../modules/health/routes.ts';

export interface DatabaseClientOptions {
  readonly url: string;
  readonly applicationName: string;
  readonly maxConnections?: number;
  readonly statementTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
  readonly connectTimeoutSeconds?: number;
}

export interface DatabaseClient {
  readonly sql: Sql;
  readonly close: () => Promise<void>;
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

/** A small connection pool with server-side limits on statement and idle-in-transaction time (D-06). */
export function createDatabaseClient(options: DatabaseClientOptions): DatabaseClient {
  const sql = postgres(options.url, {
    max: options.maxConnections ?? 10,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    onnotice: () => undefined,
    connection: {
      application_name: options.applicationName,
      statement_timeout: options.statementTimeoutMs ?? 5000,
      idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 10_000,
    },
  });
  return { sql, close: () => sql.end({ timeout: 5 }) };
}

/**
 * Runs `work` in a transaction whose row-level-security context is `userId` (ADR-0003). The setting is
 * transaction-local, so it can never leak into another request that reuses the pooled connection.
 */
export async function withUserContext<T>(
  client: DatabaseClient,
  userId: string,
  work: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  if (!UUID.test(userId)) throw new TypeError('user id must be a UUID');
  const result = await client.sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    return work(tx);
  });
  return result as T;
}

export function databaseReadiness(client: DatabaseClient): ReadinessProbe {
  return async () => {
    await client.sql`select 1`;
    return true;
  };
}
