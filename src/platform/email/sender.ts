/**
 * Delivery of composed emails (ADR-0014): sending is the worker's only outbound call. Messages are plain text built
 * from fixed templates; nothing a user typed is ever put into an email (A-19, S-11).
 */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface EmailSender {
  /** Resolves once the relay accepted the message; rejects with an `EmailDeliveryError`. */
  send(message: EmailMessage): Promise<void>;
  close(): void;
}

/**
 * `relay`: the relay could not be used at all (connection, TLS, authentication, sender address refused), so every
 * message would fail: retry later and pause delivery. `message`: this message was refused; `permanent` when the relay
 * will never accept it (RFC 5321 5yz reply to the recipient or the content).
 */
export type DeliveryFailureScope = 'relay' | 'message';

export class EmailDeliveryError extends Error {
  override readonly name = 'EmailDeliveryError';
  /** An error class such as `smtp_550` or `smtp_etls`, never reply text (it can contain the address). */
  readonly code: string;
  readonly scope: DeliveryFailureScope;
  readonly permanent: boolean;

  constructor(code: string, scope: DeliveryFailureScope, permanent: boolean) {
    super(`email delivery failed (${code})`);
    this.code = code;
    this.scope = scope;
    this.permanent = permanent;
  }
}
