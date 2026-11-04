import type { WebAuthnConfig } from '../../platform/config/config.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { verifyAssertion, type ClaimedAssertion } from '../../platform/webauthn/webauthn.ts';
import { findPasskeyByCredential, recordPasskeyUse } from './repository.ts';

/**
 * A passkey sign-in or step-up result checked against the passkey of the account its user handle names (ADR-0019),
 * in the caller's transaction, bound to that account: another account's credential is not found. A verified use
 * updates the passkey's counter, backup state and last use.
 */

export type PasskeyCheck = 'verified' | 'invalid' | 'counter_not_increased';

export async function checkPasskeyAssertion(
  tx: Transaction,
  config: WebAuthnConfig,
  credential: unknown,
  claim: ClaimedAssertion,
  now: Date,
): Promise<PasskeyCheck> {
  const stored = await findPasskeyByCredential(tx, claim.userId, claim.credentialId);
  if (stored === undefined) return 'invalid';
  const result = await verifyAssertion(config, credential, claim.challenge, stored);
  if (result.outcome !== 'verified') return result.outcome;
  await recordPasskeyUse(tx, stored.id, { signCount: result.signCount, backedUp: result.backedUp }, now);
  return 'verified';
}
