import { describe, expect, it } from 'vitest';
import { EmailDeliveryError } from './sender.ts';
import { deliveryError } from './smtp-sender.ts';

const LAST_ERROR_CODE = /^[a-z0-9_]{1,40}$/;

describe('deliveryError', () => {
  it('names the failed step and the SMTP reply code', () => {
    expect(deliveryError({ code: 'EENVELOPE', responseCode: 550, permanent: true, command: 'RCPT TO' })).toMatchObject({
      code: 'smtp_eenvelope_550',
      scope: 'message',
      permanent: true,
    });
  });

  it('names only the step when there is no reply', () => {
    expect(deliveryError({ code: 'ECONNECTION' })).toMatchObject({
      code: 'smtp_econnection',
      scope: 'relay',
      permanent: false,
    });
  });

  it('keeps a refused sender address a relay failure even when the reply is permanent', () => {
    expect(
      deliveryError({ code: 'EENVELOPE', responseCode: 553, permanent: true, command: 'MAIL FROM' }),
    ).toMatchObject({ code: 'smtp_eenvelope_553', scope: 'relay', permanent: false });
  });

  it('keeps a permanent reply to a relay-level step (TLS, authentication) a relay failure to retry', () => {
    expect(deliveryError({ code: 'ETLS', responseCode: 500, permanent: true, command: 'STARTTLS' })).toMatchObject({
      code: 'smtp_etls_500',
      scope: 'relay',
      permanent: false,
    });
    expect(deliveryError({ code: 'EAUTH', responseCode: 535, permanent: true })).toMatchObject({
      code: 'smtp_eauth_535',
      scope: 'relay',
      permanent: false,
    });
  });

  it('treats a message failure without a permanent reply as transient', () => {
    expect(deliveryError({ code: 'EMESSAGE', responseCode: 451, permanent: false, command: 'DATA' })).toMatchObject({
      code: 'smtp_emessage_451',
      scope: 'message',
      permanent: false,
    });
    expect(deliveryError({ code: 'EMESSAGE', responseCode: 552, command: 'DATA' })).toMatchObject({
      scope: 'message',
      permanent: false,
    });
  });

  it('never copies free text into the code: odd codes and replies are left out', () => {
    for (const odd of [
      undefined,
      null,
      'ECONNECTION',
      {},
      { code: 'ECONNECTION ada@example.test' },
      { code: 'econnection' },
      { code: 42 },
      { responseCode: 199 },
      { responseCode: 600 },
      { responseCode: 450.5 },
      { responseCode: '550' },
    ]) {
      const error = deliveryError(odd);
      expect(error).toBeInstanceOf(EmailDeliveryError);
      expect(error).toMatchObject({ code: 'smtp_unknown', scope: 'relay', permanent: false });
    }
    expect(deliveryError({ responseCode: 200 }).code).toBe('smtp_unknown_200');
    expect(deliveryError({ responseCode: 599 }).code).toBe('smtp_unknown_599');
  });

  it('keeps every code within the last_error_code column rule', () => {
    const longest = deliveryError({ code: `E${'X'.repeat(22)}`, responseCode: 599 });

    expect(longest.code).toBe(`smtp_e${'x'.repeat(22)}_599`);
    expect(longest.code).toMatch(LAST_ERROR_CODE);
    expect(deliveryError({ code: `E${'X'.repeat(23)}` }).code).toBe('smtp_unknown');
    expect(deliveryError({ code: 'EAUTH', responseCode: 535 }).message).toBe('email delivery failed (smtp_eauth_535)');
  });
});
