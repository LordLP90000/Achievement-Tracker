import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer, createAchievement, goalUser, type GoalUser } from '../helpers/goals.ts';
import { specOperations, type SpecOperation } from '../helpers/openapi.ts';

const START = '2026-10-29T12:00:00Z';
const TODAY = '2026-10-29';
const CONSENT_REQUIRED = '#/components/responses/ConsentRequired';
const IDEMPOTENCY_KEY = '#/components/parameters/IdempotencyKey';
const GOAL_PATHS = ['/v1/achievements', '/v1/quests', '/v1/check-ins'];
/** Where goal content lives, also inside stored responses (R-PRIV-04, Q-10). */
const GOAL_TABLES = ['achievements', 'quests', 'check_ins', 'gambles', 'xp_events', 'badges', 'idempotency_keys'];

/** Operations that add goal rows without the consent, and why that is right. */
const EXEMPT: Readonly<Record<string, string>> = {
  placeGamble: 'stakes XP on an achievement, which needed the consent; a gamble holds no goal content',
};

/** A valid body for each guarded operation, so that nothing but the consent can refuse the request. */
const BODIES: Readonly<Record<string, unknown>> = {
  createAchievement: { title: 'Goal' },
  createQuest: { title: 'Quest', type: 'one_time', size: 'M' },
  createCheckIn: { local_date: TODAY },
};

const documentsConsent = (operation: SpecOperation) =>
  (operation.responses['403'] as { $ref?: unknown } | undefined)?.$ref === CONSENT_REQUIRED;
const guarded = specOperations.filter(documentsConsent);
const addsGoalRows = specOperations.filter(
  (operation) => operation.method === 'POST' && GOAL_PATHS.some((path) => operation.path.startsWith(path)),
);

/**
 * Goal content needs an active `goal_content` consent (R-PRIV-04, E-10): every operation that documents
 * `ConsentRequired` refuses a user who never granted it or withdrew it — with 403 before anything else, whatever the
 * IDs — and stores nothing, not even the idempotency record. Generated from the contract.
 */
describe('consent guard [R-PRIV-04, E-10]', () => {
  let ctx: AccountsApp;
  let neverGranted: GoalUser;
  let withdrawn: GoalUser;
  let formerIds: { achievementId: string; questId: string };
  let userTables: readonly string[];

  const stored = async (user: GoalUser, tables: readonly string[] = userTables) => {
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const [row] = await ctx.admin.sql<{ count: number }[]>`
        select count(*)::int as count from ${ctx.admin.sql(table)} where user_id = ${user.userId}`;
      counts[table] = row?.count ?? -1;
    }
    return counts;
  };

  const request = (operation: SpecOperation, user: GoalUser, ids: Record<string, string>) => {
    const body = BODIES[operation.operationId];
    return contractInject(ctx.app, {
      method: operation.method as 'POST',
      url: operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => ids[name] ?? randomUUID()),
      headers: {
        ...bearer(user.token),
        ...(operation.parameters.includes(IDEMPOTENCY_KEY) ? { 'idempotency-key': randomUUID() } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  };

  beforeAll(async () => {
    ctx = await startAccountsApp();
    ctx.clock.set(START);
    neverGranted = await goalUser(ctx, { consent: false });
    withdrawn = await goalUser(ctx);
    const achievement = (await createAchievement(ctx, withdrawn.token, { title: 'Before' })).json<{ id: string }>();
    const quest = await ctx.post(
      `/v1/achievements/${achievement.id}/quests`,
      { title: 'Before', type: 'one_time', size: 'M' },
      { ...bearer(withdrawn.token), 'idempotency-key': randomUUID() },
    );
    formerIds = { achievementId: achievement.id, questId: quest.json<{ id: string }>().id };
    const withdrawal = await contractInject(ctx.app, {
      method: 'DELETE',
      url: '/v1/me/consents/goal_content',
      headers: bearer(withdrawn.token),
    });
    if (withdrawal.statusCode !== 204) throw new Error(`withdrawal answered ${String(withdrawal.statusCode)}`);
    const tables = await ctx.admin.sql<{ table_name: string }[]>`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'user_id' order by table_name`;
    userTables = tables.map((table) => table.table_name);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.clock.set(START);
  });

  it('guards or exempts every operation that adds goal rows, and has a body for each guarded one', () => {
    const operationIds = (operations: readonly SpecOperation[]) => operations.map((operation) => operation.operationId);

    expect(operationIds(addsGoalRows).sort()).toEqual([...operationIds(guarded), ...Object.keys(EXEMPT)].sort());
    expect(operationIds(guarded).sort()).toEqual(Object.keys(BODIES).sort());
  });

  it.each(guarded.map((operation) => [operation.operationId, operation] as const))(
    '%s answers 403 consent-required to a user who never granted the consent or withdrew it, storing nothing',
    async (_operationId, operation) => {
      for (const [user, ids] of [
        [neverGranted, {}],
        [withdrawn, formerIds],
      ] as const) {
        const before = await stored(user);

        const response = await request(operation, user, ids);

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ type: 'urn:questline:problem:consent-required', status: 403 });
        expect(await stored(user)).toEqual(before);
      }
    },
  );

  it('leaves neither user any goal content, nor a response that holds some', async () => {
    expect(userTables).toEqual(expect.arrayContaining(GOAL_TABLES));
    for (const user of [withdrawn, neverGranted]) {
      expect(Object.values(await stored(user, GOAL_TABLES))).toEqual(GOAL_TABLES.map(() => 0));
    }
  });
});
