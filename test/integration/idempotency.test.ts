import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAccountKey } from '../../src/modules/accounts/account-mail.ts';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createDatabase, inTransaction, setUserContext, type Database } from '../../src/platform/db/database.ts';
import { achievements } from '../../src/platform/db/schema/index.ts';
import { Problems } from '../../src/platform/http/problem.ts';
import {
  idempotentRequest,
  type IdempotentOutcome,
  type IdempotentRoute,
  type StoredResponse,
} from '../../src/platform/http/idempotency.ts';
import { ProblemError } from '../../src/platform/http/validation.ts';
import { saveIdempotencyRecord } from '../../src/platform/idempotency/idempotency-repository.ts';
import { IDEMPOTENCY_KEY_LIFETIME_MS, runIdempotent } from '../../src/platform/idempotency/idempotent.ts';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';

interface Attempt {
  readonly userId: string;
  readonly key: string;
  readonly title?: string;
  readonly route?: IdempotentRoute;
  /** Fails inside the transaction after the work's effect, like a refused business rule. */
  readonly fail?: boolean;
}

/** Idempotent create requests (ADR-0008, Q-39): the key, the effect and the stored response commit together. */
describe('idempotency keys against PostgreSQL', () => {
  let ctx: AccountsApp;
  let client: DatabaseClient;
  let db: Database;

  /** One create request: its effect is a new achievement; its response names it. */
  function create(attempt: Attempt): Promise<IdempotentOutcome> {
    const title = attempt.title ?? 'Run a marathon';
    const request = idempotentRequest(attempt.route ?? 'createAchievement', attempt.key, {}, { title });
    const now = ctx.clock.now();
    return inTransaction(db, (tx) =>
      withAccountKey(tx, ctx.dataKeys, attempt.userId, (dataKey) =>
        runIdempotent(tx, dataKey, attempt.userId, request, now, async (): Promise<StoredResponse> => {
          const id = randomUUID();
          await tx.insert(achievements).values({
            id,
            userId: attempt.userId,
            titleEnc: randomBytes(48),
            status: 'active',
            dekVersion: 1,
            createdAt: now,
            updatedAt: now,
          });
          if (attempt.fail === true) throw new ProblemError(Problems.notFound);
          return { status: 201, headers: { etag: '"1"', location: `/v1/achievements/${id}` }, body: { id, title } };
        }),
      ),
    );
  }

  const effects = async (userId: string) =>
    (
      await ctx.admin.sql<{ count: number }[]>`
      select count(*)::int as count from achievements where user_id = ${userId}`
    )[0]?.count;
  const records = (userId: string) =>
    ctx.admin.sql<{ id: string; route: string; response_status: number; response_body_enc: Buffer }[]>`
      select id, route, response_status, response_body_enc from idempotency_keys where user_id = ${userId}`;
  const responseOf = (outcome: IdempotentOutcome) => (outcome.outcome === 'key_reused' ? null : outcome.response);

  beforeAll(async () => {
    ctx = await startAccountsApp();
    client = createDatabaseClient({
      url: ctx.database.urls.app,
      applicationName: 'questline-test',
      maxConnections: 12,
    });
    db = createDatabase(client);
  });

  afterAll(async () => {
    await client.close();
    await ctx.close();
  });

  it("runs a first request once and stores its response encrypted with the user's key [I-13]", async () => {
    const { userId } = await ctx.account();

    const outcome = await create({ userId, key: randomUUID(), title: 'Swim across the lake' });

    expect(outcome.outcome).toBe('executed');
    const [record] = await records(userId);
    expect(record?.response_status).toBe(201);
    expect(record?.response_body_enc.toString('latin1')).not.toContain('Swim across the lake');
    const stored = JSON.parse(
      await ctx.decrypt(userId, record?.id ?? '', 'response_body_enc', record?.response_body_enc ?? Buffer.alloc(0)),
    ) as unknown;
    expect(stored).toEqual({ headers: responseOf(outcome)?.headers, body: responseOf(outcome)?.body });
  });

  it('replays the stored response for the same key and request without running it again', async () => {
    const { userId } = await ctx.account();
    const key = randomUUID();

    const first = await create({ userId, key });
    const second = await create({ userId, key });

    expect(second).toEqual({ outcome: 'replayed', response: responseOf(first) });
    expect(await effects(userId)).toBe(1);
  });

  it('refuses the same key for another request and runs nothing [T-13]', async () => {
    const { userId } = await ctx.account();
    const key = randomUUID();
    await create({ userId, key, title: 'Run a marathon' });

    expect(await create({ userId, key, title: 'Run two marathons' })).toEqual({ outcome: 'key_reused' });
    expect(await effects(userId)).toBe(1);
  });

  it('keeps keys apart per user and per route [I-13]', async () => {
    const alice = await ctx.account();
    const bob = await ctx.account();
    const key = randomUUID();
    await create({ userId: alice.userId, key });

    expect((await create({ userId: bob.userId, key })).outcome).toBe('executed');
    expect((await create({ userId: alice.userId, key, route: 'placeGamble' })).outcome).toBe('executed');
    expect([await effects(alice.userId), await effects(bob.userId)]).toEqual([2, 1]);
  });

  it('stores nothing for a request that failed, so a retry with the same key runs again (Q-39)', async () => {
    const { userId } = await ctx.account();
    const key = randomUUID();

    await expect(create({ userId, key, fail: true })).rejects.toBeInstanceOf(ProblemError);
    expect([await effects(userId), (await records(userId)).length]).toEqual([0, 0]);

    expect((await create({ userId, key })).outcome).toBe('executed');
    expect(await effects(userId)).toBe(1);
  });

  it('replays for 24 hours, then runs the request again and replaces the record', async () => {
    const { userId } = await ctx.account();
    const key = randomUUID();
    await create({ userId, key });

    ctx.clock.advance({ milliseconds: IDEMPOTENCY_KEY_LIFETIME_MS - 1 });
    expect((await create({ userId, key })).outcome).toBe('replayed');
    ctx.clock.advance({ milliseconds: 1 });
    expect((await create({ userId, key })).outcome).toBe('executed');

    expect([await effects(userId), (await records(userId)).length]).toEqual([2, 1]);
  });

  it('runs ten simultaneous requests with one key exactly once and replays its response to the others [T-06]', async () => {
    const { userId } = await ctx.account();
    const key = randomUUID();

    const outcomes = await Promise.all(Array.from({ length: 10 }, () => create({ userId, key })));

    const executed = outcomes.filter((outcome) => outcome.outcome === 'executed');
    expect(executed).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.outcome === 'replayed')).toHaveLength(9);
    expect(new Set(outcomes.map((outcome) => JSON.stringify(responseOf(outcome)))).size).toBe(1);
    expect(await effects(userId)).toBe(1);
  });

  it('runs only one of two simultaneous requests that share a key but differ, refusing the other', async () => {
    const { userId } = await ctx.account();
    const key = randomUUID();

    const outcomes = await Promise.all([
      create({ userId, key, title: 'Run a marathon' }),
      create({ userId, key, title: 'Run two marathons' }),
    ]);

    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(['executed', 'key_reused']);
    expect(await effects(userId)).toBe(1);
  });

  it('never overwrites a live record, even when a caller skips the lock', async () => {
    const { userId } = await ctx.account();
    const key = randomUUID();
    await create({ userId, key });
    const now = ctx.clock.now();

    const overwrite = inTransaction(db, async (tx) => {
      await setUserContext(tx, userId);
      await saveIdempotencyRecord(tx, {
        id: randomUUID(),
        userId,
        route: 'createAchievement',
        key,
        requestHash: randomBytes(32),
        responseStatus: 201,
        responseBodyEnc: randomBytes(64),
        createdAt: now,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_KEY_LIFETIME_MS),
      });
    });

    await expect(overwrite).rejects.toThrow('a live idempotency record exists');
    expect(await create({ userId, key })).toMatchObject({ outcome: 'replayed' });
  });
});
