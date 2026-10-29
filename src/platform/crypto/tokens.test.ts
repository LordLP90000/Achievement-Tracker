import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueToken, TOKEN_KINDS, tokenHash, type TokenKind } from './tokens.ts';

/** `OpaqueToken.pattern` in openapi/openapi.yaml (`[A-Za-z0-9_-]` written as `[\w-]`). */
const CONTRACT_PATTERN = /^ql_[a-z]{2}_[\w-]{43}$/;
const kinds = Object.keys(TOKEN_KINDS) as TokenKind[];

describe('issueToken (ADR-0004) [R-AUTH-03, R-AUTH-04]', () => {
  it.each([
    ['access', 'ql_at_'],
    ['refresh', 'ql_rt_'],
    ['verification', 'ql_vt_'],
    ['passwordReset', 'ql_pt_'],
  ] as const)('issues %s tokens with the prefix %s in the contract format', (kind, prefix) => {
    const { token } = issueToken(kind);

    expect(token.startsWith(prefix)).toBe(true);
    expect(token).toMatch(CONTRACT_PATTERN);
  });

  it('carries 256 random bits per token', () => {
    const tokens = Array.from({ length: 1000 }, () => issueToken('access').token);

    expect(new Set(tokens).size).toBe(1000);
    for (const token of tokens.slice(0, 10)) {
      expect(Buffer.from(token.slice(6), 'base64url')).toHaveLength(32);
    }
  });

  it('hands out the SHA-256 digest of the whole token for storage, never the token itself', () => {
    const { token, hash } = issueToken('refresh');

    expect(hash).toEqual(createHash('sha256').update(token, 'utf8').digest());
    expect(hash).toHaveLength(32);
    expect(hash.toString('utf8')).not.toContain(token.slice(6, 20));
  });
});

describe('tokenHash', () => {
  it.each(kinds)('accepts a well-formed %s token and returns the same digest as at issue time', (kind) => {
    const { token, hash } = issueToken(kind);

    expect(tokenHash(kind, token)).toEqual(hash);
  });

  it('refuses a token of another kind, so a refresh token can never be used as an access token', () => {
    for (const presentedKind of kinds) {
      const { token } = issueToken(presentedKind);
      for (const expectedKind of kinds.filter((kind) => kind !== presentedKind)) {
        expect(tokenHash(expectedKind, token)).toBeUndefined();
      }
    }
  });

  const valid = issueToken('access').token;
  it.each([
    '',
    'ql_at_',
    valid.slice(0, -1),
    `${valid}A`,
    ` ${valid}`,
    `${valid}\n`,
    valid.replace('ql_at_', 'QL_AT_'),
    `${valid.slice(0, -1)}=`,
    `${valid.slice(0, -1)}+`,
    `${valid.slice(0, -1)}/`,
    `${valid.slice(0, -1)}é`,
  ])('refuses the malformed access token %j', (presented) => {
    expect(tokenHash('access', presented)).toBeUndefined();
  });
});
