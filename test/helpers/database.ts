import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { createDatabaseFromTemplate, dropDatabase } from '../../src/platform/db/bootstrap.ts';

export interface DatabaseServer {
  readonly adminUrl: string;
  readonly host: string;
  readonly port: number;
  readonly template: string;
  readonly passwords: { readonly migrator: string; readonly app: string; readonly worker: string };
}

declare module 'vitest' {
  export interface ProvidedContext {
    database: DatabaseServer;
  }
}

export interface TestDatabase {
  readonly name: string;
  readonly urls: { readonly app: string; readonly worker: string; readonly migrator: string };
  readonly drop: () => Promise<void>;
}

/** A fresh, fully migrated database for one test file, cloned from the migrated template. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const server = inject('database');
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await createDatabaseFromTemplate(server.adminUrl, name, server.template);

  const url = (role: string, password: string) =>
    `postgres://${role}:${encodeURIComponent(password)}@${server.host}:${String(server.port)}/${name}`;

  return {
    name,
    urls: {
      app: url('questline_app', server.passwords.app),
      worker: url('questline_worker', server.passwords.worker),
      migrator: url('questline_migrator', server.passwords.migrator),
    },
    drop: () => dropDatabase(server.adminUrl, name),
  };
}
