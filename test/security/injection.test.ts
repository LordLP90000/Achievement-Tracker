import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer, createAchievement, goalUser } from '../helpers/goals.ts';

/** SQL meta-characters in user input (33 characters: within every field's length limit but a unit's). */
const META = `'); DROP TABLE users;-- "\\ %_$1:n`;
/** The same within a target's unit (20 characters). */
const SHORT_META = `';DROP TABLE x;--%_\\`;

interface TokenPair {
  readonly access_token: string;
}

/**
 * Every query is parameterized (ADR-0003; ESLint bans string-built SQL): meta-characters in any field are data and
 * come back unchanged (T-03, R-IN-02), in the account's fields and in every goal-content field.
 */
describe('SQL meta-characters [T-03, R-IN-02]', () => {
  let ctx: AccountsApp;

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('keeps them as data in the address, the password, the device label and the nickname', async () => {
    const email = `o'hara-${randomUUID().slice(0, 8)}@example.test`;
    const password = `pass'word"; DROP TABLE sessions; --`;
    const registered = await ctx.post('/v1/auth/register', {
      email,
      password,
      privacy_policy_version: '2026-10-01',
      age_confirmed: true,
    });
    expect(registered.statusCode).toBe(202);
    const token = (await ctx.emails()).find((queued) => queued.payload.to === email)?.payload.token ?? '';
    expect((await ctx.post('/v1/auth/verify-email', { token })).statusCode).toBe(204);
    const login = await ctx.post('/v1/auth/login', { email, password, client: 'ios', device_label: META });
    expect(login.statusCode).toBe(200);
    const headers = { authorization: `Bearer ${login.json<TokenPair>().access_token}` };

    const current = await contractInject(ctx.app, { method: 'GET', url: '/v1/me', headers });
    const patched = await contractInject(ctx.app, {
      method: 'PATCH',
      url: '/v1/me',
      headers: { ...headers, 'content-type': 'application/json', 'if-match': String(current.headers.etag) },
      payload: JSON.stringify({ nickname: META }),
    });
    const sessions = await contractInject(ctx.app, { method: 'GET', url: '/v1/me/sessions', headers });

    expect(patched.json()).toMatchObject({ email, nickname: META });
    expect(sessions.json<{ items: { device_label: string | null }[] }>().items).toEqual([
      expect.objectContaining({ device_label: META }),
    ]);
    const tables = await ctx.admin.sql<{ count: number }[]>`
      select count(*)::int as count from information_schema.tables
      where table_schema = 'public' and table_name in ('users', 'sessions')`;
    expect(tables[0]?.count).toBe(2);
  });

  it('keeps them as data in every goal-content field: achievement, quest, target unit, check-in note', async () => {
    const user = await goalUser(ctx);
    const headers = (key = true) => ({ ...bearer(user.token), ...(key ? { 'idempotency-key': randomUUID() } : {}) });
    const created = await createAchievement(ctx, user.token, {
      title: META,
      description: META,
      motivation: META,
      category: META,
    });
    const achievementId = created.json<{ id: string }>().id;
    const quest = await ctx.post(
      `/v1/achievements/${achievementId}/quests`,
      {
        title: META,
        notes: META,
        type: 'target',
        size: 'M',
        target: { start_value: '0', target_value: '10', unit: SHORT_META },
      },
      headers(),
    );
    const questId = quest.json<{ id: string }>().id;
    const checkIn = await ctx.post(
      `/v1/quests/${questId}/check-ins`,
      { local_date: '2026-10-29', value: '1', note: META },
      headers(),
    );
    const get = async (url: string) =>
      (await contractInject(ctx.app, { method: 'GET', url, headers: headers(false) })).json<Record<string, unknown>>();

    expect([created.statusCode, quest.statusCode, checkIn.statusCode]).toEqual([201, 201, 201]);
    expect(await get(`/v1/achievements/${achievementId}`)).toMatchObject({
      title: META,
      description: META,
      motivation: META,
      category: META,
    });
    expect(await get(`/v1/quests/${questId}`)).toMatchObject({
      title: META,
      notes: META,
      target: { unit: SHORT_META },
    });
    expect((await get(`/v1/quests/${questId}/check-ins`))['items']).toEqual([expect.objectContaining({ note: META })]);
    const tables = await ctx.admin.sql<{ count: number }[]>`
      select count(*)::int as count from information_schema.tables
      where table_schema = 'public' and table_name in ('users', 'achievements', 'quests', 'check_ins', 'xp_events')`;
    expect(tables[0]?.count).toBe(5);
  });
});
