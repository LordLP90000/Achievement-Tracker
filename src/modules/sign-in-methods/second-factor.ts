import type { FieldContext } from '../../platform/crypto/aead.ts';
import { decryptText } from '../../platform/crypto/field-cipher.ts';
import { recoveryCodeHash } from '../../platform/crypto/recovery-codes.ts';
import { acceptTotp } from '../../platform/crypto/totp.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { countRecoveryCodes, hasEnabledTotp, lockTotpSecret, recordTotpStep, useRecoveryCode } from './repository.ts';

/**
 * The second factor of a password login and of a password step-up with TOTP on (ADR-0019): the authenticator app's
 * current code, or a recovery code. A code that matches is used up — the TOTP step is remembered, the recovery code
 * deleted — in the caller's transaction, which must be bound to the account.
 */

export type SecondFactorMethod = 'totp' | 'recovery_code';

export type SecondFactor = { readonly totpCode: string } | { readonly recoveryCode: string };

/** The method that matched; `wrong` for a code that did not; `not_enabled` when TOTP is off (nothing to check). */
export type SecondFactorCheck = SecondFactorMethod | 'wrong' | 'not_enabled';

/** Where `totp_secrets.secret_enc` is bound: AD record id = user id (one secret per account). */
export const totpSecretField = (userId: string): FieldContext => ({ userId, recordId: userId, field: 'secret_enc' });

/** What the account can answer with, or `undefined` when TOTP is off: the app's code, and recovery codes if any is left. */
export async function secondFactorMethods(
  tx: Transaction,
  userId: string,
): Promise<readonly SecondFactorMethod[] | undefined> {
  if (!(await hasEnabledTotp(tx, userId))) return undefined;
  return (await countRecoveryCodes(tx, userId)) > 0 ? ['totp', 'recovery_code'] : ['totp'];
}

/** Checks the code under a lock on the account's secret, so two requests can never use one code. */
export async function checkSecondFactor(
  tx: Transaction,
  dataKey: Uint8Array,
  userId: string,
  factor: SecondFactor,
  now: Date,
): Promise<SecondFactorCheck> {
  const stored = await lockTotpSecret(tx, userId);
  if (stored?.enabledAt == null) return 'not_enabled';
  if ('totpCode' in factor) {
    const secret = Buffer.from(decryptText(dataKey, totpSecretField(userId), stored.secretEnc), 'base64');
    const step = acceptTotp(secret, factor.totpCode, now, stored.lastUsedStep);
    if (step === undefined) return 'wrong';
    await recordTotpStep(tx, userId, step);
    return 'totp';
  }
  const hash = recoveryCodeHash(factor.recoveryCode);
  return hash !== undefined && (await useRecoveryCode(tx, userId, hash)) ? 'recovery_code' : 'wrong';
}
