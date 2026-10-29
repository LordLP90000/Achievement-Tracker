import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/**
 * Throw-away self-signed TLS certificates for local test servers such as the SMTP stand-in (Q-27). They are created
 * in memory for each run, so no private key is ever committed, and a client trusts one only when the test passes it
 * as a trust anchor (`ca`). Node.js can parse X.509 certificates but not create them; this is the minimal DER needed:
 * ECDSA P-256 with SHA-256, CN and subjectAltName `localhost` and `127.0.0.1`, valid from one hour ago for one day.
 */
export interface TestCertificate {
  /** PKCS #8 private key (PEM). */
  readonly key: string;
  /** X.509 certificate (PEM). */
  readonly cert: string;
}

const HOUR_MS = 3_600_000;
const HOSTNAME = 'localhost';
const LOOPBACK = [127, 0, 0, 1];

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

const sequence = (...items: Buffer[]): Buffer => tlv(0x30, ...items);

function objectIdentifier(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk = [arc % 128];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128))
      chunk.unshift(0x80 | (value % 128));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime `YYMMDDHHMMSSZ` (valid until 2049). */
const utcTime = (instant: Date): Buffer =>
  tlv(0x17, Buffer.from(`${instant.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));

const TRUE = tlv(0x01, Buffer.from([0xff]));
const ECDSA_WITH_SHA256 = sequence(objectIdentifier('1.2.840.10045.4.3.2'));

function extension(id: string, value: Buffer, critical = false): Buffer {
  return sequence(objectIdentifier(id), ...(critical ? [TRUE] : []), tlv(0x04, value));
}

export function createTestCertificate(): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const name = sequence(tlv(0x31, sequence(objectIdentifier('2.5.4.3'), tlv(0x0c, Buffer.from(HOSTNAME)))));
  const serial = randomBytes(16);
  // A positive INTEGER in minimal DER: the first byte is neither 0x00 nor has its top bit set.
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;
  const now = Date.now();
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ECDSA_WITH_SHA256,
    name,
    sequence(utcTime(new Date(now - HOUR_MS)), utcTime(new Date(now + 24 * HOUR_MS))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(
      0xa3,
      sequence(
        extension('2.5.29.19', sequence(TRUE), true),
        extension('2.5.29.17', sequence(tlv(0x82, Buffer.from(HOSTNAME)), tlv(0x87, Buffer.from(LOOPBACK)))),
      ),
    ),
  );
  const der = sequence(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
  };
}
