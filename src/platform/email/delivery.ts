import type { Logger } from 'pino';
import { z } from 'zod';
import type { DataKeys } from '../crypto/data-keys.ts';
import { decryptText } from '../crypto/field-cipher.ts';
import { tokenHash, type TokenKind } from '../crypto/tokens.ts';
import { inTransaction, type Database } from '../db/database.ts';
import { DEFAULT_LOCALE, isLocale } from '../i18n/locales.ts';
import type { Clock } from '../time/clock.ts';
import {
  claimNextEmail,
  deleteEmail,
  isOneTimeTokenUsable,
  recordFailedAttempt,
  type ClaimedEmail,
  type TokenReference,
} from './outbox-repository.ts';
import { EmailDeliveryError, type EmailMessage, type EmailSender } from './sender.ts';
import { isLinkTemplate, linkFor, renderEmail, type LinkTemplate } from './templates.ts';

/**
 * The worker side of the outbox (ADR-0009, ADR-0014, architecture §4.7). Each email is claimed with a lease, composed
 * from its encrypted payload, sent, and then deleted, retried with exponential backoff, or dead-lettered. A link
 * email is sent only while its single-use token still works (D-05): a replaced, used or expired link is dropped.
 * A relay failure pauses all delivery for a while, so a broken relay is not hammered (D-07).
 */

export interface OutboxLimits {
  readonly maxAttempts: number;
  /** Delay after the first failed attempt; it doubles after each further one. */
  readonly firstRetryMs: number;
  /** How long a claimed email stays reserved for the worker sending it. */
  readonly leaseMs: number;
  readonly maxPerRound: number;
  /** Pause after the relay itself failed (connection, TLS, authentication). */
  readonly relayPauseMs: number;
}

export const OUTBOX_DELIVERY: OutboxLimits = Object.freeze({
  maxAttempts: 8,
  firstRetryMs: 60_000,
  leaseMs: 5 * 60_000,
  maxPerRound: 50,
  relayPauseMs: 60_000,
});

export interface OutboxDeliveryDependencies {
  /** Worker role. */
  readonly db: Database;
  readonly dataKeys: DataKeys;
  readonly sender: EmailSender;
  readonly clock: Clock;
  /** Base URL of the links in emails (A-19). */
  readonly linkBaseUrl: string;
  readonly logger: Logger;
}

export interface DeliveryRound {
  readonly sent: number;
  readonly retried: number;
  readonly dead: number;
  /** Link emails dropped because their link no longer works. */
  readonly outdated: number;
  /** Delivery is paused after a relay failure. */
  readonly paused: boolean;
}

export interface OutboxDelivery {
  /** Delivers due emails until none is left, the round limit is reached or the relay fails. */
  deliverDue(): Promise<DeliveryRound>;
}

const PAYLOAD = z.object({
  // One address, no whitespace: a header can never be broken open.
  to: z.string().regex(/^[^\s@]+@[^\s@]+$/),
  locale: z.string(),
  token: z.string().optional(),
});

const LINK_TOKENS: Readonly<Record<LinkTemplate, { kind: TokenKind; purpose: TokenReference['purpose'] }>> = {
  verify_email: { kind: 'verification', purpose: 'verify_email' },
  email_change_verify: { kind: 'verification', purpose: 'change_email' },
  password_reset: { kind: 'passwordReset', purpose: 'reset_password' },
};

/** What to do with a claimed email before anything is sent. */
type Composed =
  | { readonly kind: 'message'; readonly message: EmailMessage; readonly token?: TokenReference }
  | { readonly kind: 'invalid'; readonly code: 'payload_unreadable' | 'payload_invalid' };

type Outcome = 'sent' | 'retried' | 'dead' | 'outdated';

interface Delivered {
  readonly outcome: Outcome;
  /** The relay itself failed: pause all delivery. */
  readonly pause: boolean;
}

export function createOutboxDelivery(
  deps: OutboxDeliveryDependencies,
  limits: OutboxLimits = OUTBOX_DELIVERY,
): OutboxDelivery {
  let pausedUntil = 0;

  async function decryptPayload(email: ClaimedEmail): Promise<unknown> {
    const { key } = email;
    if (key === undefined) return undefined;
    try {
      const json = await deps.dataKeys.withKey(email.userId, key, (dataKey) =>
        Promise.resolve(
          decryptText(dataKey, { userId: email.userId, recordId: email.id, field: 'payload_enc' }, email.payloadEnc),
        ),
      );
      return JSON.parse(json) as unknown;
    } catch {
      return undefined;
    }
  }

  async function compose(email: ClaimedEmail): Promise<Composed> {
    const decrypted = await decryptPayload(email);
    if (decrypted === undefined) return { kind: 'invalid', code: 'payload_unreadable' };
    const parsed = PAYLOAD.safeParse(decrypted);
    if (!parsed.success) return { kind: 'invalid', code: 'payload_invalid' };
    const { to, token } = parsed.data;
    const locale = isLocale(parsed.data.locale) ? parsed.data.locale : DEFAULT_LOCALE;
    const { template } = email;
    if (!isLinkTemplate(template)) return { kind: 'message', message: { to, ...renderEmail({ template }, locale) } };
    const { kind, purpose } = LINK_TOKENS[template];
    const hash = token === undefined ? undefined : tokenHash(kind, token);
    if (token === undefined || hash === undefined) return { kind: 'invalid', code: 'payload_invalid' };
    return {
      kind: 'message',
      message: { to, ...renderEmail({ template, link: linkFor(deps.linkBaseUrl, template, token) }, locale) },
      token: { userId: email.userId, purpose, tokenHash: hash },
    };
  }

  async function fail(email: ClaimedEmail, code: string, permanent: boolean): Promise<Outcome> {
    const now = deps.clock.now();
    const log = { template: email.template, attempt: email.attempts, error_code: code };
    if (permanent || email.attempts >= limits.maxAttempts) {
      await recordFailedAttempt(deps.db, email, code, now, undefined);
      deps.logger.error(log, 'email dead-lettered');
      return 'dead';
    }
    const retryAt = new Date(now.getTime() + limits.firstRetryMs * 2 ** (email.attempts - 1));
    await recordFailedAttempt(deps.db, email, code, now, retryAt);
    deps.logger.warn(log, 'email delivery failed, will retry');
    return 'retried';
  }

  async function deliver(email: ClaimedEmail): Promise<Delivered> {
    const composed = await compose(email);
    if (composed.kind === 'invalid') return { outcome: await fail(email, composed.code, true), pause: false };
    if (composed.token !== undefined && !(await isOneTimeTokenUsable(deps.db, composed.token, deps.clock.now()))) {
      await deleteEmail(deps.db, email.id);
      deps.logger.info({ template: email.template }, 'email dropped: its link no longer works');
      return { outcome: 'outdated', pause: false };
    }
    try {
      await deps.sender.send(composed.message);
    } catch (error) {
      // Anything but a classified refusal is treated as a relay failure: retried, never sent in a loop.
      const failure =
        error instanceof EmailDeliveryError ? error : new EmailDeliveryError('send_failed', 'relay', false);
      return { outcome: await fail(email, failure.code, failure.permanent), pause: failure.scope === 'relay' };
    }
    await deleteEmail(deps.db, email.id);
    deps.logger.info({ template: email.template }, 'email sent');
    return { outcome: 'sent', pause: false };
  }

  return {
    async deliverDue() {
      const counts = { sent: 0, retried: 0, dead: 0, outdated: 0 };
      if (deps.clock.now().getTime() < pausedUntil) return { ...counts, paused: true };
      for (let index = 0; index < limits.maxPerRound; index += 1) {
        const now = deps.clock.now();
        const email = await inTransaction(deps.db, (tx) =>
          claimNextEmail(tx, now, new Date(now.getTime() + limits.leaseMs)),
        );
        if (email === undefined) break;
        const { outcome, pause } = await deliver(email);
        counts[outcome] += 1;
        if (pause) {
          pausedUntil = deps.clock.now().getTime() + limits.relayPauseMs;
          deps.logger.warn({ pause_ms: limits.relayPauseMs }, 'email delivery paused: the relay failed');
          return { ...counts, paused: true };
        }
      }
      return { ...counts, paused: false };
    },
  };
}
