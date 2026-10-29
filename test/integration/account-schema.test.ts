import { randomBytes, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, withUserContext, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';

const CHECK_VIOLATION = { code: '23514' };
const UNIQUE_VIOLATION = { code: '23505' };
const FOREIGN_KEY_VIOLATION = { code: '23503' };
const INSUFFICIENT_PRIVILEGE = { code: '42501' };
const INVALID_TEXT = { code: '22P02' };

const T0 = new Date('2026-10-29T12:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const DAY = 24 * 60;

type Row = Record<string, string | number | boolean | Date | Buffer | null>;

const rows = {
  user: (id: string, overrides: Row = {}): Row => ({
    id,
    email_enc: randomBytes(64),
    email_blind_index: randomBytes(32),
    password_hash: 'placeholder-hash',
    timezone: 'Europe/Zurich',
    locale: 'de-CH',
    age_confirmed: true,
    privacy_policy_version: '2026-10',
    password_changed_at: T0,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  }),
  oneTimeToken: (userId: string, overrides: Row = {}): Row => ({
    id: randomUUID(),
    user_id: userId,
    purpose: 'verify_email',
    token_hash: randomBytes(32),
    expires_at: at(30),
    created_at: T0,
    ...overrides,
  }),
  session: (id: string, userId: string, overrides: Row = {}): Row => ({
    id,
    user_id: userId,
    client: 'ios',
    created_at: T0,
    last_used_at: T0,
    last_reauth_at: T0,
    absolute_expires_at: at(180 * DAY),
    ...overrides,
  }),
  sessionToken: (sessionId: string, userId: string, overrides: Row = {}): Row => ({
    id: randomUUID(),
    session_id: sessionId,
    user_id: userId,
    generation: 1,
    access_token_hash: randomBytes(32),
    access_expires_at: at(15),
    refresh_token_hash: randomBytes(32),
    refresh_expires_at: at(30 * DAY),
    created_at: T0,
    ...overrides,
  }),
  consent: (userId: string, overrides: Row = {}): Row => ({
    id: randomUUID(),
    user_id: userId,
    type: 'goal_content',
    version: '2026-10',
    granted_at: T0,
    ...overrides,
  }),
  auditEvent: (userId: string | null, overrides: Row = {}): Row => ({
    id: randomUUID(),
    user_id: userId,
    event_type: 'login_failed',
    ip_prefix: '203.0.113.0/24',
    client: 'ios',
    outcome: 'failure',
    created_at: T0,
    ...overrides,
  }),
  outbox: (userId: string, overrides: Row = {}): Row => ({
    id: randomUUID(),
    user_id: userId,
    template: 'verify_email',
    payload_enc: randomBytes(96),
    next_attempt_at: T0,
    created_at: T0,
    ...overrides,
  }),
};

const insert = (tx: TransactionSql, table: string, row: Row) => tx`insert into ${tx(table)} ${tx(row)}`;

/** Constraints that hold even if application code is wrong (docs/data-model.md §3, defence in depth). */
describe('account tables', () => {
  let database: TestDatabase;
  let app: DatabaseClient;
  let worker: DatabaseClient;

  /** Creates a user with a row in every account table, written by the API role as in production. */
  async function seedAccount(): Promise<{ userId: string; sessionId: string }> {
    const userId = randomUUID();
    const sessionId = randomUUID();
    await withUserContext(app, userId, async (tx) => {
      await insert(tx, 'users', rows.user(userId));
      await insert(tx, 'user_keys', {
        user_id: userId,
        wrapped_dek: randomBytes(73),
        kek_id: 'local',
        kek_version: 1,
        created_at: T0,
      });
      await insert(tx, 'one_time_tokens', rows.oneTimeToken(userId));
      await insert(tx, 'sessions', rows.session(sessionId, userId));
      await insert(tx, 'session_tokens', rows.sessionToken(sessionId, userId));
      await insert(tx, 'consents', rows.consent(userId));
      await insert(tx, 'audit_events', rows.auditEvent(userId, { event_type: 'login_succeeded', outcome: 'success' }));
      await insert(tx, 'email_outbox', rows.outbox(userId));
    });
    return { userId, sessionId };
  }

  const appInsert = (userId: string, table: string, row: Row) =>
    withUserContext(app, userId, (tx) => insert(tx, table, row));

  beforeAll(async () => {
    database = await createTestDatabase();
    app = createDatabaseClient({ url: database.urls.app, applicationName: 'questline-test' });
    worker = createDatabaseClient({ url: database.urls.worker, applicationName: 'questline-test' });
  });

  afterAll(async () => {
    await Promise.all([app.close(), worker.close()]);
    await database.drop();
  });

  it('removes every row of an account with its user row, and nothing of other accounts [R-PRIV-06]', async () => {
    const { userId } = await seedAccount();
    const other = await seedAccount();
    await app.sql.begin((tx) => insert(tx, 'audit_events', rows.auditEvent(null)));

    await worker.sql`delete from users where id = ${userId}`;

    const count = async (id: string) => {
      const [workerView] = await worker.sql<Record<string, string>[]>`
        select (select count(*) from users where id = ${id}) as users,
               (select count(*) from user_keys where user_id = ${id}) as user_keys,
               (select count(*) from one_time_tokens where user_id = ${id}) as one_time_tokens,
               (select count(*) from sessions where user_id = ${id}) as sessions,
               (select count(*) from session_tokens where user_id = ${id}) as session_tokens,
               (select count(*) from audit_events where user_id = ${id}) as audit_events,
               (select count(*) from email_outbox where user_id = ${id}) as email_outbox`;
      const [consents] = await withUserContext(app, id, (tx) => tx<{ count: string }[]>`select count(*) from consents`);
      return { ...workerView, consents: consents?.count };
    };
    const zeroes = {
      users: '0',
      user_keys: '0',
      one_time_tokens: '0',
      sessions: '0',
      session_tokens: '0',
      audit_events: '0',
      email_outbox: '0',
      consents: '0',
    };
    expect(await count(userId)).toEqual(zeroes);
    expect(Object.values(await count(other.userId)).every((value) => value === '1')).toBe(true);
    const [anonymous] = await worker.sql<{ count: string }[]>`
      select count(*) from audit_events where user_id is null`;
    expect(anonymous?.count).toBe('1');
  });

  it('refuses an account without the age confirmation [R-AUTH-11]', async () => {
    const userId = randomUUID();

    await expect(appInsert(userId, 'users', rows.user(userId, { age_confirmed: false }))).rejects.toMatchObject(
      CHECK_VIOLATION,
    );
  });

  it('refuses one-time tokens that live longer than 30 minutes or mix up their purpose [R-AUTH-03]', async () => {
    const { userId } = await seedAccount();
    const newEmail = { new_email_enc: randomBytes(64), new_email_blind_index: randomBytes(32) };

    for (const token of [
      rows.oneTimeToken(userId, { expires_at: at(31) }),
      rows.oneTimeToken(userId, { expires_at: T0 }),
      rows.oneTimeToken(userId, { purpose: 'change_email' }),
      rows.oneTimeToken(userId, { purpose: 'verify_email', ...newEmail }),
      rows.oneTimeToken(userId, { token_hash: randomBytes(31) }),
    ]) {
      await expect(appInsert(userId, 'one_time_tokens', token)).rejects.toMatchObject(CHECK_VIOLATION);
    }
    await expect(
      appInsert(userId, 'one_time_tokens', rows.oneTimeToken(userId, { purpose: 'change_email', ...newEmail })),
    ).resolves.toBeDefined();
  });

  it('refuses access tokens over 15 minutes, refresh tokens over 30 days and sessions over 180 days [R-AUTH-10]', async () => {
    const { userId, sessionId } = await seedAccount();

    await expect(
      appInsert(userId, 'sessions', rows.session(randomUUID(), userId, { absolute_expires_at: at(180 * DAY + 1) })),
    ).rejects.toMatchObject(CHECK_VIOLATION);
    for (const token of [
      rows.sessionToken(sessionId, userId, { generation: 2, access_expires_at: at(16) }),
      rows.sessionToken(sessionId, userId, { generation: 2, refresh_expires_at: at(30 * DAY + 1) }),
      rows.sessionToken(sessionId, userId, { generation: 0 }),
    ]) {
      await expect(appInsert(userId, 'session_tokens', token)).rejects.toMatchObject(CHECK_VIOLATION);
    }
  });

  it('records why a session was revoked, and only for revoked sessions', async () => {
    const { userId } = await seedAccount();

    for (const session of [
      rows.session(randomUUID(), userId, { revoked_at: T0 }),
      rows.session(randomUUID(), userId, { revoked_reason: 'logout' }),
      rows.session(randomUUID(), userId, { revoked_at: T0, revoked_reason: 'bored' }),
      rows.session(randomUUID(), userId, { client: 'web' }),
    ]) {
      await expect(appInsert(userId, 'sessions', session)).rejects.toMatchObject(CHECK_VIOLATION);
    }
  });

  it("refuses a session token that names another user than its session's [S-09]", async () => {
    const owner = await seedAccount();
    const intruder = await seedAccount();

    await expect(
      appInsert(
        intruder.userId,
        'session_tokens',
        rows.sessionToken(owner.sessionId, intruder.userId, { generation: 2 }),
      ),
    ).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
  });

  it('keeps at most one active consent per type, and allows a new one after withdrawal [R-PRIV-04]', async () => {
    const { userId } = await seedAccount();

    await expect(appInsert(userId, 'consents', rows.consent(userId))).rejects.toMatchObject(UNIQUE_VIOLATION);
    await withUserContext(app, userId, (tx) => tx`update consents set withdrawn_at = ${at(1)}`);
    await expect(appInsert(userId, 'consents', rows.consent(userId, { granted_at: at(2) }))).resolves.toBeDefined();
    await expect(
      appInsert(userId, 'consents', rows.consent(userId, { granted_at: at(3), withdrawn_at: at(2) })),
    ).rejects.toMatchObject(CHECK_VIOLATION);
  });

  it.each([
    ['203.0.113.0/24', 'ok'],
    ['2001:db8:1234::/48', 'ok'],
    ['203.0.113.7/32', 'check'],
    ['203.0.113.7', 'check'],
    ['2001:db8::1', 'check'],
    ['203.0.113.7/24', 'invalid'],
  ] as const)('stores the audit IP prefix %s only if truncated to /24 or /48 [C8]', async (prefix, outcome) => {
    const attempt = app.sql.begin((tx) => insert(tx, 'audit_events', rows.auditEvent(null, { ip_prefix: prefix })));

    if (outcome === 'ok') await expect(attempt).resolves.toBeDefined();
    else await expect(attempt).rejects.toMatchObject(outcome === 'check' ? CHECK_VIOLATION : INVALID_TEXT);
  });

  it('lets the API record audit events for unknown accounts, but never read them or write them for another user', async () => {
    const { userId } = await seedAccount();
    const other = await seedAccount();

    await expect(app.sql.begin((tx) => insert(tx, 'audit_events', rows.auditEvent(null)))).resolves.toBeDefined();
    await expect(appInsert(userId, 'audit_events', rows.auditEvent(other.userId))).rejects.toMatchObject(
      INSUFFICIENT_PRIVILEGE,
    );
    await expect(withUserContext(app, userId, (tx) => tx`select count(*) from audit_events`)).rejects.toMatchObject(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('stores delivery errors as codes only, never as free text that could hold an address', async () => {
    const { userId } = await seedAccount();

    await expect(
      appInsert(userId, 'email_outbox', rows.outbox(userId, { last_error_code: 'Mailbox alice@example.test is full' })),
    ).rejects.toMatchObject(CHECK_VIOLATION);
    await expect(
      appInsert(userId, 'email_outbox', rows.outbox(userId, { last_error_code: 'smtp_552' })),
    ).resolves.toBeDefined();
  });

  it('keeps rate-limit buckets keyed by 32-byte hashes only [Q-14]', async () => {
    const bucket = { tokens: 5, updated_at: T0 };

    await expect(
      app.sql.begin((tx) => insert(tx, 'rate_limit_buckets', { bucket_key: Buffer.from('203.0.113.7'), ...bucket })),
    ).rejects.toMatchObject(CHECK_VIOLATION);
    await expect(
      app.sql.begin((tx) => insert(tx, 'rate_limit_buckets', { bucket_key: randomBytes(32), ...bucket })),
    ).resolves.toBeDefined();
  });

  it('does not write rate-limit buckets to the write-ahead log (lost on a crash, by design)', async () => {
    const [row] = await worker.sql<{ persistence: string }[]>`
      select relpersistence as persistence from pg_class where relname = 'rate_limit_buckets'`;

    expect(row?.persistence).toBe('u');
  });
});
