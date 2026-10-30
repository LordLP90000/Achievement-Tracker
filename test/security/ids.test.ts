import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer, createAchievement, goalUser, type GoalUser } from '../helpers/goals.ts';
import { resolveRef } from '../helpers/openapi.ts';

const START = '2026-10-29T12:00:00Z';
const TODAY = '2026-10-29';
/** The contract's `Uuid`: lower-case, version 4, RFC 9562 variant. */
const UUID_V4 = new RegExp(String(resolveRef({ $ref: '#/components/schemas/Uuid' })['pattern']), 'u');

interface Resource {
  readonly id: string;
  readonly [field: string]: unknown;
}

/**
 * Random UUID v4 IDs only (R-OUT-02): the application draws every ID from the CSPRNG, so an ID tells nothing about
 * when a record was made or how many others exist, and cannot be guessed (T-01, I-14).
 */
describe('identifiers [R-OUT-02]', () => {
  let ctx: AccountsApp;
  let user: GoalUser;

  beforeAll(async () => {
    ctx = await startAccountsApp();
    ctx.clock.set(START);
    user = await goalUser(ctx);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('keys every table with an ID the application generates: no sequence, identity or default', async () => {
    const columns = await ctx.admin.sql<
      { table_name: string; data_type: string; column_default: string | null; is_identity: string }[]
    >`
      select table_name, data_type, column_default, is_identity from information_schema.columns
      where table_schema = 'public' and column_name = 'id' order by table_name`;
    const sequences = await ctx.admin.sql`
      select sequence_name from information_schema.sequences where sequence_schema = 'public'`;

    expect(columns.length).toBeGreaterThanOrEqual(10);
    expect(
      columns.filter(
        (column) => column.data_type !== 'uuid' || column.column_default !== null || column.is_identity !== 'NO',
      ),
    ).toEqual([]);
    expect(sequences).toEqual([]);
  });

  it('answers with random UUID v4 for every resource, no two sharing a prefix though made in the same instant', async () => {
    const created = async (url: string, body: unknown) => {
      const response = await ctx.post(url, body, { ...bearer(user.token), 'idempotency-key': randomUUID() });
      if (response.statusCode !== 201) throw new Error(`${url} answered ${String(response.statusCode)}`);
      return response.json<Resource & { check_in?: Resource }>();
    };
    const get = async (url: string) =>
      (await contractInject(ctx.app, { method: 'GET', url, headers: bearer(user.token) })).json<Resource>();
    const ids: string[] = [(await get('/v1/me')).id];
    for (let index = 0; index < 3; index += 1) {
      const achievement = (
        await createAchievement(ctx, user.token, { title: `Goal ${String(index)}`, target_date: '2026-11-30' })
      ).json<Resource>();
      // The bonus habit first: the one-time quest completes the achievement, which then takes no check-in.
      const quests = [
        await created(`/v1/achievements/${achievement.id}/quests`, {
          title: 'Daily',
          type: 'habit',
          size: 'S',
          is_required: false,
          habit: { period: 'day', times_per_period: 1, period_count: 5 },
        }),
        await created(`/v1/achievements/${achievement.id}/quests`, { title: 'Once', type: 'one_time', size: 'S' }),
      ];
      ids.push(achievement.id, ...quests.map((quest) => quest.id));
      for (const quest of quests)
        ids.push((await created(`/v1/quests/${quest.id}/check-ins`, { local_date: TODAY })).check_in?.id ?? '');
    }
    await ctx.admin.sql`
      insert into xp_events (id, user_id, kind, amount, local_date, created_at)
      values (${randomUUID()}, ${user.userId}, 'quest_completed', 250, ${TODAY}, ${ctx.clock.now()})`;
    const open = (
      await createAchievement(ctx, user.token, { title: 'Open', target_date: '2026-11-30' })
    ).json<Resource>();
    ids.push(open.id, (await created(`/v1/achievements/${open.id}/gambles`, {})).id);
    const sessions = await get('/v1/me/sessions');
    const stats = await get('/v1/me/stats');
    ids.push(
      ...(sessions['items'] as Resource[]).map((session) => session.id),
      ...(stats['badges'] as Resource[]).map((badge) => badge.id),
    );

    // The account, 3 × (achievement, 2 quests, 2 check-ins), an achievement, a gamble, the session, 3 badges.
    expect(ids).toHaveLength(22);
    expect(ids.filter((id) => !UUID_V4.test(id))).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    // Time-based UUIDs (v1, v6, v7) made within one minute share their leading digits; random ones practically never.
    expect(new Set(ids.map((id) => id.slice(0, 8))).size).toBe(ids.length);
  });
});
