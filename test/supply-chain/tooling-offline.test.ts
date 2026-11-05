import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The development tools contact no third party on their own. The Redocly CLI — `lint:openapi` in the pre-push gate
 * and in CI — reports every command to Redocly unless its configuration turns that off, so the configuration turns it
 * off, and every npm script runs the CLI under the offline preload (scripts/offline-preload.ts) as well: even a later
 * version that ignored the setting could not send anything.
 */

const OFFLINE_CLI = 'node --import ./scripts/offline-preload.ts node_modules/@redocly/cli/bin/cli.js ';

describe('the Redocly CLI stays offline', () => {
  const config = () => parse(readFileSync('redocly.yaml', 'utf8')) as unknown;
  const scripts = () =>
    Object.entries((JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts);

  it('has its telemetry turned off (redocly.yaml)', () => {
    expect(config()).toMatchObject({ telemetry: 'off' });
  });

  it('keeps the recommended rules: a configuration that names none makes the OpenAPI lint check nothing', () => {
    expect(config()).toMatchObject({ extends: ['recommended'] });
  });

  it('runs from every npm script under the offline preload', () => {
    const invocations = scripts().flatMap(([name, command]) =>
      command
        .split('&&')
        .map((step) => step.trim())
        .filter((step) => /\bredocly\b|@redocly\/cli/.test(step))
        .map((step) => ({ name, step })),
    );

    expect(invocations.map(({ name }) => name)).toContain('lint:openapi');
    for (const { name, step } of invocations) {
      expect(step.startsWith(OFFLINE_CLI), `${name}: ${step}`).toBe(true);
    }
  });
});
