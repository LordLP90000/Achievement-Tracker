import { describe, expect, it } from 'vitest';
import { ConfigError } from '../platform/config/config.ts';
import { MAINTENANCE_COMMANDS, maintenanceCommandOf } from './maintenance.ts';

/** The arguments of the maintenance entrypoint, `node dist/maintenance.js <command>` (ADR-0020). */
describe('maintenanceCommandOf', () => {
  it('names the command to run', () => {
    expect(maintenanceCommandOf(['replay-tombstones'])).toBe('replay-tombstones');
    expect(MAINTENANCE_COMMANDS).toEqual(['replay-tombstones']);
  });

  it.each([[[]], [['drop-database']], [['Replay-Tombstones']], [['replay-tombstones', '--force']]])(
    'refuses %j and names the commands it knows',
    (args) => {
      const run = () => maintenanceCommandOf(args);

      expect(run).toThrow(ConfigError);
      expect(run).toThrow('command: must be exactly one of replay-tombstones');
    },
  );
});
