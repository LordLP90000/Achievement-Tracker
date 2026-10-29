import type { FieldContext } from '../../platform/crypto/aead.ts';
import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { issueToken, ONE_TIME_TOKEN_LIFETIME_MS, type TokenKind } from '../../platform/crypto/tokens.ts';
import { setUserContext, type Transaction } from '../../platform/db/database.ts';
import { enqueueEmail, type EmailTemplate } from '../../platform/email/outbox-repository.ts';
import { replaceOneTimeToken, requireWrappedKey, type OneTimeTokenPurpose } from './repository.ts';

/** Helpers shared by the account flows that read the encrypted address or email a single-use link. */

export interface Recipient {
  readonly userId: string;
  readonly to: string;
  readonly locale: string;
}

export interface TokenEmail {
  readonly tokenKind: TokenKind;
  readonly purpose: OneTimeTokenPurpose;
  readonly template: EmailTemplate;
}

export const VERIFY_EMAIL: TokenEmail = {
  tokenKind: 'verification',
  purpose: 'verify_email',
  template: 'verify_email',
};
export const RESET_PASSWORD: TokenEmail = {
  tokenKind: 'passwordReset',
  purpose: 'reset_password',
  template: 'password_reset',
};

/** Where `users.email_enc` is bound: AD record id = user id. */
export const emailField = (userId: string): FieldContext => ({ userId, recordId: userId, field: 'email_enc' });

/** Binds the transaction to the account and runs `work` with its data key, which is wiped afterwards. */
export async function withAccountKey<T>(
  tx: Transaction,
  dataKeys: DataKeys,
  userId: string,
  work: (dataKey: Uint8Array) => Promise<T>,
): Promise<T> {
  await setUserContext(tx, userId);
  return dataKeys.withKey(userId, await requireWrappedKey(tx, userId), work);
}

/** Issues a single-use token (unused ones of the same purpose stop working) and queues the email carrying it. */
export async function sendTokenEmail(
  tx: Transaction,
  dataKey: Uint8Array,
  recipient: Recipient,
  kind: TokenEmail,
  now: Date,
): Promise<void> {
  const { token, hash } = issueToken(kind.tokenKind);
  await replaceOneTimeToken(
    tx,
    {
      userId: recipient.userId,
      purpose: kind.purpose,
      tokenHash: hash,
      expiresAt: new Date(now.getTime() + ONE_TIME_TOKEN_LIFETIME_MS),
    },
    now,
  );
  await enqueueEmail(
    tx,
    dataKey,
    {
      userId: recipient.userId,
      template: kind.template,
      payload: { to: recipient.to, locale: recipient.locale, token },
    },
    now,
  );
}
