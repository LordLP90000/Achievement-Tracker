import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer, createAchievement, goalUser } from '../helpers/goals.ts';

interface Achievement {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly version: number;
  readonly [field: string]: unknown;
}

interface Page {
  readonly items: Achievement[];
  readonly next_cursor: string | null;
}

const FULL = {
  title: 'Run a marathon',
  description: 'All 42.195 km, without walking',
  motivation: 'Prove to myself that I can',
  category: 'Health',
  target_date: '2027-04-25',
  is_private: true,
};

/** Achievements API (contract tag `achievements`): content, encryption, consent, idempotency, pages, ownership. */
describe('achievements [R-ACH-01/02/08, R-PRIV-04, R-AUTHZ-02, ADR-0008]', () => {
  let ctx: AccountsApp;

  const user = (options: { readonly consent?: boolean } = {}) => goalUser(ctx, options);
  const create = (token: string, body: unknown, key?: string) => createAchievement(ctx, token, body, key);
  const get = (token: string, id: string) =>
    contractInject(ctx.app, { method: 'GET', url: `/v1/achievements/${id}`, headers: bearer(token) });
  const list = (token: string, query = '') =>
    contractInject(ctx.app, { method: 'GET', url: `/v1/achievements${query}`, headers: bearer(token) });
  const stored = (userId: string) =>
    ctx.admin.sql<Record<string, unknown>[]>`select * from achievements where user_id = ${userId} order by created_at`;

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('creates an achievement as the first attempt, with its content, a version and where to find it [R-ACH-01]', async () => {
    const { token } = await user();

    const response = await create(token, FULL);

    expect(response.statusCode).toBe(201);
    const achievement = response.json<Achievement>();
    expect(response.headers).toMatchObject({
      etag: '"1"',
      location: `/v1/achievements/${achievement.id}`,
      'cache-control': 'no-store',
    });
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    const now = ctx.clock.now().toISOString();
    expect(achievement).toEqual({
      id: achievement.id,
      ...FULL,
      status: 'active',
      attempt: 1,
      progress: 0,
      xp_required_total: 0,
      xp_earned: 0,
      rank: null,
      execution_score: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
      version: 1,
    });
  });

  it('leaves optional content empty and the achievement public unless asked otherwise', async () => {
    const { token } = await user();

    const achievement = (await create(token, { title: 'Learn to juggle' })).json<Achievement>();

    expect(achievement).toMatchObject({
      title: 'Learn to juggle',
      description: null,
      motivation: null,
      category: null,
      target_date: null,
      is_private: false,
    });
  });

  it('stores content and target date only encrypted, bound to user, record and column, with the deadline [R-ACH-02, A-35]', async () => {
    const { userId, token } = await user();
    const { id } = (await create(token, FULL)).json<Achievement>();

    const [row] = await stored(userId);
    const fields = {
      title_enc: FULL.title,
      description_enc: FULL.description,
      motivation_enc: FULL.motivation,
      category_enc: FULL.category,
      target_date_enc: FULL.target_date,
      deadline_enc: FULL.target_date,
    };
    for (const [field, plaintext] of Object.entries(fields)) {
      const blob = row?.[field] as Buffer;
      expect(blob.toString('latin1')).not.toContain(plaintext);
      expect(await ctx.decrypt(userId, id, field, blob)).toBe(plaintext);
    }
    await expect(ctx.decrypt(userId, id, 'description_enc', row?.['title_enc'] as Buffer)).rejects.toThrow();
    await expect(ctx.decrypt(userId, randomUUID(), 'title_enc', row?.['title_enc'] as Buffer)).rejects.toThrow();
    expect(row).toMatchObject({ dek_version: 1, status: 'active', attempt: 1 });
  });

  it('shows an achievement with its quests and version, and answers 404 for any other ID [R-AUTHZ-02]', async () => {
    const owner = await user();
    const intruder = await user();
    const created = (await create(owner.token, FULL)).json<Achievement>();

    const response = await get(owner.token, created.id);

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"1"');
    expect(response.json()).toEqual({ ...created, quests: [] });
    for (const [token, id] of [
      [intruder.token, created.id],
      [owner.token, randomUUID()],
      [owner.token, 'not-a-uuid'],
      [owner.token, created.id.toUpperCase()],
    ] as const) {
      const missing = await get(token, id);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ type: 'urn:questline:problem:not-found' });
    }
  });

  it('refuses goal content without the goal-content consent with 403, and creates it once consent is given [R-PRIV-04, Q-39]', async () => {
    const { userId, token } = await user({ consent: false });
    const key = randomUUID();

    const refused = await create(token, FULL, key);

    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ type: 'urn:questline:problem:consent-required' });
    expect(await stored(userId)).toEqual([]);

    await ctx.post('/v1/me/consents', { type: 'goal_content', version: '2026-10-01' }, bearer(token));
    const created = await create(token, FULL, key);
    expect(created.statusCode).toBe(201);
    expect(created.headers['idempotency-replayed']).toBeUndefined();
  });

  it('fails closed when the account data key is missing: 500 and nothing stored [R-ENC-01]', async () => {
    const { userId, token } = await user();
    await ctx.admin.sql`delete from user_keys where user_id = ${userId}`;

    // An internal failure is outside the contract (no operation documents 500): plain inject, generic problem.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/achievements',
      headers: { ...bearer(token), 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      payload: JSON.stringify(FULL),
    });
    const listed = await ctx.app.inject({ method: 'GET', url: '/v1/achievements', headers: bearer(token) });

    expect([created.statusCode, listed.statusCode]).toEqual([500, 500]);
    expect(created.json()).toMatchObject({ type: 'urn:questline:problem:internal' });
    expect(JSON.stringify(created.json())).not.toContain(FULL.title);
    expect(await stored(userId)).toEqual([]);
  });

  it('replays a repeated create and refuses its key for another body [ADR-0008, T-13]', async () => {
    const { userId, token } = await user();
    const key = randomUUID();
    const first = await create(token, FULL, key);

    const replay = await create(token, { ...FULL }, key);
    const reused = await create(token, { ...FULL, title: 'Run two marathons' }, key);

    expect(replay.statusCode).toBe(201);
    expect(replay.headers).toMatchObject({
      'idempotency-replayed': 'true',
      etag: first.headers.etag,
      location: first.headers.location,
    });
    expect(replay.json()).toEqual(first.json());
    expect(reused.statusCode).toBe(422);
    expect(reused.json()).toMatchObject({ type: 'urn:questline:problem:idempotency-key-reused' });
    expect(await stored(userId)).toHaveLength(1);
  });

  it.each([
    ['no Idempotency-Key', FULL, null],
    ['a malformed Idempotency-Key', FULL, 'retry-1'],
    ['no title', { description: 'x' }, undefined],
    ['an empty title', { title: '' }, undefined],
    ['a title of 121 characters', { title: 'x'.repeat(121) }, undefined],
    ['an impossible target date', { title: 'x', target_date: '2027-02-30' }, undefined],
    ['a status', { title: 'x', status: 'completed' }, undefined],
    ['XP', { title: 'x', xp_earned: 1000 }, undefined],
    ['an owner', { title: 'x', user_id: randomUUID() }, undefined],
    ['an attempt', { title: 'x', attempt: 3 }, undefined],
  ])('refuses a create with %s with 400 and stores nothing [R-IN-01, R-AUTHZ-04]', async (_case, body, key) => {
    const { userId, token } = await user();
    const headers: Record<string, string> = bearer(token);
    if (key !== null) headers['idempotency-key'] = key ?? randomUUID();

    const response = await ctx.post('/v1/achievements', body, headers);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ type: 'urn:questline:problem:validation' });
    expect(await stored(userId)).toEqual([]);
  });

  it('lists achievements newest first in cursor pages, filtered by status, and only the caller’s [R-ACH-08]', async () => {
    const { userId, token } = await user();
    const other = await user();
    await create(other.token, { title: 'Not yours' });
    const titles = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];
    for (const title of titles) {
      await create(token, { title });
      ctx.clock.advance({ milliseconds: 1000 });
    }
    await ctx.admin.sql`update achievements set status = 'paused' where user_id = ${userId} and created_at = (
      select min(created_at) from achievements where user_id = ${userId})`;

    const read: string[] = [];
    let query = '?limit=2';
    for (;;) {
      const response = await list(token, query);
      expect(response.statusCode).toBe(200);
      const page = response.json<Page>();
      expect(page.items.length).toBeLessThanOrEqual(2);
      read.push(...page.items.map((item) => item.title));
      if (page.next_cursor === null) break;
      query = `?limit=2&cursor=${page.next_cursor}`;
    }

    expect(read).toEqual([...titles].reverse());
    expect((await list(token, '?status=paused')).json<Page>().items.map((item) => item.title)).toEqual(['First']);
    expect((await list(token, '?status=completed')).json<Page>()).toEqual({ items: [], next_cursor: null });
    expect((await list(token)).json<Page>().items).toHaveLength(5);
  });

  it.each(['?limit=0', '?limit=101', '?cursor=bm90LWEtY3Vyc29y', '?status=archived'])(
    'refuses the list query %s with 400',
    async (query) => {
      const { token } = await user();

      const response = await list(token, query);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ type: 'urn:questline:problem:validation' });
    },
  );
});
