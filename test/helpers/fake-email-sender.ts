import type { EmailMessage, EmailSender } from '../../src/platform/email/sender.ts';
import { EmailDeliveryError } from '../../src/platform/email/sender.ts';

/**
 * Captures delivered messages so tests can read links from them (test strategy §2). Failures are scripted: `failNext`
 * makes the next sends fail in order, `failAlways` every send until `succeed`.
 */
export class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  attempts = 0;
  closed = false;
  #next: Error[] = [];
  #always: Error | undefined;

  failNext(...failures: Error[]): this {
    this.#next.push(...failures);
    return this;
  }

  failAlways(failure: Error): this {
    this.#always = failure;
    return this;
  }

  succeed(): this {
    this.#next = [];
    this.#always = undefined;
    return this;
  }

  send(message: EmailMessage): Promise<void> {
    this.attempts += 1;
    const failure = this.#next.shift() ?? this.#always;
    if (failure !== undefined) return Promise.reject(failure);
    this.sent.push(message);
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
  }
}

export const RELAY_DOWN = new EmailDeliveryError('smtp_econnection', 'relay', false);
export const MAILBOX_BUSY = new EmailDeliveryError('smtp_eenvelope_450', 'message', false);
export const NO_SUCH_MAILBOX = new EmailDeliveryError('smtp_eenvelope_550', 'message', true);

/** The single-use token in a delivered link (`…#token=ql_…`). */
export function tokenIn(message: EmailMessage | undefined): string {
  const token = /#token=(ql_[a-z]{2}_[\w-]{43})$/m.exec(message?.text ?? '')?.[1];
  if (token === undefined) throw new Error('the message carries no link with a token');
  return token;
}
