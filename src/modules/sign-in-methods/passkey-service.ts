import { randomUUID } from 'node:crypto';
import type { FieldContext } from '../../platform/crypto/aead.ts';
import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { decryptText, encryptText } from '../../platform/crypto/field-cipher.ts';
import type { WebAuthnConfig } from '../../platform/config/config.ts';
import { inTransaction, type Database, type Transaction } from '../../platform/db/database.ts';
import type { Clock } from '../../platform/time/clock.ts';
import {
  challengeHash,
  claimedChallenge,
  creationOptions,
  issueChallenge,
  verifyRegistration,
  WEBAUTHN_TIMEOUT_MS,
  type PasskeyCreationOptions,
} from '../../platform/webauthn/webauthn.ts';
import { emailField, withAccountKey } from '../accounts/account-mail.ts';
import { findAccountById } from '../accounts/repository.ts';
import type { RequestContext } from '../audit/context.ts';
import { recordAuditEvent, type AuditEventType } from '../audit/repository.ts';
import { hasRecentReauth, type Principal } from '../sessions/guard.ts';
import { queueSignInMethodsNotice } from './notice.ts';
import {
  consumeRegistrationChallenge,
  deletePasskey,
  insertPasskey,
  insertWebauthnChallenge,
  listPasskeys,
  lockAccount,
  type PasskeyRecord,
} from './repository.ts';

/**
 * The account's passkeys (ADR-0019): registering one with options this API issued, listing and removing them. Changes
 * need the password within 10 minutes (R-AUTH-06), are audited and told to the owner; at most 10 per account.
 */

export const MAX_PASSKEYS = 10;

export interface PasskeysServiceDependencies {
  readonly db: Database;
  readonly clock: Clock;
  readonly dataKeys: DataKeys;
  readonly webauthn: WebAuthnConfig;
}

/** `Passkey` of the contract. */
export interface PasskeyView {
  readonly id: string;
  readonly name: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly backedUp: boolean;
}

interface ReauthenticationRequired {
  readonly outcome: 'reauthentication_required';
}

export type CreationOptionsResult =
  | { readonly outcome: 'options'; readonly options: PasskeyCreationOptions }
  | { readonly outcome: 'limit_reached' }
  | ReauthenticationRequired;

export type RegisterPasskeyResult =
  | { readonly outcome: 'registered'; readonly passkey: PasskeyView }
  | { readonly outcome: 'invalid_passkey' | 'limit_reached' }
  | ReauthenticationRequired;

export type RemovePasskeyResult = { readonly outcome: 'removed' | 'not_found' } | ReauthenticationRequired;

export interface PasskeysService {
  /** WebAuthn creation options with a fresh challenge bound to the account. */
  creationOptions(principal: Principal): Promise<CreationOptionsResult>;
  /** Verifies the platform's registration result against the account's challenge and stores the passkey. */
  register(
    principal: Principal,
    credential: unknown,
    name: string | undefined,
    context: RequestContext,
  ): Promise<RegisterPasskeyResult>;
  list(principal: Principal): Promise<PasskeyView[]>;
  remove(principal: Principal, passkeyId: string, context: RequestContext): Promise<RemovePasskeyResult>;
}

const REAUTHENTICATION_REQUIRED: ReauthenticationRequired = Object.freeze({ outcome: 'reauthentication_required' });

/** Where `passkeys.name_enc` is bound: AD record id = the passkey's ID. */
const nameField = (userId: string, passkeyId: string): FieldContext => ({
  userId,
  recordId: passkeyId,
  field: 'name_enc',
});

export function createPasskeysService(deps: PasskeysServiceDependencies): PasskeysService {
  /** In one transaction bound to the account, with its data key. */
  const inAccount = <T>(userId: string, work: (tx: Transaction, dataKey: Uint8Array) => Promise<T>): Promise<T> =>
    inTransaction(deps.db, (tx) => withAccountKey(tx, deps.dataKeys, userId, (dataKey) => work(tx, dataKey)));

  const viewOf = (dataKey: Uint8Array, userId: string, record: PasskeyRecord): PasskeyView => ({
    id: record.id,
    name: record.nameEnc === null ? null : decryptText(dataKey, nameField(userId, record.id), record.nameEnc),
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    backedUp: record.backedUp,
  });

  /** The change's audit event, naming the passkey, and the owner's notice, committed with it (R-LOG-03). */
  const record = async (
    tx: Transaction,
    dataKey: Uint8Array,
    principal: Principal,
    change: { readonly eventType: AuditEventType; readonly passkeyId: string; readonly context: RequestContext },
    now: Date,
  ): Promise<void> => {
    await recordAuditEvent(
      tx,
      {
        userId: principal.userId,
        eventType: change.eventType,
        outcome: 'success',
        ipPrefix: change.context.ipPrefix,
        client: null,
        sessionId: principal.sessionId,
        metadata: { passkey_id: change.passkeyId },
      },
      now,
    );
    await queueSignInMethodsNotice(tx, dataKey, principal.userId, now);
  };

  return {
    async creationOptions(principal) {
      const now = deps.clock.now();
      if (!hasRecentReauth(principal, now)) return REAUTHENTICATION_REQUIRED;
      const { userId } = principal;
      return inAccount(userId, async (tx, dataKey): Promise<CreationOptionsResult> => {
        const existing = await listPasskeys(tx, userId);
        if (existing.length >= MAX_PASSKEYS) return { outcome: 'limit_reached' };
        const account = await findAccountById(tx, userId);
        if (account === undefined) throw new Error('the signed-in account is gone');
        const { challenge, hash } = issueChallenge();
        await insertWebauthnChallenge(
          tx,
          {
            challengeHash: hash,
            purpose: 'registration',
            userId,
            expiresAt: new Date(now.getTime() + WEBAUTHN_TIMEOUT_MS),
          },
          now,
        );
        return {
          outcome: 'options',
          options: creationOptions(deps.webauthn, {
            challenge,
            userId,
            userName: decryptText(dataKey, emailField(userId), account.emailEnc),
            exclude: existing.map((passkey) => ({
              credentialId: passkey.credentialId,
              transports: passkey.transports,
            })),
          }),
        };
      });
    },

    async register(principal, credential, name, context) {
      const now = deps.clock.now();
      if (!hasRecentReauth(principal, now)) return REAUTHENTICATION_REQUIRED;
      const challenge = claimedChallenge(credential);
      const hash = challenge === undefined ? undefined : challengeHash(challenge);
      if (challenge === undefined || hash === undefined) return { outcome: 'invalid_passkey' };
      const { userId } = principal;
      return inAccount(userId, async (tx, dataKey): Promise<RegisterPasskeyResult> => {
        await lockAccount(tx, userId);
        // Used up whatever follows: a challenge answers one registration attempt.
        if (!(await consumeRegistrationChallenge(tx, hash, userId, now))) return { outcome: 'invalid_passkey' };
        const verified = await verifyRegistration(deps.webauthn, credential, challenge);
        if (verified === undefined) return { outcome: 'invalid_passkey' };
        if ((await listPasskeys(tx, userId)).length >= MAX_PASSKEYS) return { outcome: 'limit_reached' };
        const id = randomUUID();
        const inserted = await insertPasskey(
          tx,
          {
            id,
            userId,
            credentialId: verified.credentialId,
            publicKey: verified.publicKey,
            signCount: verified.signCount,
            transports: verified.transports,
            backedUp: verified.backedUp,
            nameEnc: name === undefined ? null : encryptText(dataKey, nameField(userId, id), name),
          },
          now,
        );
        if (!inserted) return { outcome: 'invalid_passkey' };
        await record(tx, dataKey, principal, { eventType: 'passkey_added', passkeyId: id, context }, now);
        return {
          outcome: 'registered',
          passkey: { id, name: name ?? null, createdAt: now, lastUsedAt: null, backedUp: verified.backedUp },
        };
      });
    },

    list(principal) {
      return inAccount(principal.userId, async (tx, dataKey) =>
        (await listPasskeys(tx, principal.userId)).map((passkey) => viewOf(dataKey, principal.userId, passkey)),
      );
    },

    async remove(principal, passkeyId, context) {
      const now = deps.clock.now();
      if (!hasRecentReauth(principal, now)) return REAUTHENTICATION_REQUIRED;
      return inAccount(principal.userId, async (tx, dataKey): Promise<RemovePasskeyResult> => {
        if (!(await deletePasskey(tx, principal.userId, passkeyId))) return { outcome: 'not_found' };
        await record(tx, dataKey, principal, { eventType: 'passkey_removed', passkeyId, context }, now);
        return { outcome: 'removed' };
      });
    },
  };
}
