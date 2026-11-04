import { createHash, randomBytes } from 'node:crypto';
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { WebAuthnConfig } from '../config/config.ts';

/**
 * Passkeys (ADR-0019): the options the platform's passkey API is given and the verification of what it returns. The
 * options are built here, exactly as the contract describes them; signatures, origins, RP ID hashes, flags and
 * attestation formats are verified by `@simplewebauthn/server` (Q-50), which only this module imports.
 * Nothing here touches the database: callers find, store and consume challenges and passkeys.
 */

/** COSE algorithms offered and accepted: EdDSA, ES256, RS256. */
export const PASSKEY_ALGORITHMS: readonly number[] = Object.freeze([-8, -7, -257]);
/** How long a ceremony may take; also the lifetime of its challenge (`webauthn_challenges`). */
export const WEBAUTHN_TIMEOUT_MS = 5 * 60 * 1000;
/** The transports WebAuthn defines; anything else a platform reports is dropped. */
export const PASSKEY_TRANSPORTS: readonly string[] = Object.freeze([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);

const CHALLENGE_BYTES = 32;
const USER_HANDLE_BYTES = 16;
/** WebAuthn's limit for credential IDs, and the column's. */
const MAX_CREDENTIAL_ID_BYTES = 1023;
const MAX_PUBLIC_KEY_BYTES = 2048;

export interface IssuedChallenge {
  /** Sent to the platform: 32 random bytes, unpadded base64url. */
  readonly challenge: string;
  /** Stored instead of the challenge: SHA-256 of its bytes. */
  readonly hash: Buffer;
}

export interface PasskeyDescriptor {
  readonly id: string;
  readonly type: 'public-key';
  readonly transports?: readonly string[];
}

/** `PasskeyCreationOptions` of the contract. */
export interface PasskeyCreationOptions {
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly challenge: string;
  readonly pubKeyCredParams: readonly { readonly type: 'public-key'; readonly alg: number }[];
  readonly timeout: number;
  readonly excludeCredentials: readonly PasskeyDescriptor[];
  readonly authenticatorSelection: {
    readonly residentKey: 'required';
    readonly requireResidentKey: true;
    readonly userVerification: 'required';
  };
  readonly attestation: 'none';
  readonly extensions: { readonly credProps: true };
}

/** `PasskeyRequestOptions` of the contract: no credential list, so it says nothing about any account. */
export interface PasskeyRequestOptions {
  readonly challenge: string;
  readonly timeout: number;
  readonly rpId: string;
  readonly userVerification: 'required';
}

export interface CreationRequest {
  readonly challenge: string;
  /** The account ID: the user handle the passkey keeps and reports at every sign-in. */
  readonly userId: string;
  /** What the device shows for the passkey: the account's address. */
  readonly userName: string;
  /** The account's passkeys, which the platform must not register again. */
  readonly exclude: readonly { readonly credentialId: Buffer; readonly transports: readonly string[] }[];
}

/** What a sign-in result claims, read before anything is verified: which challenge, credential and account. */
export interface ClaimedAssertion {
  readonly challenge: string;
  readonly credentialId: Buffer;
  readonly userId: string;
}

/** A verified registration: what `passkeys` stores. */
export interface RegisteredPasskey {
  readonly credentialId: Buffer;
  /** COSE public key. */
  readonly publicKey: Buffer;
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly backedUp: boolean;
}

/** A stored passkey, as a sign-in is verified against it. */
export interface StoredPasskey {
  readonly credentialId: Buffer;
  readonly publicKey: Buffer;
  readonly signCount: number;
}

export type AssertionOutcome =
  | { readonly outcome: 'verified'; readonly signCount: number; readonly backedUp: boolean }
  /** A valid signature whose counter did not grow: possibly a cloned authenticator (refused, audited). */
  | { readonly outcome: 'counter_not_increased' }
  | { readonly outcome: 'invalid' };

const INVALID: AssertionOutcome = Object.freeze({ outcome: 'invalid' });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Canonical unpadded base64url only: the bytes must encode back to exactly the same text. */
function fromBase64Url(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : undefined;
}

const sha256 = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();

function challengeBytes(value: unknown): Buffer | undefined {
  const bytes = fromBase64Url(value);
  return bytes?.length === CHALLENGE_BYTES ? bytes : undefined;
}

const isChallenge = (value: unknown): value is string => challengeBytes(value) !== undefined;

export function issueChallenge(): IssuedChallenge {
  const bytes = randomBytes(CHALLENGE_BYTES);
  return { challenge: bytes.toString('base64url'), hash: sha256(bytes) };
}

/** The stored form of a challenge a platform signed; `undefined` for anything this API cannot have issued. */
export function challengeHash(challenge: string): Buffer | undefined {
  const bytes = challengeBytes(challenge);
  return bytes === undefined ? undefined : sha256(bytes);
}

const userHandleOf = (userId: string): string => Buffer.from(userId.replaceAll('-', ''), 'hex').toString('base64url');

function userIdOf(userHandle: unknown): string | undefined {
  const hex = fromBase64Url(userHandle)?.toString('hex');
  if (hex?.length !== USER_HANDLE_BYTES * 2) return undefined;
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function creationOptions(config: WebAuthnConfig, request: CreationRequest): PasskeyCreationOptions {
  return {
    rp: { id: config.rpId, name: config.rpName },
    user: { id: userHandleOf(request.userId), name: request.userName, displayName: request.userName },
    challenge: request.challenge,
    pubKeyCredParams: PASSKEY_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
    timeout: WEBAUTHN_TIMEOUT_MS,
    excludeCredentials: request.exclude.map(({ credentialId, transports }) => ({
      id: credentialId.toString('base64url'),
      type: 'public-key',
      ...(transports.length > 0 ? { transports: [...transports] } : {}),
    })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none',
    extensions: { credProps: true },
  };
}

export function requestOptions(config: WebAuthnConfig, challenge: string): PasskeyRequestOptions {
  return { challenge, timeout: WEBAUTHN_TIMEOUT_MS, rpId: config.rpId, userVerification: 'required' };
}

/** The challenge a registration or sign-in result claims to sign, from its `clientDataJSON`. */
export function claimedChallenge(credential: unknown): string | undefined {
  const response = isRecord(credential) ? credential['response'] : undefined;
  const clientData = fromBase64Url(isRecord(response) ? response['clientDataJSON'] : undefined);
  if (clientData === undefined) return undefined;
  const text = clientData.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: it claims no challenge.
  }
  const challenge = isRecord(parsed) ? parsed['challenge'] : undefined;
  return isChallenge(challenge) ? challenge : undefined;
}

/** The challenge, credential and account a sign-in result claims; nothing of it is verified yet. */
export function claimedAssertion(credential: unknown): ClaimedAssertion | undefined {
  if (!isRecord(credential) || credential['rawId'] !== credential['id']) return undefined;
  const credentialId = fromBase64Url(credential['id']);
  const response = credential['response'];
  const userId = userIdOf(isRecord(response) ? response['userHandle'] : undefined);
  const challenge = claimedChallenge(credential);
  if (credentialId === undefined || credentialId.length === 0 || userId === undefined || challenge === undefined) {
    return undefined;
  }
  return { challenge, credentialId, userId };
}

function knownTransports(reported: readonly string[] | undefined): string[] {
  return [...new Set(reported)].filter((transport) => PASSKEY_TRANSPORTS.includes(transport));
}

/**
 * Verifies a registration result against its challenge: origin, RP ID, a creation, user presence and verification,
 * one of the offered algorithms, and the credential ID the platform names being the one the authenticator registered.
 * `undefined` for anything that does not verify.
 */
export async function verifyRegistration(
  config: WebAuthnConfig,
  credential: unknown,
  challenge: string,
): Promise<RegisteredPasskey | undefined> {
  let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    result = await verifyRegistrationResponse({
      response: credential as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: [...config.origins],
      expectedRPID: config.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...PASSKEY_ALGORITHMS],
    });
  } catch {
    return undefined;
  }
  if (!result.verified) return undefined;
  const { credential: verified, credentialBackedUp } = result.registrationInfo;
  const credentialId = Buffer.from(verified.id, 'base64url');
  if (
    !isRecord(credential) ||
    credential['rawId'] !== verified.id ||
    credentialId.length > MAX_CREDENTIAL_ID_BYTES ||
    verified.publicKey.length > MAX_PUBLIC_KEY_BYTES
  ) {
    return undefined;
  }
  return {
    credentialId,
    publicKey: Buffer.from(verified.publicKey),
    signCount: verified.counter,
    transports: knownTransports(verified.transports),
    backedUp: credentialBackedUp,
  };
}

/**
 * A counter must grow (WebAuthn §6.1.1), unless the authenticator does not count: it reported 0 so far, and the
 * counters of most synced passkeys stay 0.
 */
const counterGrew = (stored: number, reported: number): boolean => reported > stored || stored === 0;

/**
 * Verifies a sign-in result against its challenge and the stored passkey: origin, RP ID, a sign-in, user presence and
 * verification, the signature, and the credential ID. Only a valid signature is judged by its counter, so a forgery
 * is never mistaken for a clone.
 */
export async function verifyAssertion(
  config: WebAuthnConfig,
  credential: unknown,
  challenge: string,
  stored: StoredPasskey,
): Promise<AssertionOutcome> {
  const credentialId = stored.credentialId.toString('base64url');
  let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    result = await verifyAuthenticationResponse({
      response: credential as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: [...config.origins],
      expectedRPID: config.rpId,
      // Counter 0 turns the library's own counter check off: it runs before the signature check.
      credential: { id: credentialId, publicKey: new Uint8Array(stored.publicKey), counter: 0 },
      requireUserVerification: true,
    });
  } catch {
    return INVALID;
  }
  if (!result.verified || !isRecord(credential) || credential['rawId'] !== credentialId) return INVALID;
  const { newCounter, credentialBackedUp } = result.authenticationInfo;
  if (!counterGrew(stored.signCount, newCounter)) return { outcome: 'counter_not_increased' };
  return { outcome: 'verified', signCount: newCounter, backedUp: credentialBackedUp };
}
