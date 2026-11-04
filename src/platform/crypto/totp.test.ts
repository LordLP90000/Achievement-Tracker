import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { acceptTotp, hotp, newTotpSecret, otpauthUri, TOTP, totpStep } from './totp.ts';

/** RFC 4226 Appendix D and RFC 6238 Appendix B: the ASCII secret "12345678901234567890". */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const at = (seconds: number) => new Date(seconds * 1000);

describe('HOTP (RFC 4226) [ADR-0019]', () => {
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ])('gives the RFC’s value for counter %i', (counter, code) => {
    expect(hotp(RFC_SECRET, counter)).toBe(code);
  });

  it('gives eight digits when asked, keeping leading zeros', () => {
    expect(hotp(RFC_SECRET, totpStep(at(1111111109)), 8)).toBe('07081804');
  });
});

describe('TOTP (RFC 6238): SHA-1, 6 digits, 30-second steps [ADR-0019]', () => {
  it('uses what authenticator apps use by default', () => {
    expect(TOTP).toEqual({ algorithm: 'SHA1', digits: 6, periodSeconds: 30, secretBytes: 20, driftSteps: 1 });
  });

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('gives the RFC’s value at %i seconds', (seconds, code) => {
    expect(hotp(RFC_SECRET, totpStep(at(seconds)), 8)).toBe(code);
    expect(acceptTotp(RFC_SECRET, code.slice(2), at(seconds), null)).toBe(totpStep(at(seconds)));
  });

  it('counts whole 30-second steps since the epoch', () => {
    expect([totpStep(at(0)), totpStep(at(29.999)), totpStep(at(30)), totpStep(at(59)), totpStep(at(60))]).toEqual([
      0, 0, 1, 1, 2,
    ]);
  });

  it('accepts the code of the current step and of one step either side, for a clock that drifts [RFC 6238 §5.2]', () => {
    const now = at(1234567890);
    const step = totpStep(now);

    expect(acceptTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(acceptTotp(RFC_SECRET, hotp(RFC_SECRET, step), now, null)).toBe(step);
    expect(acceptTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(acceptTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), now, null)).toBeUndefined();
    expect(acceptTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), now, null)).toBeUndefined();
  });

  it('never accepts a code twice: not for the step last accepted, nor for an earlier one [RFC 6238 §5.2]', () => {
    const now = at(1234567890);
    const step = totpStep(now);
    const code = hotp(RFC_SECRET, step);

    expect(acceptTotp(RFC_SECRET, code, now, step)).toBeUndefined();
    expect(acceptTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), now, step - 1)).toBeUndefined();
    expect(acceptTotp(RFC_SECRET, code, now, step - 1)).toBe(step);
    expect(acceptTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
  });

  it.each(['', '12345', '1234567', '12345a', ' 755224', '755224 ', '７５５２２４', '-55224'])(
    'refuses %j, which cannot be a code',
    (code) => {
      expect(acceptTotp(RFC_SECRET, code, at(0), null)).toBeUndefined();
    },
  );

  it('refuses the code of another secret', () => {
    const now = at(1234567890);

    expect(acceptTotp(Buffer.alloc(20, 7), hotp(RFC_SECRET, totpStep(now)), now, null)).toBeUndefined();
  });

  it('accepts a secret’s own current code at any time, and only for a later step than the last one', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 20, maxLength: 20 }),
        fc.integer({ min: 0, max: 4_102_444_800 }),
        (secret, seconds) => {
          const now = at(seconds);
          const step = totpStep(now);
          const code = hotp(secret, step);
          // Two steps may share a code by chance (one in a million): the earliest acceptable step wins.
          const earliest = [step - 1, step].find((candidate) => candidate >= 0 && hotp(secret, candidate) === code);

          expect(code).toMatch(/^\d{6}$/);
          expect(acceptTotp(secret, code, now, null)).toBe(earliest);
          expect(acceptTotp(secret, code, now, step)).toBe(hotp(secret, step + 1) === code ? step + 1 : undefined);
        },
      ),
    );
  });

  it('looks at no step before the epoch', () => {
    expect(acceptTotp(RFC_SECRET, hotp(RFC_SECRET, 0), at(10), null)).toBe(0);
    expect(acceptTotp(RFC_SECRET, hotp(RFC_SECRET, 1), at(10), null)).toBe(1);
  });

  it('makes a new 160-bit secret each time', () => {
    const [first, second] = [newTotpSecret(), newTotpSecret()];

    expect(first).toHaveLength(20);
    expect(first.equals(second)).toBe(false);
  });
});

describe('otpauth URI (the authenticator apps’ key URI format)', () => {
  it('names Questline and the account, and states the secret and the parameters', () => {
    const uri = otpauthUri(RFC_SECRET, 'anna+goals@example.test');

    expect(uri).toBe(
      'otpauth://totp/Questline:anna%2Bgoals%40example.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Questline&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('keeps an account name with a colon or a space inside the label', () => {
    expect(otpauthUri(RFC_SECRET, 'a b:c')).toMatch(/^otpauth:\/\/totp\/Questline:a%20b%3Ac\?/);
  });
});
