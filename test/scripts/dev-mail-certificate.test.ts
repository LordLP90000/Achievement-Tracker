import { createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureMailCertificate, MAIL_CERTIFICATE_DAYS } from '../../scripts/dev-mail-certificate.ts';

const DAY_MS = 86_400_000;

/** The mail catcher's certificate in the local Compose stack (Q-45, ADR-0018). */
describe('ensureMailCertificate (scripts/dev-mail-certificate.ts)', () => {
  let directory: string;
  const certificate = () => new X509Certificate(readFileSync(join(directory, 'mailpit.pem')));
  const key = () => readFileSync(join(directory, 'mailpit-key.pem'), 'utf8');

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'questline-mail-certificate-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates a certificate for the catcher’s Compose service and localhost, valid for a year, with its key', () => {
    expect(ensureMailCertificate(directory)).toBe('created');

    const created = certificate();
    expect([created.checkHost('mailpit'), created.checkHost('localhost')]).toEqual(['mailpit', 'localhost']);
    expect(Date.parse(created.validTo)).toBeGreaterThan(Date.now() + (MAIL_CERTIFICATE_DAYS - 1) * DAY_MS);
    expect(created.checkPrivateKey(createPrivateKey(key()))).toBe(true);
    if (process.platform !== 'win32') expect(statSync(join(directory, 'mailpit-key.pem')).mode & 0o777).toBe(0o600);
  });

  it('keeps a certificate while it is valid: the running catcher and worker read it only at start', () => {
    ensureMailCertificate(directory);
    const first = { fingerprint: certificate().fingerprint256, key: key() };

    expect(ensureMailCertificate(directory)).toBe('kept');
    expect({ fingerprint: certificate().fingerprint256, key: key() }).toEqual(first);
  });

  it.each<[string, () => void, () => number]>([
    ['has expired', () => undefined, () => Date.now() + (MAIL_CERTIFICATE_DAYS + 1) * DAY_MS],
    [
      'is unreadable',
      () => {
        writeFileSync(join(directory, 'mailpit.pem'), 'not a certificate');
      },
      () => Date.now(),
    ],
    [
      'lost its key',
      () => {
        rmSync(join(directory, 'mailpit-key.pem'));
      },
      () => Date.now(),
    ],
  ])('replaces a certificate that %s', (_reason, damage, now) => {
    ensureMailCertificate(directory);
    const old = key();
    damage();

    expect(ensureMailCertificate(directory, now())).toBe('created');
    expect(key()).not.toBe(old);
    expect(certificate().checkPrivateKey(createPrivateKey(key()))).toBe(true);
  });
});
