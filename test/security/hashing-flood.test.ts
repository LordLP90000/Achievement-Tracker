import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { LogCapture } from '../helpers/log-capture.ts';

describe('bounded password hashing [D-01]', () => {
  let ctx: AccountsApp;
  const logs = new LogCapture();

  beforeAll(async () => {
    // One hash at a time and no queue: every registration that arrives while one is hashing is refused.
    ctx = await startAccountsApp({ logCapture: logs, hashing: { maxConcurrent: 1, maxQueued: 0 } });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('refuses work beyond the hashing capacity with 429 and Retry-After instead of queueing it', async () => {
    const register = () =>
      contractInject(ctx.app, {
        method: 'POST',
        url: '/v1/auth/register',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          email: `flood-${randomUUID().slice(0, 8)}@example.test`,
          password: 'correct horse battery staple',
          privacy_policy_version: '2026-10-01',
          age_confirmed: true,
        }),
      });

    const responses = await Promise.all([register(), register(), register()]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 429, 429]);
    const refused = responses.find((response) => response.statusCode === 429);
    expect(refused?.headers['retry-after']).toBe('1');
    expect(refused?.json()).toMatchObject({ type: 'urn:questline:problem:rate-limited', status: 429 });
    expect(logs.records().filter((record) => record['msg'] === 'password hashing saturated')).toHaveLength(2);
  });
});
