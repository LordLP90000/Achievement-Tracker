// Local development only (Q-45, ADR-0018): the TLS certificate of the mail catcher in docker/compose.yml. The Compose
// service `mail-certificate` runs this file, mounted read-only, with Node.js in the app image:
//   node scripts/dev-mail-certificate.ts <directory>
// so the key never leaves the Compose volume. A certificate is kept until it expires, because Mailpit and the worker
// read it once at start; after a replacement restart both (`docker compose -f docker/compose.yml restart mailpit worker`).
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestCertificate } from '../test/helpers/tls-certificate.ts';

/** The names the catcher is reached by: its Compose service, and `localhost` for a client on the host. */
export const MAIL_CATCHER_HOSTS = ['mailpit', 'localhost'] as const;
export const MAIL_CERTIFICATE_DAYS = 365;

function expiryOf(certificatePath: string): number | undefined {
  try {
    return Date.parse(new X509Certificate(readFileSync(certificatePath)).validTo);
  } catch {
    return undefined;
  }
}

/** Writes `mailpit.pem` and `mailpit-key.pem` into the directory unless a certificate there is still valid at `now`. */
export function ensureMailCertificate(directory: string, now: number = Date.now()): 'created' | 'kept' {
  const certificatePath = join(directory, 'mailpit.pem');
  const keyPath = join(directory, 'mailpit-key.pem');
  const expiry = existsSync(keyPath) ? expiryOf(certificatePath) : undefined;
  if (expiry !== undefined && expiry > now) return 'kept';
  const { cert, key } = createTestCertificate({ hostnames: MAIL_CATCHER_HOSTS, validDays: MAIL_CERTIFICATE_DAYS });
  writeFileSync(keyPath, key, { mode: 0o600 });
  writeFileSync(certificatePath, cert, { mode: 0o644 });
  return 'created';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (directory === undefined) throw new Error('usage: node scripts/dev-mail-certificate.ts <directory>');
  process.stdout.write(`mail catcher certificate ${ensureMailCertificate(directory)}\n`);
}
