import { runCli } from './main/cli.ts';
import { kekSourceFor, rotationKeks } from './main/keys.ts';
import { maintenanceCommandOf, runMaintenance } from './main/maintenance.ts';
import { loadMaintenanceConfig } from './platform/config/config.ts';
import { loadReindexKeys, loadRotationKeys } from './platform/config/keys.ts';
import { createLogger } from './platform/logging/logger.ts';

process.exitCode = await runCli(
  async () => {
    const command = maintenanceCommandOf(process.argv.slice(2));
    const config = loadMaintenanceConfig(process.env);
    const logger = createLogger({ service: 'questline-maintenance', level: config.logLevel });
    // Each command loads only the keys it needs; the restore replay needs none.
    if (command === 'rewrap-data-keys') {
      await runMaintenance(command, config, logger, {
        keks: await rotationKeks(loadRotationKeys(process.env, config.appEnv)),
      });
    } else if (command === 'reindex-email-blind-index') {
      const keys = loadReindexKeys(process.env, config.appEnv);
      const kek = await kekSourceFor(keys.kek)();
      await runMaintenance(command, config, logger, {
        blindIndex: { kek, current: keys.blindIndexKey, previous: keys.previousBlindIndexKey },
      });
    } else {
      await runMaintenance(command, config, logger);
    }
  },
  (line) => process.stderr.write(`${line}\n`),
);
