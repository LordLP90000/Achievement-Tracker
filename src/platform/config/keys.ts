import { decodeKeyMaterial } from '../crypto/key-material.ts';
import { ConfigError, type AppEnv, type Env } from './config.ts';

/**
 * Key material and the KEK source (architecture §4.1, ADR-0013). Issues name variables and rules, never values.
 * Production refuses a KEK from the environment: it must come from the 1Password Connect server (R-ENC-05).
 */

export type KekSourceConfig =
  | { readonly kind: 'env'; readonly localKek: Buffer }
  | {
      readonly kind: 'onepassword-connect';
      readonly url: URL;
      readonly token: string;
      readonly vaultId: string;
      readonly itemId: string;
    };

export interface WorkerKeys {
  readonly kek: KekSourceConfig;
}

export interface ApiKeys extends WorkerKeys {
  /** HMAC key of the email blind index (R-ENC-02). */
  readonly blindIndexKey: Buffer;
  /** HMAC key for rate-limit bucket names, so no raw IP address or email is stored (Q-14). */
  readonly rateLimitKey: Buffer;
}

const KEK_SOURCES = ['env', 'onepassword-connect'];
const ONEPASSWORD_ID = /^[a-z\d]{26}$/;

const value = (env: Env, name: string): string | undefined => (env[name] === '' ? undefined : env[name]);

function parseConnect(env: Env, appEnv: AppEnv, issues: string[]): KekSourceConfig | undefined {
  const required = (name: string): string | undefined => {
    const found = value(env, name);
    if (found === undefined) issues.push(`${name}: is required when KEK_SOURCE=onepassword-connect`);
    return found;
  };
  const rawUrl = required('OP_CONNECT_URL');
  const token = required('OP_CONNECT_TOKEN');
  const vaultId = required('OP_KEK_VAULT_ID');
  const itemId = required('OP_KEK_ITEM_ID');

  const url = rawUrl !== undefined && URL.canParse(rawUrl) ? new URL(rawUrl) : undefined;
  if (rawUrl !== undefined && !['http:', 'https:'].includes(url?.protocol ?? '')) {
    issues.push('OP_CONNECT_URL: must be an http(s) URL');
  } else if (appEnv === 'production' && url?.protocol === 'http:') {
    issues.push('OP_CONNECT_URL: must use https in production');
  }
  for (const [name, id] of [
    ['OP_KEK_VAULT_ID', vaultId],
    ['OP_KEK_ITEM_ID', itemId],
  ] as const) {
    if (id !== undefined && !ONEPASSWORD_ID.test(id)) {
      issues.push(`${name}: must be a 1Password ID (26 lower-case letters or digits)`);
    }
  }
  if (appEnv === 'production' && value(env, 'LOCAL_KEK') !== undefined) {
    issues.push('LOCAL_KEK: must not be set in production');
  }
  return url === undefined || token === undefined || vaultId === undefined || itemId === undefined
    ? undefined
    : { kind: 'onepassword-connect', url, token, vaultId, itemId };
}

function parseKek(env: Env, appEnv: AppEnv, issues: string[]): KekSourceConfig | undefined {
  const source = value(env, 'KEK_SOURCE');
  if (source === 'onepassword-connect') return parseConnect(env, appEnv, issues);
  if (source !== 'env') {
    issues.push(
      source === undefined ? 'KEK_SOURCE: is required' : `KEK_SOURCE: must be one of ${KEK_SOURCES.join(', ')}`,
    );
    return undefined;
  }
  if (appEnv === 'production') {
    issues.push('KEK_SOURCE: env is not allowed in production; use onepassword-connect (R-ENC-05)');
    return undefined;
  }
  const encoded = value(env, 'LOCAL_KEK');
  const localKek = encoded === undefined ? undefined : decodeKeyMaterial(encoded, 32, 32);
  if (localKek === undefined) {
    issues.push(
      `LOCAL_KEK: ${encoded === undefined ? 'is required when KEK_SOURCE=env' : 'must be exactly 32 random bytes in base64'}`,
    );
  }
  return localKek === undefined ? undefined : { kind: 'env', localKek };
}

function parseKey(env: Env, name: string, issues: string[], others: readonly Buffer[]): Buffer | undefined {
  const encoded = value(env, name);
  const key = encoded === undefined ? undefined : decodeKeyMaterial(encoded, 32, 64);
  if (key === undefined) {
    issues.push(`${name}: ${encoded === undefined ? 'is required' : 'must be 32 to 64 random bytes in base64'}`);
  } else if (others.some((other) => other.equals(key))) {
    issues.push(`${name}: must differ from the other keys`);
  }
  return key;
}

/** The KEKs a rotation needs (ADR-0020): the current one, as the processes load it, and the previous one if any. */
export interface RotationKeys {
  readonly current: KekSourceConfig;
  readonly previous: KekSourceConfig | undefined;
}

function parsePreviousKek(env: Env, current: KekSourceConfig, issues: string[]): KekSourceConfig | undefined {
  const local = value(env, 'PREVIOUS_LOCAL_KEK');
  const item = value(env, 'OP_PREVIOUS_KEK_ITEM_ID');
  if (current.kind === 'env') {
    if (item !== undefined) issues.push('OP_PREVIOUS_KEK_ITEM_ID: only with KEK_SOURCE=onepassword-connect');
    if (local === undefined) return undefined;
    const previousKek = decodeKeyMaterial(local, 32, 32);
    if (previousKek === undefined) {
      issues.push('PREVIOUS_LOCAL_KEK: must be exactly 32 random bytes in base64');
      return undefined;
    }
    if (previousKek.equals(current.localKek)) {
      issues.push('PREVIOUS_LOCAL_KEK: must differ from LOCAL_KEK');
      return undefined;
    }
    return { kind: 'env', localKek: previousKek };
  }
  if (local !== undefined) issues.push('PREVIOUS_LOCAL_KEK: only with KEK_SOURCE=env');
  if (item === undefined) return undefined;
  if (!ONEPASSWORD_ID.test(item)) {
    issues.push('OP_PREVIOUS_KEK_ITEM_ID: must be a 1Password ID (26 lower-case letters or digits)');
    return undefined;
  }
  if (item === current.itemId) {
    issues.push('OP_PREVIOUS_KEK_ITEM_ID: must differ from OP_KEK_ITEM_ID: a rotation creates a new item');
    return undefined;
  }
  return { ...current, itemId: item };
}

/** `rewrap-data-keys`: the previous KEK is a second local key, or another item in the vault of the current one. */
export function loadRotationKeys(env: Env, appEnv: AppEnv): RotationKeys {
  const issues: string[] = [];
  const current = parseKek(env, appEnv, issues);
  const previous = current === undefined ? undefined : parsePreviousKek(env, current, issues);
  if (issues.length > 0 || current === undefined) throw new ConfigError(issues);
  return Object.freeze({ current, previous });
}

/** The keys a blind-index rotation needs (ADR-0020): the KEK opens the addresses, which are indexed again. */
export interface ReindexKeys {
  readonly kek: KekSourceConfig;
  readonly blindIndexKey: Buffer;
  readonly previousBlindIndexKey: Buffer | undefined;
}

/** `reindex-email-blind-index`: the current KEK and blind-index key, as the API loads them, and the previous key. */
export function loadReindexKeys(env: Env, appEnv: AppEnv): ReindexKeys {
  const issues: string[] = [];
  const kek = parseKek(env, appEnv, issues);
  const used = kek?.kind === 'env' ? [kek.localKek] : [];
  const blindIndexKey = parseKey(env, 'BLIND_INDEX_KEY', issues, used);
  const previousBlindIndexKey =
    value(env, 'PREVIOUS_BLIND_INDEX_KEY') === undefined
      ? undefined
      : parseKey(env, 'PREVIOUS_BLIND_INDEX_KEY', issues, [...used, ...(blindIndexKey ? [blindIndexKey] : [])]);
  if (issues.length > 0 || kek === undefined || blindIndexKey === undefined) throw new ConfigError(issues);
  return Object.freeze({ kek, blindIndexKey, previousBlindIndexKey });
}

export function loadWorkerKeys(env: Env, appEnv: AppEnv): WorkerKeys {
  const issues: string[] = [];
  const kek = parseKek(env, appEnv, issues);
  if (issues.length > 0 || kek === undefined) throw new ConfigError(issues);
  return Object.freeze({ kek });
}

export function loadApiKeys(env: Env, appEnv: AppEnv): ApiKeys {
  const issues: string[] = [];
  const kek = parseKek(env, appEnv, issues);
  const used = kek?.kind === 'env' ? [kek.localKek] : [];
  const blindIndexKey = parseKey(env, 'BLIND_INDEX_KEY', issues, used);
  const rateLimitKey = parseKey(env, 'RATE_LIMIT_KEY', issues, [...used, ...(blindIndexKey ? [blindIndexKey] : [])]);
  if (issues.length > 0 || kek === undefined || blindIndexKey === undefined || rateLimitKey === undefined) {
    throw new ConfigError(issues);
  }
  return Object.freeze({ kek, blindIndexKey, rateLimitKey });
}
