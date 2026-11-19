import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MaintenanceIncompleteError, runMaintenance } from '../../src/main/maintenance.ts';
import {
  previewIncidentNotice,
  sendIncidentNotice,
  type IncidentNotice,
} from '../../src/modules/privacy/incident-notice.ts';
import type { MaintenanceConfig } from '../../src/platform/config/config.ts';
import { createDataKeys } from '../../src/platform/crypto/data-keys.ts';
import { envKekSource } from '../../src/platform/crypto/kek-source.ts';
import { generateDataKey, localKeyWrapper } from '../../src/platform/crypto/key-wrapper.ts';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createDatabase, inTransaction } from '../../src/platform/db/database.ts';
import { createOutboxDelivery, OUTBOX_DELIVERY } from '../../src/platform/email/delivery.ts';
import { enqueueEmail } from '../../src/platform/email/outbox-repository.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { FakeEmailSender } from '../helpers/fake-email-sender.ts';
import { LogCapture } from '../helpers/log-capture.ts';

const NOTICE: IncidentNotice = {
  incident: '2026-11-database-copy',
  texts: {
    de: { subject: 'Ein Sicherheitsvorfall bei Questline', body: 'Was geschah.\n\nWas wir getan haben.' },
    fr: { subject: 'Un incident de sécurité chez Questline', body: 'Ce qui s’est passé.' },
    it: { subject: 'Un incidente di sicurezza presso Questline', body: 'Che cosa è successo.' },
    en: { subject: 'A security incident at Questline', body: 'What happened.' },
  },
};

/**
 * The incident notice (Q-61, ADR-0021): after a breach that must be told to the people concerned, a maintenance command
 * queues one email per account, in the account's language, and records who got it, so a second run sends nothing
 * twice. It runs with the migrator's role while the service runs: it only adds rows.
 */
describe('incident notice to every account [Q-61, ADR-0021, S-20, R-LOG-02]', () => {
  let ctx: AccountsApp;
  let opened: DatabaseClient[] = [];

  const client = (url: string, applicationName = 'questline-maintenance') => {
    const created = createDatabaseClient({ url, applicationName });
    opened = [...opened, created];
    return created;
  };
  const migrator = () => createDatabase(client(ctx.database.urls.migrator));
  const dataKeys = () => createDataKeys(localKeyWrapper(ctx.kek));
  const send = (notice = NOTICE, batchSize?: number) =>
    sendIncidentNotice(migrator(), dataKeys(), notice, {
      now: ctx.clock.now(),
      ...(batchSize === undefined ? {} : { batchSize }),
    });
  const config = (): MaintenanceConfig => ({
    appEnv: 'test',
    logLevel: 'info',
    databaseUrl: ctx.database.urls.migrator,
    replacedDatabaseUrl: undefined,
  });
  const loggerFor = (logs: LogCapture) =>
    createLogger({ service: 'questline-maintenance', level: 'info' }, logs.stream);
  const queuedFor = async () =>
    (
      await ctx.admin.sql<{ user_id: string }[]>`
        select user_id from email_outbox where template = 'incident_notice' order by user_id`
    ).map((row) => row.user_id);
  const notifiedFor = async (incident = NOTICE.incident) =>
    (
      await ctx.admin.sql<{ user_id: string }[]>`
        select user_id from audit_events
        where event_type = 'incident_notified' and metadata = ${ctx.admin.sql.json({ incident })}
        order by user_id`
    ).map((row) => row.user_id);
  const ids = (accounts: readonly TestAccount[]) => accounts.map((account) => account.userId).sort();
  /** Four accounts, one per language: verified or not, active or pending deletion. */
  const accountsInEveryLanguage = async () => {
    const german = await ctx.account();
    const french = await ctx.account({ verified: false });
    const italian = await ctx.account();
    const english = await ctx.account();
    for (const [account, locale] of [
      [german, 'de-CH'],
      [french, 'fr'],
      [italian, 'it-CH'],
      [english, 'en'],
    ] as const) {
      await ctx.admin.sql`update users set locale = ${locale} where id = ${account.userId}`;
    }
    await ctx.admin.sql`update users set deactivated_at = ${ctx.clock.now()} where id = ${italian.userId}`;
    // The notice comes after the deletion request, as one would: the worker withholds most emails queued after it.
    ctx.clock.advance({ minutes: 1 });
    // Registration emails are not this test's subject.
    await ctx.admin.sql`delete from email_outbox`;
    return { german, french, italian, english };
  };

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  beforeEach(async () => {
    await ctx.admin.sql`delete from users`;
  });

  afterEach(async () => {
    await Promise.all(opened.map((created) => created.close()));
    opened = [];
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('queues one notice per account, verified or not and pending deletion too, batch by batch, and records who got it', async () => {
    const { german, french, italian, english } = await accountsInEveryLanguage();
    const everyone = [german, french, italian, english];

    expect(await send(NOTICE, 3)).toEqual({ queued: 4, alreadyNotified: 0, unreadable: 0 });

    expect(await queuedFor()).toEqual(ids(everyone));
    expect(await notifiedFor()).toEqual(ids(everyone));
  });

  it('sends each account the text of its language, also an account pending deletion [Q-46]', async () => {
    const { german, french, italian, english } = await accountsInEveryLanguage();
    await send();
    const sender = new FakeEmailSender();
    const delivery = createOutboxDelivery(
      {
        db: createDatabase(ctx.worker),
        dataKeys: ctx.dataKeys,
        sender,
        clock: ctx.clock,
        linkBaseUrl: 'https://app.questline.test',
        logger: createLogger({ service: 'questline-worker', level: 'info' }, new LogCapture().stream),
      },
      OUTBOX_DELIVERY,
    );

    expect(await delivery.deliverDue()).toMatchObject({ sent: 4, withheld: 0, dead: 0 });

    const received = new Map(sender.sent.map((message) => [message.to, message]));
    for (const [account, text] of [
      [german, NOTICE.texts.de],
      [french, NOTICE.texts.fr],
      [italian, NOTICE.texts.it],
      [english, NOTICE.texts.en],
    ] as const) {
      expect(received.get(account.email)?.subject).toBe(text.subject);
      expect(received.get(account.email)?.text).toContain(`\n\n${text.body}\n\n`);
    }
  });

  it('sends nothing twice: a second run finds everyone notified; another incident notifies everyone again', async () => {
    const accounts = Object.values(await accountsInEveryLanguage());
    await send();

    expect(await send()).toEqual({ queued: 0, alreadyNotified: 4, unreadable: 0 });
    expect(await queuedFor()).toHaveLength(4);
    expect(await send({ ...NOTICE, incident: '2026-12-relay-breach' })).toEqual({
      queued: 4,
      alreadyNotified: 0,
      unreadable: 0,
    });
    expect(await notifiedFor('2026-12-relay-breach')).toEqual(ids(accounts));
  });

  it('sends nothing twice when two runs overlap', async () => {
    await accountsInEveryLanguage();

    const results = await Promise.all([send(NOTICE, 1), send(NOTICE, 1)]);

    expect(results.reduce((sum, result) => sum + result.queued, 0)).toBe(4);
    expect(await queuedFor()).toHaveLength(4);
  });

  it('previews the recipients by language and those already notified, and queues nothing', async () => {
    const { german } = await accountsInEveryLanguage();
    // A locale the app does not offer is written to in the default language, Swiss German, as the worker does.
    const elsewhere = await ctx.account();
    await ctx.admin.sql`update users set locale = 'es' where id = ${elsewhere.userId}`;
    await ctx.admin.sql`delete from email_outbox`;

    expect(await previewIncidentNotice(migrator(), NOTICE)).toEqual({
      recipients: { de: 2, fr: 1, it: 1, en: 1 },
      alreadyNotified: 0,
    });
    expect(await queuedFor()).toEqual([]);
    await send();
    await ctx.admin.sql`delete from email_outbox where user_id = ${german.userId}`;
    expect((await previewIncidentNotice(migrator(), NOTICE)).alreadyNotified).toBe(5);
  });

  describe('as the maintenance commands send-incident-notice and preview-incident-notice', () => {
    it('counts an account the KEK cannot read, notifies the rest, and fails for a decision by hand', async () => {
      const { german, french } = await accountsInEveryLanguage();
      const stray = localKeyWrapper(await envKekSource(randomBytes(32))()).wrap(generateDataKey(), french.userId);
      await ctx.admin.sql`update user_keys set wrapped_dek = ${stray.blob} where user_id = ${french.userId}`;
      const logs = new LogCapture();

      const failure = await runMaintenance('send-incident-notice', config(), loggerFor(logs), {
        incident: { notice: NOTICE, kek: ctx.kek },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(MaintenanceIncompleteError);
      expect(failure).toMatchObject({ code: 'unreadable_accounts' });
      expect(logs.records().find((record) => record['msg'] === 'incident notice queued')).toMatchObject({
        incident: NOTICE.incident,
        queued: 3,
        alreadyNotified: 0,
        unreadable: 1,
      });
      expect(await queuedFor()).not.toContain(french.userId);
      expect(await queuedFor()).toContain(german.userId);
    });

    it('counts an account that lost its data key as unreadable as well', async () => {
      const { english } = await accountsInEveryLanguage();
      await ctx.admin.sql`delete from user_keys where user_id = ${english.userId}`;

      expect(await send()).toEqual({ queued: 3, alreadyNotified: 0, unreadable: 1 });
      expect(await queuedFor()).not.toContain(english.userId);
      expect(await notifiedFor()).not.toContain(english.userId);
    });

    it('runs while the API and the worker are connected, and logs counts only: no address, no text', async () => {
      const accounts = Object.values(await accountsInEveryLanguage());
      await client(ctx.database.urls.app, 'questline-api').sql`select 1`;
      await client(ctx.database.urls.worker, 'questline-worker').sql`select 1`;
      const logs = new LogCapture();

      await runMaintenance('preview-incident-notice', config(), loggerFor(logs), { incident: { notice: NOTICE } });
      await runMaintenance('send-incident-notice', config(), loggerFor(logs), {
        incident: { notice: NOTICE, kek: ctx.kek },
      });

      expect(logs.records().find((record) => record['msg'] === 'incident notice previewed')).toMatchObject({
        incident: NOTICE.incident,
        recipients: { de: 1, fr: 1, it: 1, en: 1 },
        alreadyNotified: 0,
      });
      expect(logs.records().find((record) => record['msg'] === 'incident notice queued')).toMatchObject({
        queued: 4,
      });
      for (const account of accounts) {
        expect(logs.text).not.toContain(account.email);
        expect(logs.text).not.toContain(account.userId);
      }
      for (const text of Object.values(NOTICE.texts)) {
        expect(logs.text).not.toContain(text.subject);
        expect(logs.text).not.toContain(text.body);
      }
    });
  });

  it('gives up a queued notice without a valid text at once, as a dead letter', async () => {
    const account = await ctx.account();
    await ctx.admin.sql`delete from email_outbox`;
    const [key] = await ctx.admin.sql<{ wrapped_dek: Buffer; kek_id: string; kek_version: number }[]>`
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
            template: 'incident_notice',
            payload: { to: account.email, locale: 'en', notice: { subject: 'Two\nlines', body: 'Body' } },
          },
          ctx.clock.now(),
        ),
      ),
    );
    const sender = new FakeEmailSender();
    const delivery = createOutboxDelivery(
      {
        db: createDatabase(ctx.worker),
        dataKeys: ctx.dataKeys,
        sender,
        clock: ctx.clock,
        linkBaseUrl: 'https://app.questline.test',
        logger: createLogger({ service: 'questline-worker', level: 'info' }, new LogCapture().stream),
      },
      OUTBOX_DELIVERY,
    );

    expect(await delivery.deliverDue()).toMatchObject({ sent: 0, dead: 1 });
    expect(sender.sent).toEqual([]);
    const [row] = await ctx.admin.sql<{ last_error_code: string }[]>`
      select last_error_code from email_outbox where user_id = ${account.userId}`;
    expect(row?.last_error_code).toBe('payload_invalid');
  });
});
