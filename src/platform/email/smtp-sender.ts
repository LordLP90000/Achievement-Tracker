import { createTransport } from 'nodemailer';
import { EmailDeliveryError, type EmailSender } from './sender.ts';

/**
 * `SmtpEmailSender` (ADR-0014): delivers through the configured relay with TLS required — STARTTLS that must succeed
 * (`requireTLS`, no fallback to plaintext) or implicit TLS — and the server certificate verified against the system's
 * CA store, so credentials and messages never travel unencrypted or to an impostor.
 */
export type SmtpTlsMode = 'starttls' | 'implicit';

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly tls: SmtpTlsMode;
  readonly user: string;
  readonly password: string;
  /** Sender address. Its domain is also the name the client announces, so no internal host name leaves. */
  readonly from: string;
}

export interface SmtpSenderOptions {
  /** Extra trust anchors (PEM) for the local stand-in relay in tests; production trusts the system's CA store. */
  readonly ca?: string;
  readonly timeoutsMs?: { readonly connection?: number; readonly greeting?: number; readonly socket?: number };
}

const SENDER_NAME = 'Questline';
const DEFAULT_TIMEOUTS_MS = { connection: 10_000, greeting: 10_000, socket: 30_000 };
/** Errors about this message rather than the relay (Nodemailer `EENVELOPE`, `EMESSAGE`). */
const MESSAGE_ERRORS: ReadonlySet<string> = new Set(['EENVELOPE', 'EMESSAGE']);
/** Nodemailer error codes; `smtp_` + code + `_` + reply stays within the `last_error_code` rule `^[a-z0-9_]{1,40}$`. */
const ERROR_CODE = /^E[A-Z\d]{1,22}$/;

interface SmtpFailure {
  readonly code?: unknown;
  readonly responseCode?: unknown;
  readonly permanent?: unknown;
  readonly command?: unknown;
}

function replyCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 200 && value <= 599 ? value : undefined;
}

/** Classifies a Nodemailer failure by code and reply class only: reply text can contain the address. */
export function deliveryError(error: unknown): EmailDeliveryError {
  const failure: SmtpFailure = typeof error === 'object' && error !== null ? error : {};
  const code = typeof failure.code === 'string' && ERROR_CODE.test(failure.code) ? failure.code : undefined;
  const reply = replyCode(failure.responseCode);
  const name = `smtp_${code?.toLowerCase() ?? 'unknown'}${reply === undefined ? '' : `_${String(reply)}`}`;
  // The sender address is the same for every message: refusing it is a relay configuration problem.
  const aboutMessage = code !== undefined && MESSAGE_ERRORS.has(code) && failure.command !== 'MAIL FROM';
  return new EmailDeliveryError(name, aboutMessage ? 'message' : 'relay', aboutMessage && failure.permanent === true);
}

export function createSmtpEmailSender(settings: SmtpSettings, options: SmtpSenderOptions = {}): EmailSender {
  const timeouts = { ...DEFAULT_TIMEOUTS_MS, ...options.timeoutsMs };
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.tls === 'implicit',
    requireTLS: true,
    auth: { user: settings.user, pass: settings.password },
    name: settings.from.slice(settings.from.lastIndexOf('@') + 1),
    tls: { minVersion: 'TLSv1.2', ...(options.ca === undefined ? {} : { ca: options.ca }) },
    connectionTimeout: timeouts.connection,
    greetingTimeout: timeouts.greeting,
    socketTimeout: timeouts.socket,
    dnsTimeout: timeouts.connection,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    async send(message) {
      try {
        await transport.sendMail({
          from: { name: SENDER_NAME, address: settings.from },
          to: message.to,
          subject: message.subject,
          text: message.text,
        });
      } catch (error) {
        throw deliveryError(error);
      }
    },
    close() {
      transport.close();
    },
  };
}
