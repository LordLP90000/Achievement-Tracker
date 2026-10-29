import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, type Env } from './config.ts';
import { loadApiKeys, loadWorkerKeys } from './keys.ts';

const key = (bytes = 32) => randomBytes(bytes).toString('base64');
const VAULT = 'a1b2c3d4e5f6g7h8i9j0k1l2m3';
const ITEM = 'z9y8x7w6v5u4t3s2r1q0p9o8n7';

const localKek = key();
const devEnv: Env = { KEK_SOURCE: 'env', LOCAL_KEK: localKek, BLIND_INDEX_KEY: key(), RATE_LIMIT_KEY: key(48) };
const connectEnv: Env = {
  KEK_SOURCE: 'onepassword-connect',
  OP_CONNECT_URL: 'https://op-connect.internal:8443',
  OP_CONNECT_TOKEN: 'synthetic-connect-token',
  OP_KEK_VAULT_ID: VAULT,
  OP_KEK_ITEM_ID: ITEM,
  BLIND_INDEX_KEY: key(),
  RATE_LIMIT_KEY: key(),
};

function issuesOf(load: () => unknown): readonly string[] {
  try {
    load();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues;
  }
  throw new Error('expected a ConfigError');
}

describe('loadApiKeys (architecture §4.1) [R-ENC-02, R-ENC-05, R-SUP-04]', () => {
  it('reads a local KEK and the index keys in development', () => {
    const keys = loadApiKeys(devEnv, 'development');

    expect(keys.kek).toEqual({ kind: 'env', localKek: Buffer.from(localKek, 'base64') });
    expect(keys.blindIndexKey).toHaveLength(32);
    expect(keys.rateLimitKey).toHaveLength(48);
    expect(Object.isFrozen(keys)).toBe(true);
  });

  it('reads the 1Password Connect settings', () => {
    expect(loadApiKeys(connectEnv, 'production').kek).toEqual({
      kind: 'onepassword-connect',
      url: new URL('https://op-connect.internal:8443'),
      token: 'synthetic-connect-token',
      vaultId: VAULT,
      itemId: ITEM,
    });
  });

  it('names every missing variable', () => {
    expect(issuesOf(() => loadApiKeys({}, 'development'))).toEqual([
      'KEK_SOURCE: is required',
      'BLIND_INDEX_KEY: is required',
      'RATE_LIMIT_KEY: is required',
    ]);
    expect(issuesOf(() => loadApiKeys({ ...devEnv, LOCAL_KEK: '' }, 'development'))).toEqual([
      'LOCAL_KEK: is required when KEK_SOURCE=env',
    ]);
    expect(
      issuesOf(() =>
        loadApiKeys(
          { KEK_SOURCE: 'onepassword-connect', BLIND_INDEX_KEY: key(), RATE_LIMIT_KEY: key() },
          'development',
        ),
      ),
    ).toEqual([
      'OP_CONNECT_URL: is required when KEK_SOURCE=onepassword-connect',
      'OP_CONNECT_TOKEN: is required when KEK_SOURCE=onepassword-connect',
      'OP_KEK_VAULT_ID: is required when KEK_SOURCE=onepassword-connect',
      'OP_KEK_ITEM_ID: is required when KEK_SOURCE=onepassword-connect',
    ]);
  });

  it.each([
    [{ KEK_SOURCE: 'kms' }, 'KEK_SOURCE: must be one of env, onepassword-connect'],
    [{ LOCAL_KEK: key(31) }, 'LOCAL_KEK: must be exactly 32 random bytes in base64'],
    [{ LOCAL_KEK: Buffer.alloc(32).toString('base64') }, 'LOCAL_KEK: must be exactly 32 random bytes in base64'],
    [{ LOCAL_KEK: 'replace-with-a-random-value' }, 'LOCAL_KEK: must be exactly 32 random bytes in base64'],
    [{ BLIND_INDEX_KEY: key(16) }, 'BLIND_INDEX_KEY: must be 32 to 64 random bytes in base64'],
    [{ RATE_LIMIT_KEY: key(65) }, 'RATE_LIMIT_KEY: must be 32 to 64 random bytes in base64'],
    [{ RATE_LIMIT_KEY: 'not base64 !' }, 'RATE_LIMIT_KEY: must be 32 to 64 random bytes in base64'],
  ])('refuses %j', (override, issue) => {
    expect(issuesOf(() => loadApiKeys({ ...devEnv, ...override }, 'development'))).toEqual([issue]);
  });

  it('refuses one secret used for two purposes', () => {
    const shared = key();

    expect(issuesOf(() => loadApiKeys({ ...devEnv, BLIND_INDEX_KEY: shared, RATE_LIMIT_KEY: shared }, 'test'))).toEqual(
      ['RATE_LIMIT_KEY: must differ from the other keys'],
    );
    expect(issuesOf(() => loadApiKeys({ ...devEnv, BLIND_INDEX_KEY: localKek }, 'test'))).toEqual([
      'BLIND_INDEX_KEY: must differ from the other keys',
    ]);
  });

  it.each([
    [{ OP_CONNECT_URL: 'ftp://op-connect.internal' }, 'OP_CONNECT_URL: must be an http(s) URL'],
    [{ OP_CONNECT_URL: 'not a url' }, 'OP_CONNECT_URL: must be an http(s) URL'],
    [{ OP_KEK_VAULT_ID: 'Vault' }, 'OP_KEK_VAULT_ID: must be a 1Password ID (26 lower-case letters or digits)'],
    [{ OP_KEK_ITEM_ID: `${ITEM}/../x` }, 'OP_KEK_ITEM_ID: must be a 1Password ID (26 lower-case letters or digits)'],
  ])('refuses the Connect setting %j', (override, issue) => {
    expect(issuesOf(() => loadApiKeys({ ...connectEnv, ...override }, 'development'))).toEqual([issue]);
  });

  describe('in production', () => {
    it('refuses a KEK from the environment: it must come from 1Password Connect [R-ENC-05]', () => {
      expect(issuesOf(() => loadApiKeys(devEnv, 'production'))).toEqual([
        'KEK_SOURCE: env is not allowed in production; use onepassword-connect (R-ENC-05)',
      ]);
    });

    it('refuses a LOCAL_KEK left in the environment next to Connect', () => {
      expect(issuesOf(() => loadApiKeys({ ...connectEnv, LOCAL_KEK: localKek }, 'production'))).toEqual([
        'LOCAL_KEK: must not be set in production',
      ]);
    });

    it('refuses to fetch the KEK over plain HTTP', () => {
      expect(
        issuesOf(() => loadApiKeys({ ...connectEnv, OP_CONNECT_URL: 'http://op-connect.internal:8080' }, 'production')),
      ).toEqual(['OP_CONNECT_URL: must use https in production']);
      expect(
        loadApiKeys({ ...connectEnv, OP_CONNECT_URL: 'http://op-connect.internal:8080' }, 'development').kek,
      ).toMatchObject({ kind: 'onepassword-connect' });
    });
  });

  it('never echoes a submitted value in its errors [R-LOG-02, E-08]', () => {
    const env = { ...connectEnv, OP_KEK_VAULT_ID: 'SecretVaultValue', RATE_LIMIT_KEY: 'SecretKeyValue!' };
    const issues = issuesOf(() => loadApiKeys(env, 'production')).join('\n');

    expect(issues).not.toContain('SecretVaultValue');
    expect(issues).not.toContain('SecretKeyValue');
    expect(issues).not.toContain('synthetic-connect-token');
  });
});

describe('loadWorkerKeys', () => {
  it('needs the KEK only', () => {
    expect(loadWorkerKeys({ KEK_SOURCE: 'env', LOCAL_KEK: localKek }, 'development')).toEqual({
      kek: { kind: 'env', localKek: Buffer.from(localKek, 'base64') },
    });
  });

  it('applies the same production rules to the KEK', () => {
    expect(issuesOf(() => loadWorkerKeys({ KEK_SOURCE: 'env', LOCAL_KEK: localKek }, 'production'))).toEqual([
      'KEK_SOURCE: env is not allowed in production; use onepassword-connect (R-ENC-05)',
    ]);
  });
});
