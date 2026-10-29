import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, inTransaction } from '../../src/platform/db/database.ts';
import { createOutboxDelivery, OUTBOX_DELIVERY, type OutboxLimits } from '../../src/platform/email/delivery.ts';
import { claimNextEmail, enqueueEmail, recordFailedAttempt } from '../../src/platform/email/outbox-repository.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { startAccountsApp, TEST_PASSWORD, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { FakeEmailSender, MAILBOX_BUSY, NO_SUCH_MAILBOX, RELAY_DOWN, tokenIn } from '../helpers/fake-email-sender.ts';
import { LogCapture } from '../helpers/log-capture.ts';

const LINK_BASE = 'https://app.questline.test';
const MINUTE_MS = 60_000;
const NOTHING = { sent: 0, retried: 0, dead: 0, outdated: 0, paused: false };

/** Times in epoch milliseconds: Drizzle replaces the shared client's timestamp parsers. */
interface OutboxRow {
  readonly template: string;
  readonly attempts: number;
  readonly next_attempt_ms: number;
  readonly last_error_code: string | null;
  readonly dead_ms: number | null;
}

/** The worker side of the outbox (ADR-0009, ADR-0014): delivery, retries, dead letters, dedupe (D-05, D-07). */
describe('outbox delivery', () => {
  let ctx: AccountsApp;
  let sender: FakeEmailSender;
  let logs: LogCapture;

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    sender = new FakeEmailSender();
    logs = new LogCapture();
    await ctx.admin.sql`delete from email_outbox`;
  });

  const delivery = (limits: Partial<OutboxLimits> = {}) =>
    createOutboxDelivery(
      {
        db: createDatabase(ctx.worker),
        dataKeys: ctx.dataKeys,
        sender,
        clock: ctx.clock,
        linkBaseUrl: LINK_BASE,
        logger: createLogger({ service: 'questline-worker', level: 'info' }, logs.stream),
      },
      { ...OUTBOX_DELIVERY, ...limits },
    );
  const outbox = () =>
    ctx.worker.sql<OutboxRow[]>`
      select template, attempts, extract(epoch from next_attempt_at)::float8 * 1000 as next_attempt_ms,
        last_error_code, extract(epoch from dead_at)::float8 * 1000 as dead_ms
      from email_outbox order by created_at, xmin::text::bigint`;
  const address = () => `outbox-${randomUUID().slice(0, 8)}@example.test`;
  const register = async (email: string, extra: Record<string, unknown> = {}) => {
    const response = await ctx.post('/v1/auth/register', {
      email,
      password: TEST_PASSWORD,
      privacy_policy_version: '2026-10-01',
      age_confirmed: true,
      ...extra,
    });
    expect(response.statusCode).toBe(202);
  };
  /** Queues one `registration_notice` (an address registered twice): notices carry no link that could expire. */
  const queueNotice = async () => {
    const email = address();
    await register(email);
    await ctx.admin.sql`delete from email_outbox`;
    await register(email);
  };

  it('sends a queued verification email whose link verifies the address, then deletes it', async () => {
    const email = address();
    await register(email);

    expect(await delivery().deliverDue()).toEqual({ ...NOTHING, sent: 1 });

    expect(sender.sent).toHaveLength(1);
    const [message] = sender.sent;
    expect(message?.to).toBe(email);
    expect(message?.subject).toBe('Bestätigen Sie Ihre E-Mail-Adresse');
    expect(message?.text).toContain(`\n\n${LINK_BASE}/verify-email#token=ql_vt_`);
    expect(await outbox()).toEqual([]);
    expect((await ctx.post('/v1/auth/verify-email', { token: tokenIn(message) })).statusCode).toBe(204);
  });

  it('writes the email in the language chosen at registration', async () => {
    await register(address(), { locale: 'fr-CH' });

    await delivery().deliverDue();

    expect(sender.sent.map((message) => message.subject)).toEqual(['Confirmez votre adresse e-mail']);
  });

  it('retries a transient refusal with exponential backoff and dead-letters it after the 8th attempt [D-07]', async () => {
    await queueNotice();
    sender.failAlways(MAILBOX_BUSY);
    const run = delivery();
    const delays: number[] = [];

    for (let attempt = 1; attempt < OUTBOX_DELIVERY.maxAttempts; attempt += 1) {
      expect(await run.deliverDue()).toEqual({ ...NOTHING, retried: 1 });
      const [row] = await outbox();
      expect(row).toMatchObject({ attempts: attempt, last_error_code: 'smtp_eenvelope_450', dead_ms: null });
      const due = new Date(row?.next_attempt_ms ?? 0);
      delays.push(due.getTime() - ctx.clock.now().getTime());
      expect(await run.deliverDue()).toEqual(NOTHING);
      ctx.clock.set(due.toISOString());
    }

    expect(delays).toEqual([1, 2, 4, 8, 16, 32, 64].map((minutes) => minutes * MINUTE_MS));
    expect(await run.deliverDue()).toEqual({ ...NOTHING, dead: 1 });
    expect(await outbox()).toEqual([
      expect.objectContaining({
        attempts: 8,
        last_error_code: 'smtp_eenvelope_450',
        dead_ms: ctx.clock.now().getTime(),
      }),
    ]);
    ctx.clock.advance({ days: 1 });
    expect(await run.deliverDue()).toEqual(NOTHING);
    expect(sender.attempts).toBe(8);
  });

  it('dead-letters a permanently refused email at the first attempt', async () => {
    await queueNotice();
    sender.failNext(NO_SUCH_MAILBOX);

    expect(await delivery().deliverDue()).toEqual({ ...NOTHING, dead: 1 });

    expect(await outbox()).toEqual([
      expect.objectContaining({
        attempts: 1,
        last_error_code: 'smtp_eenvelope_550',
        dead_ms: ctx.clock.now().getTime(),
      }),
    ]);
  });

  it('pauses all delivery for a minute when the relay fails, then sends everything due', async () => {
    await register(address());
    await register(address());
    sender.failNext(RELAY_DOWN);
    const run = delivery();

    expect(await run.deliverDue()).toEqual({ ...NOTHING, retried: 1, paused: true });
    expect(sender.attempts).toBe(1);
    ctx.clock.advance({ seconds: 59 });
    expect(await run.deliverDue()).toEqual({ ...NOTHING, paused: true });
    expect(sender.attempts).toBe(1);
    ctx.clock.advance({ seconds: 1 });
    expect(await run.deliverDue()).toEqual({ ...NOTHING, sent: 2 });
    expect(logs.records()).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'email delivery paused: the relay failed', pause_ms: 60_000 }),
    );
  });

  it('treats an unexpected sender error as a relay failure, so the email is retried and not lost', async () => {
    await queueNotice();
    sender.failNext(new Error('socket hang up'));

    expect(await delivery().deliverDue()).toEqual({ ...NOTHING, retried: 1, paused: true });

    expect(await outbox()).toEqual([expect.objectContaining({ attempts: 1, last_error_code: 'send_failed' })]);
  });

  it('dead-letters an email whose last attempt failed at the relay, and still pauses', async () => {
    await queueNotice();
    sender.failAlways(RELAY_DOWN);
    const run = delivery({ maxAttempts: 2 });

    expect(await run.deliverDue()).toEqual({ ...NOTHING, retried: 1, paused: true });
    ctx.clock.advance({ minutes: 1 });
    expect(await run.deliverDue()).toEqual({ ...NOTHING, dead: 1, paused: true });

    expect(await outbox()).toEqual([expect.objectContaining({ attempts: 2, last_error_code: 'smtp_econnection' })]);
  });

  it('sends a link email only while its link works: replaced, used and expired links are dropped [D-05]', async () => {
    const expired = address();
    await register(expired);
    ctx.clock.advance({ minutes: 31 });
    const replaced = address();
    await register(replaced);
    await ctx.post('/v1/auth/resend-verification', { email: replaced });
    await ctx.post('/v1/auth/resend-verification', { email: replaced });
    await ctx.account();
    await register(address());

    expect(await delivery().deliverDue()).toEqual({ ...NOTHING, sent: 2, outdated: 4 });

    expect(sender.sent.map((message) => message.to)).not.toContain(expired);
    const [toReplaced] = sender.sent.filter((message) => message.to === replaced);
    expect((await ctx.post('/v1/auth/verify-email', { token: tokenIn(toReplaced) })).statusCode).toBe(204);
    expect(await outbox()).toEqual([]);
  });

  it('always sends security notices, even several of the same kind [D-05]', async () => {
    const email = address();
    await register(email);
    await ctx.admin.sql`delete from email_outbox`;
    await register(email);
    await register(email);

    expect(await delivery().deliverDue()).toEqual({ ...NOTHING, sent: 2 });

    expect(sender.sent.map((message) => message.subject)).toEqual([
      'Jemand wollte Ihre E-Mail-Adresse verwenden',
      'Jemand wollte Ihre E-Mail-Adresse verwenden',
    ]);
  });

  it('stops a round after the configured number of emails and sends the rest in the next round', async () => {
    for (let index = 0; index < 3; index += 1) await register(address());
    const run = delivery({ maxPerRound: 2 });

    expect(await run.deliverDue()).toEqual({ ...NOTHING, sent: 2 });
    expect(await run.deliverDue()).toEqual({ ...NOTHING, sent: 1 });
  });

  it('delivers every email exactly once when two workers drain the outbox at the same time', async () => {
    const recipients = [address(), address(), address(), address(), address(), address()];
    for (const email of recipients) await register(email);

    const rounds = await Promise.all([delivery().deliverDue(), delivery().deliverDue()]);

    expect(rounds.reduce((total, round) => total + round.sent, 0)).toBe(6);
    expect(sender.sent.map((message) => message.to).sort()).toEqual([...recipients].sort());
  });

  it('retries an email whose delivery was interrupted once its lease has run out', async () => {
    await register(address());
    const db = createDatabase(ctx.worker);
    const now = ctx.clock.now();
    const crashed = await inTransaction(db, (tx) =>
      claimNextEmail(tx, now, new Date(now.getTime() + OUTBOX_DELIVERY.leaseMs)),
    );
    expect(crashed).toMatchObject({ template: 'verify_email', attempts: 1 });
    const run = delivery();

    expect(await run.deliverDue()).toEqual(NOTHING);
    ctx.clock.advance({ milliseconds: OUTBOX_DELIVERY.leaseMs - 1 });
    expect(await run.deliverDue()).toEqual(NOTHING);
    ctx.clock.advance({ milliseconds: 1 });
    expect(await run.deliverDue()).toEqual({ ...NOTHING, sent: 1 });
  });

  it('ignores the late result of an attempt whose lease ran out after another worker claimed the email', async () => {
    await queueNotice();
    const db = createDatabase(ctx.worker);
    const claim = () => {
      const now = ctx.clock.now();
      return inTransaction(db, (tx) => claimNextEmail(tx, now, new Date(now.getTime() + OUTBOX_DELIVERY.leaseMs)));
    };
    const first = await claim();
    ctx.clock.advance({ milliseconds: OUTBOX_DELIVERY.leaseMs });
    const second = await claim();
    expect([first?.attempts, second?.attempts]).toEqual([1, 2]);

    await recordFailedAttempt(db, { id: first?.id ?? '', attempts: 1 }, 'smtp_econnection', ctx.clock.now(), undefined);

    expect(await outbox()).toEqual([
      expect.objectContaining({
        attempts: 2,
        last_error_code: null,
        dead_ms: null,
        next_attempt_ms: ctx.clock.now().getTime() + OUTBOX_DELIVERY.leaseMs,
      }),
    ]);
  });

  it('dead-letters an email that cannot be decrypted, without trying to send it', async () => {
    const account = await ctx.account({ verified: false });
    await ctx.admin.sql`
      update email_outbox set payload_enc = set_byte(payload_enc, 30, get_byte(payload_enc, 30) # 1)
      where user_id = ${account.userId}`;

    expect(await delivery().deliverDue()).toEqual({ ...NOTHING, dead: 1 });

    expect(sender.attempts).toBe(0);
    expect(await outbox()).toEqual([expect.objectContaining({ last_error_code: 'payload_unreadable' })]);
  });

  it('dead-letters an email whose account has lost its data key', async () => {
    const account = await ctx.account({ verified: false });
    await ctx.admin.sql`delete from user_keys where user_id = ${account.userId}`;

    expect(await delivery().deliverDue()).toEqual({ ...NOTHING, dead: 1 });

    expect(await outbox()).toEqual([expect.objectContaining({ last_error_code: 'payload_unreadable' })]);
  });

  it('dead-letters a link email without a usable token and an email without a usable address', async () => {
    const account = await ctx.account({ verified: false });
    await ctx.admin.sql`delete from email_outbox`;
    const [key] = await ctx.worker.sql<{ wrapped_dek: Buffer; kek_id: string; kek_version: number }[]>`
      select wrapped_dek, kek_id, kek_version from user_keys where user_id = ${account.userId}`;
    const wrapped = {
      blob: key?.wrapped_dek ?? Buffer.alloc(0),
      kekId: key?.kek_id ?? '',
      kekVersion: key?.kek_version ?? 0,
    };
    await ctx.dataKeys.withKey(account.userId, wrapped, (dataKey) =>
      inTransaction(createDatabase(ctx.admin), async (tx) => {
        const queue = (template: 'password_reset' | 'password_changed_notice', payload: object) =>
          enqueueEmail(
            tx,
            dataKey,
            { userId: account.userId, template, payload: payload as { to: string; locale: string } },
            ctx.clock.now(),
          );
        await queue('password_reset', { to: account.email, locale: 'en' });
        await queue('password_reset', { to: account.email, locale: 'en', token: 'ql_vt_not-a-reset-token' });
        await queue('password_changed_notice', { to: 'not an address', locale: 'en' });
        await queue('password_changed_notice', { locale: 'en' });
      }),
    );

    expect(await delivery().deliverDue()).toEqual({ ...NOTHING, dead: 4 });

    expect(sender.attempts).toBe(0);
    expect((await outbox()).map((row) => row.last_error_code)).toEqual([
      'payload_invalid',
      'payload_invalid',
      'payload_invalid',
      'payload_invalid',
    ]);
  });

  it('writes notices in the default language when the stored locale is no longer offered', async () => {
    const account = await ctx.account({ verified: false });
    await ctx.admin.sql`delete from email_outbox`;
    const [key] = await ctx.worker.sql<{ wrapped_dek: Buffer; kek_id: string; kek_version: number }[]>`
      select wrapped_dek, kek_id, kek_version from user_keys where user_id = ${account.userId}`;
    const wrapped = {
      blob: key?.wrapped_dek ?? Buffer.alloc(0),
      kekId: key?.kek_id ?? '',
      kekVersion: key?.kek_version ?? 0,
    };
    await ctx.dataKeys.withKey(account.userId, wrapped, (dataKey) =>
      inTransaction(createDatabase(ctx.admin), (tx) =>
        enqueueEmail(
          tx,
          dataKey,
          {
            userId: account.userId,
            template: 'password_changed_notice',
            payload: { to: account.email, locale: 'rm-CH' },
          },
          ctx.clock.now(),
        ),
      ),
    );

    expect(await delivery().deliverDue()).toEqual({ ...NOTHING, sent: 1 });

    expect(sender.sent.map((message) => message.subject)).toEqual(['Ihr Passwort wurde geändert']);
  });

  it('logs each outcome with allowlisted fields only: no address, token or account id [R-LOG-02]', async () => {
    const recipients = [address(), address()];
    for (const email of recipients) await register(email);
    sender.failNext(MAILBOX_BUSY);

    await delivery().deliverDue();

    const token = tokenIn(sender.sent[0]);
    const users = await ctx.worker.sql<{ id: string }[]>`select id from users`;
    expect(logs.records()).toEqual([
      expect.objectContaining({
        level: 'warn',
        msg: 'email delivery failed, will retry',
        template: 'verify_email',
        attempt: 1,
        error_code: 'smtp_eenvelope_450',
      }),
      expect.objectContaining({ level: 'info', msg: 'email sent', template: 'verify_email' }),
    ]);
    const allowed = ['level', 'time', 'service', 'msg', 'template', 'attempt', 'error_code', 'pause_ms'];
    for (const record of logs.records()) expect(allowed).toEqual(expect.arrayContaining(Object.keys(record)));
    for (const secret of [...recipients, token, ...users.map((user) => user.id)]) {
      expect(logs.text).not.toContain(secret);
    }
  });

  it("drops a link email carrying another account's or another purpose's token (defence in depth)", async () => {
    const own = await ctx.account({ verified: false });
    const other = await ctx.account({ verified: false });
    const otherToken = (await ctx.emails()).find((queued) => queued.userId === other.userId)?.payload.token ?? '';
    const queueWithToken = async (account: TestAccount, template: 'verify_email' | 'email_change_verify') => {
      const [key] = await ctx.worker.sql<{ wrapped_dek: Buffer; kek_id: string; kek_version: number }[]>`
        select wrapped_dek, kek_id, kek_version from user_keys where user_id = ${account.userId}`;
      const wrapped = {
        blob: key?.wrapped_dek ?? Buffer.alloc(0),
        kekId: key?.kek_id ?? '',
        kekVersion: key?.kek_version ?? 0,
      };
      await ctx.dataKeys.withKey(account.userId, wrapped, (dataKey) =>
        inTransaction(createDatabase(ctx.admin), (tx) =>
          enqueueEmail(
            tx,
            dataKey,
            { userId: account.userId, template, payload: { to: account.email, locale: 'en', token: otherToken } },
            ctx.clock.now(),
          ),
        ),
      );
    };
    await queueWithToken(own, 'verify_email');
    await queueWithToken(other, 'email_change_verify');

    expect(await delivery().deliverDue()).toEqual({ ...NOTHING, sent: 2, outdated: 2 });

    expect(sender.sent.map((message) => message.to).sort()).toEqual([own.email, other.email].sort());
    expect(sender.sent.map((message) => message.subject)).toEqual([
      'Bestätigen Sie Ihre E-Mail-Adresse',
      'Bestätigen Sie Ihre E-Mail-Adresse',
    ]);
  });
});
