import { decryptText } from '../../platform/crypto/field-cipher.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { enqueueEmail } from '../../platform/email/outbox-repository.ts';
import { emailField } from '../accounts/account-mail.ts';
import { findAccountById } from '../accounts/repository.ts';

/**
 * ADR-0019: every change of passkeys, TOTP or recovery codes is told to the owner, without a link, so a change made
 * with a stolen password or session does not go unnoticed. Runs in the change's transaction, bound to the account.
 */
export async function queueSignInMethodsNotice(
  tx: Transaction,
  dataKey: Uint8Array,
  userId: string,
  now: Date,
): Promise<void> {
  const account = await findAccountById(tx, userId);
  if (account === undefined) throw new Error('the account of a sign-in method change is gone');
  const to = decryptText(dataKey, emailField(userId), account.emailEnc);
  await enqueueEmail(
    tx,
    dataKey,
    { userId, template: 'sign_in_methods_changed_notice', payload: { to, locale: account.locale } },
    now,
  );
}
