import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { createAchievement, goalUser, insertAchievements } from '../helpers/goals.ts';

/** Per-user limits on collections (R-IN-01, Q-16, threat D-03). */
describe('limits per user [R-IN-01, D-03]', () => {
  let ctx: AccountsApp;

  const open = async (userId: string) =>
    (
      await ctx.admin.sql<{ count: number }[]>`
        select count(*)::int as count from achievements where user_id = ${userId} and status <> 'completed'`
    )[0]?.count;

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('accepts 200 active or paused achievements and refuses the next with 422 limit-reached [Q-40]', async () => {
    const { userId, token } = await goalUser(ctx);
    await insertAchievements(ctx, userId, 150, 'active');
    await insertAchievements(ctx, userId, 49, 'paused');

    expect((await createAchievement(ctx, token, { title: 'The 200th' })).statusCode).toBe(201);
    const refused = await createAchievement(ctx, token, { title: 'The 201st' });

    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      type: 'urn:questline:problem:limit-reached',
      errors: [{ pointer: '', message: expect.stringContaining('200') as unknown }],
    });
    expect(await open(userId)).toBe(200);
  });

  it('does not count completed achievements, the read-only archive (Q-40)', async () => {
    const { userId, token } = await goalUser(ctx);
    await insertAchievements(ctx, userId, 250, 'completed');
    await insertAchievements(ctx, userId, 199, 'active');

    expect((await createAchievement(ctx, token, { title: 'The 200th open one' })).statusCode).toBe(201);
    expect((await createAchievement(ctx, token, { title: 'One too many' })).statusCode).toBe(422);
  });

  it('never lets simultaneous creates exceed the limit', async () => {
    const { userId, token } = await goalUser(ctx);
    await insertAchievements(ctx, userId, 195, 'active');

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) => createAchievement(ctx, token, { title: `Rush ${String(index)}` })),
    );

    const statuses = responses.map((response) => response.statusCode);
    expect([
      statuses.filter((status) => status === 201).length,
      statuses.filter((status) => status === 422).length,
    ]).toEqual([5, 5]);
    expect(await open(userId)).toBe(200);
  });
});
