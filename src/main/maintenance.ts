import type { Logger } from 'pino';
import { rewrapDataKeys, type RewrapKeks } from '../modules/accounts/rewrap.ts';
import { replayAfterRestore } from '../modules/privacy/restore-replay.ts';
import { ConfigError, type MaintenanceConfig } from '../platform/config/config.ts';
import { createDatabaseClient } from '../platform/db/client.ts';
import { createDatabase, type Database } from '../platform/db/database.ts';
import { connectedApplications } from '../platform/db/sessions.ts';
import { systemClock, type Clock } from '../platform/time/clock.ts';

/** The one-off maintenance commands (ADR-0020): `node dist/maintenance.js <command>`, with the migrator's role. */
export const MAINTENANCE_COMMANDS = ['replay-after-restore', 'rewrap-data-keys'] as const;
export type MaintenanceCommand = (typeof MAINTENANCE_COMMANDS)[number];

/** The processes that must be stopped first: they read and write the rows a command changes. */
const RUNNING_PROCESSES = ['questline-api', 'questline-worker'];
/** No request waits for a maintenance statement, and one statement deletes up to 100 accounts with all they own. */
const STATEMENT_TIMEOUT_MS = 60_000;

/** The API or the worker is connected to a database the command would read or change. */
export class MaintenanceRefusedError extends Error {
  override readonly name = 'MaintenanceRefusedError';
  readonly code = 'processes_connected';

  constructor() {
    super('stop the API and the worker before running a maintenance command');
  }
}

const INCOMPLETE = {
  /** `replay-after-restore`: an operator decides which account keeps each address (restore runbook). */
  address_conflicts: 'some addresses were left as restored: decide by hand which account keeps each',
  /** `rewrap-data-keys`: no given KEK opens them (key-rotation runbook). */
  unknown_data_keys: 'some data keys open with no given KEK: they were left as they are',
} as const;

/** The command did everything it could and left the rest for a decision by hand; its log line has the counts. */
export class MaintenanceIncompleteError extends Error {
  override readonly name = 'MaintenanceIncompleteError';
  readonly code: keyof typeof INCOMPLETE;

  constructor(code: keyof typeof INCOMPLETE) {
    super(INCOMPLETE[code]);
    this.code = code;
  }
}

export interface MaintenanceDependencies {
  readonly clock?: Clock;
  /** `rewrap-data-keys` only: the current KEK and the previous ones, fetched by the entrypoint from their sources. */
  readonly keks?: RewrapKeks;
}

/** The command named by the arguments: exactly one known command, nothing else. */
export function maintenanceCommandOf(args: readonly string[]): MaintenanceCommand {
  const [name, ...rest] = args;
  const command = MAINTENANCE_COMMANDS.find((candidate) => candidate === name);
  if (command === undefined || rest.length > 0) {
    throw new ConfigError([`command: must be exactly one of ${MAINTENANCE_COMMANDS.join(', ')}`]);
  }
  return command;
}

/**
 * Runs a maintenance command. It refuses while an API or a worker is connected to a database it would read or change
 * (a best-effort check: the runbook's "stop them first" is the control) and logs only counts.
 */
export async function runMaintenance(
  command: MaintenanceCommand,
  config: MaintenanceConfig,
  logger: Logger,
  dependencies: MaintenanceDependencies = {},
): Promise<void> {
  const open = (url: string) =>
    createDatabaseClient({
      url,
      applicationName: 'questline-maintenance',
      maxConnections: 1,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    });
  const target = open(config.databaseUrl);
  const sourceUrl = command === 'replay-after-restore' ? config.replacedDatabaseUrl : undefined;
  const source = sourceUrl === undefined ? undefined : open(sourceUrl);
  try {
    const restored = createDatabase(target);
    const replaced = source === undefined ? undefined : createDatabase(source);
    const found = await Promise.all(
      [restored, ...(replaced === undefined ? [] : [replaced])].map((db) =>
        connectedApplications(db, RUNNING_PROCESSES),
      ),
    );
    const connected = [...new Set(found.flat())].toSorted();
    if (connected.length > 0) {
      logger.error({ command, connected }, 'maintenance refused');
      throw new MaintenanceRefusedError();
    }
    await (command === 'rewrap-data-keys'
      ? rewrap(restored, dependencies, logger)
      : replay(restored, replaced, dependencies, logger));
  } finally {
    await Promise.all([target.close(), source?.close()]);
  }
}

async function replay(
  restored: Database,
  replaced: Database | undefined,
  dependencies: MaintenanceDependencies,
  logger: Logger,
): Promise<void> {
  const result = await replayAfterRestore(restored, replaced, { now: (dependencies.clock ?? systemClock).now() });
  logger.info({ command: 'replay-after-restore', ...result }, 'replayed after restore');
  if (result.addressConflicts > 0) throw new MaintenanceIncompleteError('address_conflicts');
}

async function rewrap(db: Database, dependencies: MaintenanceDependencies, logger: Logger): Promise<void> {
  if (dependencies.keks === undefined) throw new TypeError('rewrap-data-keys needs the KEKs');
  const result = await rewrapDataKeys(db, dependencies.keks, (dependencies.clock ?? systemClock).now());
  logger.info({ command: 'rewrap-data-keys', ...result }, 'data keys re-wrapped');
  if (result.unknown > 0) throw new MaintenanceIncompleteError('unknown_data_keys');
}
