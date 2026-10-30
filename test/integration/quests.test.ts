import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkInsRepository } from '../../src/modules/check-ins/repository.ts';
import { withGoals, type GoalDependencies } from '../../src/modules/goals/engine.ts';
import { questsRepository } from '../../src/modules/quests/repository.ts';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createDatabase } from '../../src/platform/db/database.ts';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer, createAchievement, goalUser, type GoalUser } from '../helpers/goals.ts';

const TODAY = '2026-10-29';

interface Quest {
  readonly id: string;
  readonly [field: string]: unknown;
}

/** Quest API (contract tag `quests`): create, list and show; derived values come from the goal engine. */
describe('quests [R-QST-01…06, R-XP-02, R-IN-01, A-05, A-28, Q-34]', () => {
  let ctx: AccountsApp;
  let client: DatabaseClient;
  let deps: GoalDependencies;

  const achievementOf = async (user: GoalUser, body: Record<string, unknown> = { title: 'Goal' }) =>
    (await createAchievement(ctx, user.token, body)).json<{ id: string }>().id;
  const createQuest = (user: GoalUser, achievementId: string, body: unknown, key: string = randomUUID()) =>
    ctx.post(`/v1/achievements/${achievementId}/quests`, body, { ...bearer(user.token), 'idempotency-key': key });
  const listQuests = (user: GoalUser, achievementId: string) =>
    contractInject(ctx.app, {
      method: 'GET',
      url: `/v1/achievements/${achievementId}/quests`,
      headers: bearer(user.token),
    });
  const getQuest = (user: GoalUser, questId: string) =>
    contractInject(ctx.app, { method: 'GET', url: `/v1/quests/${questId}`, headers: bearer(user.token) });
  const getAchievement = (user: GoalUser, achievementId: string) =>
    contractInject(ctx.app, { method: 'GET', url: `/v1/achievements/${achievementId}`, headers: bearer(user.token) });
  const checkIn = (user: GoalUser, questId: string) =>
    withGoals(deps, user.userId, (scope) =>
      checkInsRepository(scope.tx, user.userId, scope.dataKey).insert(
        { questId, localDate: scope.today, attempt: 1, countsForProgress: true, value: null, note: null },
        scope.now,
      ),
    );
  const stored = (achievementId: string) =>
    ctx.admin.sql<Record<string, unknown>[]>`select * from quests where achievement_id = ${achievementId}`;

  beforeAll(async () => {
    ctx = await startAccountsApp();
    client = createDatabaseClient({ url: ctx.database.urls.app, applicationName: 'questline-test' });
    deps = { db: createDatabase(client), dataKeys: ctx.dataKeys, clock: ctx.clock };
  });

  afterAll(async () => {
    await client.close();
    await ctx.close();
  });

  it('creates a one-time quest with its derived XP, state and version, and where to find it [R-QST-01, R-QST-03]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);

    const response = await createQuest(user, achievementId, {
      title: 'Buy running shoes',
      type: 'one_time',
      size: 'M',
    });

    expect(response.statusCode).toBe(201);
    const quest = response.json<Quest>();
    expect(response.headers).toMatchObject({ etag: '"1"', location: `/v1/quests/${quest.id}` });
    const now = ctx.clock.now().toISOString();
    expect(quest).toEqual({
      id: quest.id,
      achievement_id: achievementId,
      title: 'Buy running shoes',
      notes: null,
      type: 'one_time',
      size: 'M',
      xp: 25,
      duration_factor: 1,
      is_required: true,
      position: 0,
      prerequisite_quest_id: null,
      state: 'available',
      progress: 0,
      reset_count: 0,
      habit: null,
      target: null,
      current_value: null,
      streak: null,
      current_period: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
      version: 1,
    });
  });

  it('starts a habit today by default, with the account’s week start, weighted by its duration [R-QST-04, R-XP-02, Q-34]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);

    const quest = (
      await createQuest(user, achievementId, {
        title: 'Run three times a week',
        type: 'habit',
        size: 'M',
        habit: { period: 'week', times_per_period: 3, period_count: 8 },
      })
    ).json<Quest>();

    expect(quest).toMatchObject({
      xp: 38,
      duration_factor: 1.5,
      state: 'available',
      habit: { period: 'week', times_per_period: 3, period_count: 8, start_date: TODAY },
      streak: { current: 0, best: 0, period: 'week' },
      current_period: { start: TODAY, end: '2026-11-08', check_ins: 0, required_check_ins: 3 },
    });
    expect((await stored(achievementId))[0]).toMatchObject({ habit_week_start: 'monday' });
  });

  it('measures a target quest from its start value, with canonical decimals [R-QST-05, A-05]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);

    const quest = (
      await createQuest(user, achievementId, {
        title: 'Reach 70 kg',
        type: 'target',
        size: 'L',
        target: { start_value: '80.50', target_value: '70', unit: 'kg' },
      })
    ).json<Quest>();

    expect(quest).toMatchObject({
      xp: 50,
      target: { start_value: '80.5', target_value: '70', unit: 'kg' },
      current_value: '80.5',
      progress: 0,
    });
  });

  it('stores title, notes, unit and values only encrypted [R-QST-06]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const { id } = (
      await createQuest(user, achievementId, {
        title: 'Reach the summit',
        notes: 'Bring water',
        type: 'target',
        size: 'S',
        target: { start_value: '1200', target_value: '4478', unit: 'metres' },
      })
    ).json<Quest>();

    const [row] = await stored(achievementId);
    const fields = {
      title_enc: 'Reach the summit',
      notes_enc: 'Bring water',
      unit_enc: 'metres',
      start_value_enc: '1200',
      target_value_enc: '4478',
    };
    for (const [field, plaintext] of Object.entries(fields)) {
      const blob = row?.[field] as Buffer;
      expect(blob.toString('latin1')).not.toContain(plaintext);
      expect(await ctx.decrypt(user.userId, id, field, blob)).toBe(plaintext);
    }
  });

  it('lists the quests of an achievement in order and shows them in the achievement with its derived values [R-ACH-03]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const first = (
      await createQuest(user, achievementId, { title: 'First', type: 'one_time', size: 'L' })
    ).json<Quest>();
    ctx.clock.advance({ milliseconds: 1 });
    const bonus = (
      await createQuest(user, achievementId, { title: 'Bonus', type: 'one_time', size: 'S', is_required: false })
    ).json<Quest>();
    ctx.clock.advance({ milliseconds: 1 });
    const early = (
      await createQuest(user, achievementId, { title: 'Before all', type: 'one_time', size: 'M', position: 0 })
    ).json<Quest>();

    const listed = await listQuests(user, achievementId);
    const detail = await getAchievement(user, achievementId);

    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: Quest[] }>().items.map((quest) => quest['title'])).toEqual([
      'First',
      'Before all',
      'Bonus',
    ]);
    expect([first['position'], early['position'], bonus['position']]).toEqual([0, 0, 1]);
    expect(detail.json()).toMatchObject({ progress: 0, xp_required_total: 75, xp_earned: 0 });
    expect(detail.json<{ quests: Quest[] }>().quests).toEqual(listed.json<{ items: Quest[] }>().items);
  });

  it('shows a quest with its version, and answers 404 for any other ID [R-AUTHZ-02]', async () => {
    const owner = await goalUser(ctx);
    const intruder = await goalUser(ctx);
    const achievementId = await achievementOf(owner);
    const quest = (
      await createQuest(owner, achievementId, { title: 'Mine', type: 'one_time', size: 'S' })
    ).json<Quest>();

    const shown = await getQuest(owner, quest.id);

    expect(shown.statusCode).toBe(200);
    expect(shown.headers.etag).toBe('"1"');
    expect(shown.json()).toEqual(quest);
    for (const [user, id] of [
      [intruder, quest.id],
      [owner, randomUUID()],
      [owner, 'not-a-uuid'],
    ] as const) {
      expect((await getQuest(user, id)).statusCode).toBe(404);
    }
    for (const [user, id] of [
      [intruder, achievementId],
      [owner, randomUUID()],
      [owner, 'not-a-uuid'],
    ] as const) {
      expect((await listQuests(user, id)).statusCode).toBe(404);
      expect((await createQuest(user, id, { title: 'Sneaky', type: 'one_time', size: 'S' })).statusCode).toBe(404);
    }
    expect(await stored(achievementId)).toHaveLength(1);
  });

  it('shows the effects of check-ins in the quest and its achievement [R-ACH-03, R-ACH-04]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const quest = (
      await createQuest(user, achievementId, { title: 'Do it', type: 'one_time', size: 'M' })
    ).json<Quest>();
    await checkIn(user, quest.id);

    const shown = (await getQuest(user, quest.id)).json<Quest>();
    const detail = (await getAchievement(user, achievementId)).json<Record<string, unknown>>();

    expect(shown).toMatchObject({
      state: 'completed',
      progress: 1,
      completed_at: ctx.clock.now().toISOString(),
      version: 2,
    });
    expect(detail).toMatchObject({
      status: 'completed',
      progress: 1,
      xp_earned: 25,
      rank: 'champion',
      execution_score: 100,
    });
  });

  it('refuses quests in a completed achievement with 409, which is read-only [R-QST-07]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const quest = (
      await createQuest(user, achievementId, { title: 'Only one', type: 'one_time', size: 'M' })
    ).json<Quest>();
    await checkIn(user, quest.id);
    await getAchievement(user, achievementId);

    const refused = await createQuest(user, achievementId, { title: 'Too late', type: 'one_time', size: 'S' });

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ type: 'urn:questline:problem:achievement-completed' });
  });

  it('refuses quests without the goal-content consent with 403 [R-PRIV-04]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    await contractInject(ctx.app, {
      method: 'DELETE',
      url: '/v1/me/consents/goal_content',
      headers: bearer(user.token),
    });

    const refused = await createQuest(user, achievementId, { title: 'No consent', type: 'one_time', size: 'S' });

    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ type: 'urn:questline:problem:consent-required' });
  });

  it('replays a repeated create and refuses its key for another body [ADR-0008]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const key = randomUUID();
    const body = { title: 'Once', type: 'one_time', size: 'S' };
    const first = await createQuest(user, achievementId, body, key);

    const replay = await createQuest(user, achievementId, body, key);
    const reused = await createQuest(user, achievementId, { ...body, title: 'Twice' }, key);

    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(reused.statusCode).toBe(422);
    expect(await stored(achievementId)).toHaveLength(1);
  });

  it('accepts 50 quests per achievement and refuses the 51st with 422 limit-reached [R-IN-01]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    await withGoals(deps, user.userId, async (scope) => {
      const quests = questsRepository(scope.tx, user.userId, scope.dataKey);
      for (let position = 0; position < 49; position += 1) {
        await quests.insert(
          {
            achievementId,
            position,
            type: 'one_time',
            size: 'S',
            isRequired: true,
            prerequisiteQuestId: null,
            title: `Quest ${String(position)}`,
            notes: null,
            habit: null,
            target: null,
          },
          scope.now,
        );
      }
    });

    expect((await createQuest(user, achievementId, { title: '50th', type: 'one_time', size: 'S' })).statusCode).toBe(
      201,
    );
    const refused = await createQuest(user, achievementId, { title: '51st', type: 'one_time', size: 'S' });

    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ type: 'urn:questline:problem:limit-reached' });
  });

  it.each([
    ['a habit quest without habit settings', { type: 'habit' }, '/habit'],
    [
      'habit settings on a one-time quest',
      { habit: { period: 'day', times_per_period: 1, period_count: 3 } },
      '/habit',
    ],
    ['a target quest without target values', { type: 'target' }, '/target'],
    [
      'target values on a habit quest',
      {
        type: 'habit',
        habit: { period: 'day', times_per_period: 1, period_count: 3 },
        target: { start_value: '1', target_value: '2' },
      },
      '/target',
    ],
    [
      'a start date in the past',
      { type: 'habit', habit: { period: 'day', times_per_period: 1, period_count: 3, start_date: '2026-10-28' } },
      '/habit/start_date',
    ],
    [
      'equal start and target values',
      { type: 'target', target: { start_value: '70', target_value: '70.000' } },
      '/target/target_value',
    ],
    [
      'a value beyond 10^9',
      { type: 'target', target: { start_value: '0', target_value: '1000000000.001' } },
      '/target/target_value',
    ],
    [
      'a start value below -10^9',
      { type: 'target', target: { start_value: '-1000000000.5', target_value: '0' } },
      '/target/start_value',
    ],
    ['an unknown prerequisite', { prerequisite_quest_id: randomUUID() }, '/prerequisite_quest_id'],
  ])('refuses %s with 422 and stores nothing [A-05, A-28, R-QST-02]', async (_case, overrides, pointer) => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);

    const response = await createQuest(user, achievementId, {
      title: 'Quest',
      type: 'one_time',
      size: 'M',
      ...overrides,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ errors: [{ pointer }] });
    expect(await stored(achievementId)).toEqual([]);
  });

  it('refuses a prerequisite from another achievement, which looks unknown [R-QST-02, A-16]', async () => {
    const user = await goalUser(ctx);
    const elsewhere = (
      await createQuest(user, await achievementOf(user), { title: 'Elsewhere', type: 'one_time', size: 'S' })
    ).json<Quest>();
    const achievementId = await achievementOf(user);

    const response = await createQuest(user, achievementId, {
      title: 'Linked',
      type: 'one_time',
      size: 'S',
      prerequisite_quest_id: elsewhere.id,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      errors: [{ pointer: '/prerequisite_quest_id', message: 'is not a quest of this achievement' }],
    });
  });

  it('locks a quest behind its prerequisite and refuses chains of more than 20 links [R-QST-02, A-16]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    let previous: string | undefined;
    for (let link = 0; link <= 20; link += 1) {
      const created = await createQuest(user, achievementId, {
        title: `Step ${String(link)}`,
        type: 'one_time',
        size: 'S',
        ...(previous === undefined ? {} : { prerequisite_quest_id: previous }),
      });
      expect(created.statusCode).toBe(201);
      if (previous !== undefined) expect(created.json()).toMatchObject({ state: 'locked' });
      previous = created.json<Quest>().id;
    }

    const tooDeep = await createQuest(user, achievementId, {
      title: 'Step 21',
      type: 'one_time',
      size: 'S',
      prerequisite_quest_id: previous,
    });

    expect(tooDeep.statusCode).toBe(422);
    expect(tooDeep.json()).toMatchObject({
      errors: [{ pointer: '/prerequisite_quest_id', message: 'would make a chain of more than 20 quests' }],
    });
  });

  it.each([
    ['no title', { type: 'one_time', size: 'M' }],
    ['an unknown type', { title: 'x', type: 'chore', size: 'M' }],
    ['an unknown size', { title: 'x', type: 'one_time', size: 'XL' }],
    ['XP', { title: 'x', type: 'one_time', size: 'M', xp: 500 }],
    ['a state', { title: 'x', type: 'one_time', size: 'M', state: 'completed' }],
    ['a position over 1000', { title: 'x', type: 'one_time', size: 'M', position: 1001 }],
    [
      'a value with 4 decimals',
      { title: 'x', type: 'target', size: 'M', target: { start_value: '1.2345', target_value: '2' } },
    ],
    [
      '0 check-ins per period',
      { title: 'x', type: 'habit', size: 'M', habit: { period: 'day', times_per_period: 0, period_count: 3 } },
    ],
    [
      'an unknown habit setting',
      {
        title: 'x',
        type: 'habit',
        size: 'M',
        habit: { period: 'day', times_per_period: 1, period_count: 3, reset_count: 0 },
      },
    ],
  ])('refuses a quest with %s with 400 [R-IN-01, R-AUTHZ-04]', async (_case, body) => {
    const user = await goalUser(ctx);

    const response = await createQuest(user, await achievementOf(user), body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ type: 'urn:questline:problem:validation' });
  });
});
