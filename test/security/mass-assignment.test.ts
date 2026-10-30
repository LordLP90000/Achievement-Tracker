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

/** The resource each operation writes: its fields are the server's, except those the request schema accepts. */
const RESOURCES: Readonly<Record<string, string>> = {
  updateMe: 'Account',
  grantConsent: 'Consent',
  createAchievement: 'Achievement',
  updateAchievement: 'Achievement',
  createQuest: 'Quest',
  placeGamble: 'Gamble',
  updateQuest: 'Quest',
  createCheckIn: 'CheckIn',
};

/** Accepted fields whose values the server alone sets (R-AUTHZ-04): only a pause or a resume is a client's status. */
const SERVER_VALUES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['updateAchievement', { status: 'completed' }],
];

const PASSWORD = 'correct horse battery staple';
const TOKEN = `ql_vr_${'A'.repeat(43)}`;
/** A valid body of every other operation: authentication flows, which write no resource of the API. */
const FLOWS: Readonly<Record<string, Record<string, unknown>>> = {
  register: {
    email: 'mass@example.test',
    password: PASSWORD,
    privacy_policy_version: '2026-10-01',
    age_confirmed: true,
  },
  verifyEmail: { token: TOKEN },
  resendVerification: { email: 'mass@example.test' },
  login: { email: 'mass@example.test', password: PASSWORD, client: 'ios' },
  refresh: { refresh_token: TOKEN },
  reauthenticate: { password: PASSWORD },
  forgotPassword: { email: 'mass@example.test' },
  resetPassword: { token: TOKEN, new_password: PASSWORD },
  changePassword: { current_password: PASSWORD, new_password: `${PASSWORD} again` },
  requestEmailChange: { new_email: 'mass-next@example.test' },
  confirmEmailChange: { token: TOKEN },
};

/** What a client would like to set; values the server would never give it. */
const TEMPTING: Readonly<Record<string, unknown>> = {
  status: 'completed',
  state: 'completed',
  rank: 'champion',
  execution_score: 100,
  attempt: 99,
  version: 99,
  xp: 1_000_000,
  xp_total: 1_000_000,
  xp_earned: 1_000_000,
  xp_required_total: 0,
  level: 99,
  stake: 1_000_000,
  progress: 1,
  reset_count: 0,
  email_verified: true,
  counts_for_progress: true,
  loss_reason: null,
};
const forged = (field: string): unknown => {
  if (field in TEMPTING) return TEMPTING[field];
  if (field === 'id' || field.endsWith('_id')) return randomUUID();
  return field.endsWith('_at') ? START : 'forged';
};

const propertiesOf = (schema: unknown): string[] => {
  const node = resolveRef(schema);
  return [...Object.keys(node['properties'] ?? {}), ...((node['allOf'] ?? []) as unknown[]).flatMap(propertiesOf)];
};
const withBody = specOperations.filter((operation) => operation.hasRequestBody);
const operationsOf = (names: Readonly<Record<string, unknown>>) =>
  withBody.filter((operation) => operation.operationId in names);
/** The resource's fields the request does not accept, and the owner, which no resource shows. */
const serverFieldsOf = (operation: SpecOperation) => {
  const accepted = new Set(propertiesOf(operation.requestBodySchema));
  const resource = propertiesOf({ $ref: `#/components/schemas/${RESOURCES[operation.operationId] ?? ''}` });
  return [...resource, 'user_id'].filter((field) => !accepted.has(field));
};

interface Target {
  readonly user: GoalUser;
  readonly url: string;
  readonly version?: number;
  readonly body: Record<string, unknown>;
}

/**
 * Mass assignment (R-AUTHZ-04, T-02, E-04, T-17): request schemas are closed, so no client sets what the server owns
 * — owner, XP, rank, score, attempt, a gamble's stake or outcome, completion, timestamps, versions. Generated from the
 * contract: every field of the written resource that its request does not accept → 400 and nothing changes; then the
 * same request without it succeeds, so only that field was refused.
 */
describe('mass assignment [R-AUTHZ-04, T-02, E-04, T-17]', () => {
  let ctx: AccountsApp;
  let user: GoalUser;
  let newcomer: GoalUser;
  let achievementId: string;
  let questId: string;
  let userTables: readonly string[];

  const get = async (url: string) =>
    (await contractInject(ctx.app, { method: 'GET', url, headers: bearer(user.token) })).json<{ version: number }>();
  const targetOf = async (operationId: string): Promise<Target> => {
    switch (operationId) {
      case 'updateMe':
        return { user, url: '/v1/me', version: (await get('/v1/me')).version, body: { nickname: 'Ada' } };
      case 'grantConsent':
        return { user: newcomer, url: '/v1/me/consents', body: { type: 'goal_content', version: '2026-10-01' } };
      case 'createAchievement':
        return { user, url: '/v1/achievements', body: { title: 'Goal' } };
      case 'updateAchievement': {
        const url = `/v1/achievements/${achievementId}`;
        return { user, url, version: (await get(url)).version, body: { title: 'Renamed' } };
      }
      case 'createQuest':
        return {
          user,
          url: `/v1/achievements/${achievementId}/quests`,
          body: { title: 'Quest', type: 'one_time', size: 'M' },
        };
      case 'placeGamble':
        return { user, url: `/v1/achievements/${achievementId}/gambles`, body: {} };
      case 'updateQuest': {
        const url = `/v1/quests/${questId}`;
        return { user, url, version: (await get(url)).version, body: { title: 'Renamed' } };
      }
      case 'createCheckIn':
        return { user, url: `/v1/quests/${questId}/check-ins`, body: { local_date: TODAY } };
      default:
        throw new Error(`no target for ${operationId}`);
    }
  };
  const send = (operation: SpecOperation, target: Target, body: Record<string, unknown>) =>
    contractInject(ctx.app, {
      method: operation.method as 'POST',
      url: target.url,
      headers: {
        ...(operation.requiresAuth ? bearer(target.user.token) : {}),
        'content-type': 'application/json',
        ...(operation.parameters.includes(IF_MATCH) ? { 'if-match': `"${String(target.version ?? 1)}"` } : {}),
        ...(operation.parameters.includes(IDEMPOTENCY_KEY) ? { 'idempotency-key': randomUUID() } : {}),
      },
      payload: JSON.stringify(body),
    });
  /** Every row of every table with a `user_id`, how many rows each table holds, and how many accounts exist. */
  const snapshot = async (of: GoalUser) => {
    const [accounts] = await ctx.admin.sql<{ count: number }[]>`select count(*)::int as count from users`;
    const rows: Record<string, unknown> = { users: accounts?.count };
    for (const table of userTables) {
      const found = await ctx.admin.sql`select * from ${ctx.admin.sql(table)} where user_id = ${of.userId}`;
      const [total] = await ctx.admin.sql<
        { count: number }[]
      >`select count(*)::int as count from ${ctx.admin.sql(table)}`;
      rows[table] = { mine: found.map((row) => JSON.stringify(row)).sort(), total: total?.count };
    }
    return rows;
  };
  const expectRefused = (response: { statusCode: number; json: () => unknown }, label: string) => {
    expect(response.statusCode, label).toBe(400);
    expect(response.json(), label).toMatchObject({ type: 'urn:questline:problem:validation' });
  };

  beforeAll(async () => {
    ctx = await startAccountsApp();
    ctx.clock.set(START);
    user = await goalUser(ctx);
    newcomer = await goalUser(ctx, { consent: false });
    achievementId = (await createAchievement(ctx, user.token, { title: 'Goal', target_date: '2026-11-30' })).json<{
      id: string;
    }>().id;
    const quest = await ctx.post(
      `/v1/achievements/${achievementId}/quests`,
      { title: 'Quest', type: 'one_time', size: 'M' },
      { ...bearer(user.token), 'idempotency-key': randomUUID() },
    );
    questId = quest.json<{ id: string }>().id;
    // XP above the level's threshold, so that the gamble placed without forged fields has something to stake.
    await ctx.admin.sql`
      insert into xp_events (id, user_id, kind, amount, local_date, created_at)
      values (${randomUUID()}, ${user.userId}, 'quest_completed', 250, ${TODAY}, ${ctx.clock.now()})`;
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

  it('finds every request body closed and every operation with one classified', () => {
    expect(withBody.filter((operation) => operation.requestBodySchema?.['additionalProperties'] !== false)).toEqual([]);
    expect(withBody.map((operation) => operation.operationId).sort()).toEqual(
      [...Object.keys(RESOURCES), ...Object.keys(FLOWS)].sort(),
    );
    expect(operationsOf(RESOURCES).every((operation) => serverFieldsOf(operation).length >= 2)).toBe(true);
  });

  it.each(operationsOf(RESOURCES).map((operation) => [operation.operationId, operation] as const))(
    '%s refuses every field of the resource that its request does not accept, then succeeds without it',
    async (operationId, operation) => {
      const target = await targetOf(operationId);
      const before = await snapshot(target.user);
      const cases = [
        ...serverFieldsOf(operation).map((field) => ({ [field]: forged(field) })),
        ...SERVER_VALUES.filter(([id]) => id === operationId).map(([, fields]) => fields),
      ];

      for (const fields of cases) {
        expectRefused(await send(operation, target, { ...target.body, ...fields }), JSON.stringify(fields));
      }
      expect(await snapshot(target.user)).toEqual(before);

      const accepted = await send(operation, target, target.body);
      expect(accepted.statusCode).toBeGreaterThanOrEqual(200);
      expect(accepted.statusCode).toBeLessThan(300);
    },
  );

  it.each(operationsOf(FLOWS).map((operation) => [operation.operationId, operation] as const))(
    '%s refuses an owner or a role in its body and changes nothing',
    async (operationId, operation) => {
      const target = { user, url: operation.path, body: FLOWS[operationId] ?? {} };
      const before = await snapshot(user);

      for (const fields of [{ user_id: user.userId }, { role: 'admin' }]) {
        expectRefused(await send(operation, target, { ...target.body, ...fields }), JSON.stringify(fields));
      }
      expect(await snapshot(user)).toEqual(before);
    },
  );
});
