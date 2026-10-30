import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { createAchievement, goalUser, insertAchievements } from '../helpers/goals.ts';

interface TokenPair {
  access_token: string;
}

describe('consents [R-PRIV-04, R-AUTHZ-02, A-14]', () => {
  let ctx: AccountsApp;

  const session = async (account: TestAccount): Promise<TokenPair> =>
    (await ctx.post('/v1/auth/login', { email: account.email, password: account.password, client: 'ios' })).json();
  const bearer = (pair: TokenPair) => ({ authorization: `Bearer ${pair.access_token}` });
  const grant = (pair: TokenPair, body: Record<string, unknown> = { type: 'goal_content', version: '2026-10-01' }) =>
    ctx.post('/v1/me/consents', body, bearer(pair));
  const list = async (pair: TokenPair) =>
    (await contractInject(ctx.app, { method: 'GET', url: '/v1/me/consents', headers: bearer(pair) })).json<{
      items: Record<string, unknown>[];
    }>().items;
  const withdraw = (pair: TokenPair, type = 'goal_content') =>
    contractInject(ctx.app, { method: 'DELETE', url: `/v1/me/consents/${type}`, headers: bearer(pair) });
  const events = async (userId: string, type: string) =>
    (
      await ctx.worker.sql<Record<string, unknown>[]>`
        select outcome, metadata from audit_events where user_id = ${userId} and event_type = ${type}`
    ).map((row) => ({ ...row }));
  const goalContent = async (userId: string) => ({
    ...(
      await ctx.admin.sql<{ achievements: number; xp_events: number; idempotency_keys: number }[]>`
        select (select count(*)::int from achievements where user_id = ${userId}) as achievements,
               (select count(*)::int from xp_events where user_id = ${userId}) as xp_events,
               (select count(*)::int from idempotency_keys where user_id = ${userId}) as idempotency_keys`
    )[0],
  });

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('records an explicit, versioned consent and audits it', async () => {
    const account = await ctx.account();

    const response = await grant(await session(account));

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      type: 'goal_content',
      version: '2026-10-01',
      granted_at: ctx.clock.now().toISOString(),
      withdrawn_at: null,
    });
    expect(await events(account.userId, 'consent_granted')).toEqual([
      { outcome: 'success', metadata: { type: 'goal_content', version: '2026-10-01' } },
    ]);
  });

  it('refuses a second grant while one is active with 409', async () => {
    const pair = await session(await ctx.account());
    await grant(pair);

    const response = await grant(pair, { type: 'goal_content', version: '2026-11-01' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ type: 'urn:questline:problem:consent-already-granted' });
  });

  it('lets exactly one of two simultaneous grants through', async () => {
    const pair = await session(await ctx.account());

    const responses = await Promise.all([grant(pair), grant(pair)]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(await list(pair)).toHaveLength(1);
  });

  it('withdraws the active consent, keeps the history, audits it and allows a new grant later', async () => {
    const account = await ctx.account();
    const pair = await session(account);
    await grant(pair);
    ctx.clock.advance({ minutes: 5 });
    const withdrawnAt = ctx.clock.now().toISOString();

    expect((await withdraw(pair)).statusCode).toBe(204);
    expect((await withdraw(pair)).statusCode).toBe(404);
    ctx.clock.advance({ minutes: 5 });
    expect((await grant(pair, { type: 'goal_content', version: '2026-12-01' })).statusCode).toBe(201);

    const items = await list(pair);
    expect(items).toMatchObject([
      { version: '2026-12-01', withdrawn_at: null },
      { version: '2026-10-01', withdrawn_at: withdrawnAt },
    ]);
    expect(await events(account.userId, 'consent_withdrawn')).toEqual([
      { outcome: 'success', metadata: { type: 'goal_content' } },
    ]);
  });

  it('shows nobody else’s consents and withdraws only the own [R-AUTHZ-02]', async () => {
    const owner = await session(await ctx.account());
    const stranger = await session(await ctx.account());
    await grant(owner);

    expect(await list(stranger)).toEqual([]);
    expect((await withdraw(stranger)).statusCode).toBe(404);
    expect(await list(owner)).toMatchObject([{ withdrawn_at: null }]);
  });

  it('answers 404 for an unknown consent type', async () => {
    const pair = await session(await ctx.account());

    expect((await withdraw(pair, 'marketing')).statusCode).toBe(404);
  });

  it('deletes all goal content with the goal-content consent — the archive, the XP ledger and stored responses too — and nothing of others [Q-10]', async () => {
    const owner = await goalUser(ctx);
    const other = await goalUser(ctx);
    const key = randomUUID();
    const created = await createAchievement(ctx, owner.token, { title: 'Swim across the lake' }, key);
    await createAchievement(ctx, other.token, { title: 'Not affected' });
    await insertAchievements(ctx, owner.userId, 2, 'completed');
    await ctx.admin.sql`
      insert into xp_events (id, user_id, kind, amount, achievement_id, local_date, created_at)
      values (${randomUUID()}, ${owner.userId}, 'quest_completed', 25, ${created.json<{ id: string }>().id},
              '2026-10-29', ${ctx.clock.now()})`;

    expect((await withdraw({ access_token: owner.token })).statusCode).toBe(204);

    expect(await goalContent(owner.userId)).toEqual({ achievements: 0, xp_events: 0, idempotency_keys: 0 });
    expect(await goalContent(other.userId)).toEqual({ achievements: 1, xp_events: 0, idempotency_keys: 1 });
    expect((await grant({ access_token: owner.token })).statusCode).toBe(201);
    const again = await createAchievement(ctx, owner.token, { title: 'Swim across the lake' }, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBeUndefined();
  });

  it.each([
    ['an unknown type', { type: 'marketing', version: '2026-10-01' }, '/type'],
    ['a version that is not a date', { type: 'goal_content', version: 'v2' }, '/version'],
    ['an unknown property', { type: 'goal_content', version: '2026-10-01', granted: true }, ''],
  ])('refuses %s with 400', async (_name, body, pointer) => {
    const response = await grant(await session(await ctx.account()), body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errors: [{ pointer }] });
  });
});
