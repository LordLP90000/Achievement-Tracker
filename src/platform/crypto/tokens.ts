import { createHash, randomBytes } from 'node:crypto';

/** Opaque bearer and one-time tokens (ADR-0004): `ql_<kind>_` + 32 random bytes in base64url (43 characters). */

export const TOKEN_KINDS = {
  access: 'at',
  refresh: 'rt',
  /** Email verification and the confirmation of an email change (the token's purpose is stored with its hash). */
  verification: 'vt',
  passwordReset: 'pt',
} as const;

export type TokenKind = keyof typeof TOKEN_KINDS;

/** R-AUTH-03: verification, reset and email-change links work for at most 30 minutes (the emails say so too). */
export const ONE_TIME_TOKEN_LIFETIME_MS = 30 * 60 * 1000;

export interface IssuedToken {
  /** Handed to the client exactly once; never stored or logged. */
  readonly token: string;
  /** SHA-256 of the whole token: the only form that is stored. */
  readonly hash: Buffer;
}

const RANDOM_BYTES = 32;
const BODY = /^[\w-]{43}$/;

const digest = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

export function issueToken(kind: TokenKind): IssuedToken {
  const token = `ql_${TOKEN_KINDS[kind]}_${randomBytes(RANDOM_BYTES).toString('base64url')}`;
  return { token, hash: digest(token) };
}

/** Digest of a presented token for a lookup, or `undefined` when it is malformed or of another kind. */
export function tokenHash(kind: TokenKind, presented: string): Buffer | undefined {
  const prefix = `ql_${TOKEN_KINDS[kind]}_`;
  if (!presented.startsWith(prefix) || !BODY.test(presented.slice(prefix.length))) return undefined;
  return digest(presented);
}
