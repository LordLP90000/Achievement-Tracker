import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer, createAchievement, goalUser, type GoalUser } from '../helpers/goals.ts';
import { resolveRef, specOperations, type SpecOperation } from '../helpers/openapi.ts';

const START = '2026-10-29T12:00:00Z';
const TODAY = '2026-10-29';
const IF_MATCH = '#/components/parameters/IfMatch';
const IDEMPOTENCY_KEY = '#/components/parameters/IdempotencyKey';

/** Path parameters naming a record of one user, and the owner's record each one names in this suite. */
const OWNED = {
  '#/components/parameters/SessionId': 'session',
  '#/components/parameters/AchievementId': 'achievement',
  '#/components/parameters/QuestId': 'quest',
  '#/components/parameters/CheckInId': 'checkIn',
} as const;
type Owned = (typeof OWNED)[keyof typeof OWNED];

/** Path parameters that name no record of anyone: a consent type names one of the caller's own consents. */
const NOT_OWNED = new Set(['path:type']);

/** A valid body for each such operation, so that nothing but ownership can refuse the request. */
const BODIES: Readonly<Record<string, unknown>> = {
  updateAchievement: { title: 'Taken over' },
  createQuest: { title: 'Planted', type: 'one_time', size: 'M' },
  placeGamble: {},
  updateQuest: { title: 'Taken over' },
  createCheckIn: { local_date: TODAY },
};

const isPathParameter = (parameter: string) =>
  parameter.startsWith('path:') || (parameter.startsWith('#/') && resolveRef({ $ref: parameter })['in'] === 'path');
const ownedParameterOf = (operation: SpecOperation) =>
  operation.parameters.find((parameter): parameter is keyof typeof OWNED => parameter in OWNED);
const guarded = specOperations.filter((operation) => ownedParameterOf(operation) !== undefined);

interface Resource {
  readonly id: string;
  readonly version?: number;
  readonly [field: string]: unknown;
}

/**
 * Ownership across the contract (R-AUTHZ-02/03, T-01, I-04, I-14): for every operation with a path ID, another user's
 * record does not exist — 404, never 403 — and nothing changes for either user. Generated from the contract: a new
 * path parameter or operation fails here until it is classified and has a fixture.
 */
describe('ownership [R-AUTHZ-02, R-AUTHZ-03, T-01, I-04, I-14]', () => {
  let ctx: AccountsApp;
  let owner: GoalUser;
  let intruder: GoalUser;
  const records = new Map<Owned, Resource>();
  let userTables: readonly string[];
  let before: Map<string, unknown>;

  /** Every row of every table with a `user_id`, per user: what no foreign request may change. */
  const snapshot = async (): Promise<Map<string, unknown>> => {
    const rows = new Map<string, unknown>();
    for (const user of [owner, intruder]) {
      for (const table of userTables) {
        const found = await ctx.admin.sql`select * from ${ctx.admin.sql(table)} where user_id = ${user.userId}`;
        rows.set(`${user.userId}:${table}`, found.map((row) => JSON.stringify(row)).sort());
      }
    }
    return rows;
  };

  const request = (operation: SpecOperation, id: string, version: number | undefined) => {
    const body = BODIES[operation.operationId];
    return contractInject(ctx.app, {
      method: operation.method as 'GET',
      url: operation.path.replace(/\{[^}]+\}/, id),
      headers: {
        ...bearer(intruder.token),
        ...(operation.parameters.includes(IF_MATCH) ? { 'if-match': `"${String(version ?? 1)}"` } : {}),
        ...(operation.parameters.includes(IDEMPOTENCY_KEY) ? { 'idempotency-key': randomUUID() } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  };

  beforeAll(async () => {
    ctx = await startAccountsApp();
    ctx.clock.set(START);
    owner = await goalUser(ctx);
    intruder = await goalUser(ctx);
    const created = async (url: string, body: unknown) => {
      const response = await ctx.post(url, body, { ...bearer(owner.token), 'idempotency-key': randomUUID() });
      if (response.statusCode !== 201) throw new Error(`${url} answered ${String(response.statusCode)}`);
      return response.json<Resource & { check_in?: Resource }>();
    };
    const achievement = (
      await createAchievement(ctx, owner.token, { title: 'Mine', target_date: '2026-11-30' })
    ).json<Resource>();
    const quest = await created(`/v1/achievements/${achievement.id}/quests`, {
      title: 'Mine',
      type: 'one_time',
      size: 'M',
    });
    await created(`/v1/achievements/${achievement.id}/quests`, { title: 'Still open', type: 'one_time', size: 'M' });
    const checkIn = (await created(`/v1/quests/${quest.id}/check-ins`, { local_date: TODAY })).check_in;
    const get = async (url: string) =>
      (await contractInject(ctx.app, { method: 'GET', url, headers: bearer(owner.token) })).json<Resource>();
    const sessions = await get('/v1/me/sessions');
    records.set('achievement', await get(`/v1/achievements/${achievement.id}`));
    records.set('quest', await get(`/v1/quests/${quest.id}`));
    records.set('checkIn', checkIn ?? { id: '' });
    records.set('session', (sessions['items'] as Resource[])[0] ?? { id: '' });
    const tables = await ctx.admin.sql<{ table_name: string }[]>`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'user_id' order by table_name`;
    userTables = tables.map((table) => table.table_name);
    before = await snapshot();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.clock.set(START);
  });

  it('classifies every path parameter of the contract and has a body for every operation that takes one', () => {
    const parameters = new Set(specOperations.flatMap((operation) => operation.parameters.filter(isPathParameter)));

    expect([...parameters].sort()).toEqual([...Object.keys(OWNED), ...NOT_OWNED].sort());
    expect(guarded.filter((operation) => operation.hasRequestBody).map((operation) => operation.operationId)).toEqual(
      expect.arrayContaining(Object.keys(BODIES)),
    );
    expect(guarded.filter((operation) => operation.hasRequestBody && !(operation.operationId in BODIES))).toEqual([]);
    expect(guarded.length).toBeGreaterThanOrEqual(14);
    expect([...records.values()].every((record) => record.id !== '')).toBe(true);
  });

  it.each(guarded.map((operation) => [operation.operationId, operation] as const))(
    '%s answers 404 for another user’s record, an unknown and a malformed ID, and changes nothing',
    async (_operationId, operation) => {
      const parameter = ownedParameterOf(operation);
      const record = parameter === undefined ? undefined : records.get(OWNED[parameter]);
      expect(record).toBeDefined();

      for (const id of [record?.id ?? '', randomUUID(), 'not-a-uuid']) {
        const response = await request(operation, id, record?.version);

        expect(response.statusCode, id).toBe(404);
        expect(response.json(), id).toMatchObject({ type: 'urn:questline:problem:not-found', status: 404 });
      }
      expect(await snapshot()).toEqual(before);
    },
  );

  it('leaves the owner’s session, achievement and quest usable', async () => {
    for (const record of ['achievement', 'quest'] as const) {
      const url = `/v1/${record === 'achievement' ? 'achievements' : 'quests'}/${records.get(record)?.id ?? ''}`;
      const response = await contractInject(ctx.app, { method: 'GET', url, headers: bearer(owner.token) });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ title: 'Mine', version: records.get(record)?.version });
    }
  });
});
