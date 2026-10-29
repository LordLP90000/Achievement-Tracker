import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { createTransport } from 'nodemailer';
import { afterEach, describe, expect, it } from 'vitest';
import { EmailDeliveryError } from '../../src/platform/email/sender.ts';
import { createSmtpEmailSender, type SmtpSettings } from '../../src/platform/email/smtp-sender.ts';
import {
  parseEmail,
  STAND_IN_PASSWORD,
  STAND_IN_USER,
  startSmtpStandIn,
  type SmtpStandIn,
  type StandInBehaviour,
} from '../helpers/smtp-stand-in.ts';

const MESSAGE = {
  to: 'ada@example.test',
  subject: 'Bestätigen Sie Ihre E-Mail-Adresse',
  text: 'Guten Tag\n\nhttps://app.questline.test/verify-email#token=ql_vt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n',
};

/** SMTP delivery against a local stand-in relay: TLS is never optional (ADR-0014, E-12, Q-27). */
describe('SmtpEmailSender', () => {
  const cleanup: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()));
  });

  async function relay(behaviour: StandInBehaviour): Promise<SmtpStandIn> {
    const standIn = await startSmtpStandIn(behaviour);
    cleanup.push(standIn.close);
    return standIn;
  }

  const settings = (port: number, overrides: Partial<SmtpSettings> = {}): SmtpSettings => ({
    host: '127.0.0.1',
    port,
    tls: 'starttls',
    user: STAND_IN_USER,
    password: STAND_IN_PASSWORD,
    from: 'no-reply@questline.test',
    ...overrides,
  });

  async function failureOf(sending: Promise<void>): Promise<EmailDeliveryError> {
    const error = await sending.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(EmailDeliveryError);
    return error as EmailDeliveryError;
  }

  it('delivers a plain-text message over STARTTLS after authenticating', async () => {
    const standIn = await relay({ tls: 'starttls' });
    const sender = createSmtpEmailSender(settings(standIn.port), { ca: standIn.cert });

    await sender.send(MESSAGE);
    sender.close();

    expect(standIn.received).toHaveLength(1);
    const [email] = standIn.received;
    expect(email).toMatchObject({
      mailFrom: 'no-reply@questline.test',
      rcptTo: ['ada@example.test'],
      secure: true,
      user: STAND_IN_USER,
    });
    const parsed = parseEmail(email?.raw ?? '');
    expect(parsed.headers.get('from')).toBe('Questline <no-reply@questline.test>');
    expect(parsed.headers.get('to')).toBe('ada@example.test');
    expect(parsed.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(parsed.subject).toBe(MESSAGE.subject);
    expect(parsed.text.trimEnd()).toBe(MESSAGE.text.trimEnd());
  });

  it('names only the sending domain to the relay, never an internal host name', async () => {
    const standIn = await relay({ tls: 'starttls' });
    const sender = createSmtpEmailSender(settings(standIn.port), { ca: standIn.cert });

    await sender.send(MESSAGE);
    sender.close();

    const [email] = standIn.received;
    expect(email?.clientName).toBe('questline.test');
    expect(parseEmail(email?.raw ?? '').headers.get('message-id')).toMatch(/@questline\.test>$/);
  });

  it('delivers over implicit TLS', async () => {
    const standIn = await relay({ tls: 'implicit' });
    const sender = createSmtpEmailSender(settings(standIn.port, { tls: 'implicit' }), { ca: standIn.cert });

    await sender.send(MESSAGE);
    sender.close();

    expect(standIn.received).toMatchObject([{ secure: true, user: STAND_IN_USER }]);
  });

  it('refuses a relay that offers no STARTTLS before sending credentials or the message [E-12]', async () => {
    const standIn = await relay({ tls: 'none' });
    const sender = createSmtpEmailSender(settings(standIn.port), { ca: standIn.cert });

    const error = await failureOf(sender.send(MESSAGE));
    sender.close();

    expect(error).toMatchObject({ code: 'smtp_etls_500', scope: 'relay', permanent: false });
    expect(standIn.authAttempts()).toBe(0);
    expect(standIn.received).toEqual([]);
  });

  it('control: the plaintext stand-in does accept a client that does not insist on TLS', async () => {
    const standIn = await relay({ tls: 'none' });
    const lenient = createTransport({
      host: '127.0.0.1',
      port: standIn.port,
      ignoreTLS: true,
      auth: { user: STAND_IN_USER, pass: STAND_IN_PASSWORD },
    });

    await lenient.sendMail({ from: 'no-reply@questline.test', ...MESSAGE });
    lenient.close();

    expect(standIn.received).toMatchObject([{ secure: false, user: STAND_IN_USER }]);
  });

  it('refuses a relay whose certificate it does not trust before sending credentials [E-12]', async () => {
    const standIn = await relay({ tls: 'starttls' });
    const sender = createSmtpEmailSender(settings(standIn.port));

    const error = await failureOf(sender.send(MESSAGE));
    sender.close();

    expect(error).toMatchObject({ scope: 'relay', permanent: false });
    expect(error.code).toMatch(/^smtp_e[a-z]+$/);
    expect(standIn.authAttempts()).toBe(0);
    expect(standIn.received).toEqual([]);
  });

  it('refuses an implicit-TLS relay whose certificate it does not trust [E-12]', async () => {
    const standIn = await relay({ tls: 'implicit' });
    const sender = createSmtpEmailSender(settings(standIn.port, { tls: 'implicit' }));

    const error = await failureOf(sender.send(MESSAGE));
    sender.close();

    expect(error).toMatchObject({ scope: 'relay', permanent: false });
    expect(standIn.authAttempts()).toBe(0);
  });

  it('reports refused credentials as a relay failure, to be retried [E-12]', async () => {
    const standIn = await relay({ tls: 'starttls' });
    const sender = createSmtpEmailSender(settings(standIn.port, { password: 'not-the-relay-password' }), {
      ca: standIn.cert,
    });

    const error = await failureOf(sender.send(MESSAGE));
    sender.close();

    expect(error).toMatchObject({ code: 'smtp_eauth_535', scope: 'relay', permanent: false });
    expect(standIn.received).toEqual([]);
  });

  it('reports a refused sender address as a relay failure: it affects every message', async () => {
    const standIn = await relay({ tls: 'starttls', refuseSender: { code: 553, message: '5.7.1 Sender rejected' } });
    const sender = createSmtpEmailSender(settings(standIn.port), { ca: standIn.cert });

    const error = await failureOf(sender.send(MESSAGE));
    sender.close();

    expect(error).toMatchObject({ code: 'smtp_eenvelope_553', scope: 'relay', permanent: false });
  });

  it('reports a recipient refused for good as a permanent failure of this message', async () => {
    const standIn = await relay({ tls: 'starttls', refuseRecipient: { code: 550, message: '5.1.1 No such user' } });
    const sender = createSmtpEmailSender(settings(standIn.port), { ca: standIn.cert });

    const error = await failureOf(sender.send(MESSAGE));
    sender.close();

    expect(error).toMatchObject({ code: 'smtp_eenvelope_550', scope: 'message', permanent: true });
  });

  it('reports a recipient refused for now as a transient failure of this message', async () => {
    const standIn = await relay({ tls: 'starttls', refuseRecipient: { code: 450, message: '4.2.1 Try later' } });
    const sender = createSmtpEmailSender(settings(standIn.port), { ca: standIn.cert });

    const error = await failureOf(sender.send(MESSAGE));
    sender.close();

    expect(error).toMatchObject({ code: 'smtp_eenvelope_450', scope: 'message', permanent: false });
  });

  it('reports a message refused after its content was sent as a permanent failure of this message', async () => {
    const standIn = await relay({ tls: 'starttls', refuseData: { code: 554, message: '5.6.0 Message refused' } });
    const sender = createSmtpEmailSender(settings(standIn.port), { ca: standIn.cert });

    const error = await failureOf(sender.send(MESSAGE));
    sender.close();

    expect(error).toMatchObject({ code: 'smtp_emessage_554', scope: 'message', permanent: true });
  });

  it('reports an unreachable relay as a relay failure', async () => {
    const closed = createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const { port } = closed.address() as AddressInfo;
    closed.close();
    const sender = createSmtpEmailSender(settings(port));

    const error = await failureOf(sender.send(MESSAGE));
    sender.close();

    expect(error).toMatchObject({ scope: 'relay', permanent: false });
    expect(error.code).toMatch(/^smtp_e[a-z]+$/);
  });

  it('gives up on a relay that accepts the connection but never greets', async () => {
    const silent = createServer(() => undefined);
    silent.listen(0, '127.0.0.1');
    await once(silent, 'listening');
    cleanup.push(async () => {
      silent.close();
      await Promise.resolve();
    });
    const sender = createSmtpEmailSender(settings((silent.address() as AddressInfo).port), {
      timeoutsMs: { greeting: 200 },
    });

    const error = await failureOf(sender.send(MESSAGE));
    sender.close();

    expect(error).toMatchObject({ code: 'smtp_etimedout', scope: 'relay', permanent: false });
  });
});
