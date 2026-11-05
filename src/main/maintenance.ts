import type { Logger } from 'pino';
import { replayTombstones } from '../modules/privacy/tombstone-replay.ts';
import { ConfigError, type MaintenanceConfig } from '../platform/config/config.ts';
import { createDatabaseClient } from '../platform/db/client.ts';
import { createDatabase } from '../platform/db/database.ts';
import { connectedApplications } from '../platform/db/sessions.ts';

/** The one-off maintenance commands (ADR-0020): `node dist/maintenance.js <command>`, with the migrator's role. */
export const MAINTENANCE_COMMANDS = ['replay-tombstones'] as const;
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
): Promise<void> {
  const open = (url: string) =>
    createDatabaseClient({
      url,
      applicationName: 'questline-maintenance',
      maxConnections: 1,
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    });
  const target = open(config.databaseUrl);
  const source = config.tombstoneSourceUrl === undefined ? undefined : open(config.tombstoneSourceUrl);
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
    const result = await replayTombstones(restored, replaced);
    logger.info({ command, ...result }, 'tombstones replayed');
  } finally {
    await Promise.all([target.close(), source?.close()]);
  }
}
