import { runCli } from './main/cli.ts';
import { rotationKeks } from './main/keys.ts';
import { maintenanceCommandOf, runMaintenance } from './main/maintenance.ts';
import { loadMaintenanceConfig } from './platform/config/config.ts';
import { loadRotationKeys } from './platform/config/keys.ts';
import { createLogger } from './platform/logging/logger.ts';

process.exitCode = await runCli(
  async () => {
    const command = maintenanceCommandOf(process.argv.slice(2));
    const config = loadMaintenanceConfig(process.env);
    // Only the KEK rotation needs the KEKs: every other command runs without them.
    const keks =
      command === 'rewrap-data-keys' ? await rotationKeks(loadRotationKeys(process.env, config.appEnv)) : undefined;
    const logger = createLogger({ service: 'questline-maintenance', level: config.logLevel });
    await runMaintenance(command, config, logger, keks === undefined ? {} : { keks });
  },
  (line) => process.stderr.write(`${line}\n`),
);
