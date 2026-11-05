import { runCli } from './main/cli.ts';
import { maintenanceCommandOf, runMaintenance } from './main/maintenance.ts';
import { loadMaintenanceConfig } from './platform/config/config.ts';
import { createLogger } from './platform/logging/logger.ts';

process.exitCode = await runCli(
  async () => {
    const command = maintenanceCommandOf(process.argv.slice(2));
    const config = loadMaintenanceConfig(process.env);
    await runMaintenance(command, config, createLogger({ service: 'questline-maintenance', level: config.logLevel }));
  },
  (line) => process.stderr.write(`${line}\n`),
);
