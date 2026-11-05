import { describe, expect, it } from 'vitest';
import { ConfigError } from '../platform/config/config.ts';
import { MAINTENANCE_COMMANDS, maintenanceCommandOf } from './maintenance.ts';

/** The arguments of the maintenance entrypoint, `node dist/maintenance.js <command>` (ADR-0020). */
describe('maintenanceCommandOf', () => {
  it('names the command to run', () => {
    expect(maintenanceCommandOf(['replay-after-restore'])).toBe('replay-after-restore');
    expect(maintenanceCommandOf(['rewrap-data-keys'])).toBe('rewrap-data-keys');
    expect(maintenanceCommandOf(['reindex-email-blind-index'])).toBe('reindex-email-blind-index');
    expect(MAINTENANCE_COMMANDS).toEqual(['replay-after-restore', 'rewrap-data-keys', 'reindex-email-blind-index']);
  });

  it.each([[[]], [['drop-database']], [['Replay-After-Restore']], [['replay-after-restore', '--force']]])(
    'refuses %j and names the commands it knows',
    (args) => {
      const run = () => maintenanceCommandOf(args);

      expect(run).toThrow(ConfigError);
      expect(run).toThrow(
        'command: must be exactly one of replay-after-restore, rewrap-data-keys, reindex-email-blind-index',
      );
    },
  );
});
