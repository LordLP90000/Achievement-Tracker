import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import { constantTimeEqual } from '../../src/platform/crypto/compare.ts';
import { createTestCertificate } from './tls-certificate.ts';

/**
 * Local stand-in for the SMTP relay (Q-27): an in-process `smtp-server` on 127.0.0.1 with a throw-away certificate
 * (`cert`, which the client must trust explicitly), a fixed user and programmable refusals.
 */
export interface ReceivedEmail {
  readonly mailFrom: string;
  readonly rcptTo: readonly string[];
  readonly raw: string;
  readonly secure: boolean;
  readonly user: string | undefined;
  readonly clientName: string;
}

export interface SmtpStandIn {
  readonly port: number;
  readonly cert: string;
  readonly received: ReceivedEmail[];
  /** Number of AUTH attempts, accepted or not. */
  readonly authAttempts: () => number;
  readonly close: () => Promise<void>;
}

export interface SmtpRefusal {
  readonly code: number;
  readonly message: string;
}

export interface StandInBehaviour {
  /** `none` offers no STARTTLS and accepts AUTH in plaintext, as a downgraded or misconfigured relay would. */
  readonly tls: 'starttls' | 'implicit' | 'none';
  readonly refuseSender?: SmtpRefusal;
  readonly refuseRecipient?: SmtpRefusal;
  readonly refuseData?: SmtpRefusal;
}

export const STAND_IN_USER = 'relay-user';
export const STAND_IN_PASSWORD = 'relay-password-for-tests';

export interface ParsedEmail {
  /** Header names in lower case, folded lines joined. */
  readonly headers: ReadonlyMap<string, string>;
  readonly subject: string;
  /** The decoded text body with `\n` line ends. */
  readonly text: string;
}

function decodeQuotedPrintable(encoded: string): Buffer {
  const text = encoded.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '=') {
      bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(text.charCodeAt(index));
    }
  }
  return Buffer.from(bytes);
}

/** RFC 2047 encoded words as Nodemailer writes them (UTF-8, B or Q); whitespace between two words is dropped. */
function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_word, encoding: string, data: string) =>
      (encoding.toLowerCase() === 'b'
        ? Buffer.from(data, 'base64')
        : decodeQuotedPrintable(data.replace(/_/g, ' '))
      ).toString('utf8'),
    );
}

/** A minimal parser for the single-part text messages the sender produces. */
export function parseEmail(raw: string): ParsedEmail {
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, split).replace(/\r\n[ \t]+/g, ' ');
  const headers = new Map(
    head.split('\r\n').map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()] as const;
    }),
  );
  const body = raw.slice(split + 4);
  const encoding = headers.get('content-transfer-encoding')?.toLowerCase();
  const bytes =
    encoding === 'base64'
      ? Buffer.from(body, 'base64')
      : encoding === 'quoted-printable'
        ? decodeQuotedPrintable(body)
        : Buffer.from(body, 'utf8');
  return {
    headers,
    subject: decodeWords(headers.get('subject') ?? ''),
    text: bytes.toString('utf8').replace(/\r\n/g, '\n'),
  };
}

const refusal = ({ code, message }: SmtpRefusal): Error => Object.assign(new Error(message), { responseCode: code });

export async function startSmtpStandIn(behaviour: StandInBehaviour): Promise<SmtpStandIn> {
  const certificate = createTestCertificate();
  const received: ReceivedEmail[] = [];
  let authAttempts = 0;
  const options: SMTPServerOptions = {
    secure: behaviour.tls === 'implicit',
    // Hiding STARTTLS alone is not enough: Nodemailer with `requireTLS` sends it anyway, and the server would accept.
    hideSTARTTLS: behaviour.tls === 'none',
    disabledCommands: behaviour.tls === 'none' ? ['STARTTLS'] : [],
    allowInsecureAuth: behaviour.tls === 'none',
    key: certificate.key,
    cert: certificate.cert,
    authMethods: ['PLAIN', 'LOGIN'],
    disableReverseLookup: true,
    logger: false,
    onAuth(auth, _session, callback) {
      authAttempts += 1;
      const matches = (given: string | null | undefined, expected: string) =>
        constantTimeEqual(Buffer.from(given ?? ''), Buffer.from(expected));
      if (matches(auth.username, STAND_IN_USER) && matches(auth.password, STAND_IN_PASSWORD)) {
        callback(null, { user: auth.username });
      } else {
        callback(refusal({ code: 535, message: '5.7.8 Authentication credentials invalid' }));
      }
    },
    onMailFrom(_address, _session, callback) {
      callback(behaviour.refuseSender === undefined ? null : refusal(behaviour.refuseSender));
    },
    onRcptTo(_address, _session, callback) {
      callback(behaviour.refuseRecipient === undefined ? null : refusal(behaviour.refuseRecipient));
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        if (behaviour.refuseData !== undefined) {
          callback(refusal(behaviour.refuseData));
          return;
        }
        received.push({
          mailFrom: session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
          rcptTo: session.envelope.rcptTo.map((recipient) => recipient.address),
          raw: Buffer.concat(chunks).toString('utf8'),
          secure: session.secure,
          user: typeof session.user === 'string' ? session.user : undefined,
          clientName: session.hostNameAppearsAs,
        });
        callback(null);
      });
    },
  };
  const server = new SMTPServer(options);
  // Clients that refuse the certificate abort the handshake; the server reports that as an error event.
  server.on('error', () => undefined);
  server.listen(0, '127.0.0.1');
  await once(server.server, 'listening');
  return {
    port: (server.server.address() as AddressInfo).port,
    cert: certificate.cert,
    received,
    authAttempts: () => authAttempts,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
