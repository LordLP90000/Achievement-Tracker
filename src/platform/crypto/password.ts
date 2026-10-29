import { randomBytes } from 'node:crypto';
import sodium from 'sodium-native';
import { Semaphore } from './semaphore.ts';

/** Argon2id password hashing (ADR-0005, R-AUTH-02), bounded by a semaphore against hashing floods (D-01). */

export const ARGON2ID_POLICY = Object.freeze({ opslimit: 3, memlimitBytes: 64 * 1024 * 1024 });

export interface PasswordHasher {
  /** PHC string (`$argon2id$v=19$m=65536,t=3,p=1$…`) of the NFKC-normalised password. */
  hash(password: string): Promise<string>;
  /** Pass `undefined` for an unknown account: the same work is done against a dummy hash and the answer is false. */
  verify(storedHash: string | undefined, password: string): Promise<boolean>;
  /** True when a stored hash uses weaker parameters (or is unreadable); rehash after the next successful login. */
  needsRehash(storedHash: string): boolean;
}

export interface PasswordHasherOptions {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
}

/** libsodium's fixed buffer for PHC strings, including the terminating NUL. */
const PHC_BYTES = sodium.crypto_pwhash_STRBYTES;

function phcBuffer(stored: string): Buffer | undefined {
  const bytes = Buffer.from(stored, 'utf8');
  if (bytes.length >= PHC_BYTES) return undefined;
  const buffer = Buffer.alloc(PHC_BYTES);
  bytes.copy(buffer);
  return buffer;
}

export async function createArgon2idHasher(options: PasswordHasherOptions): Promise<PasswordHasher> {
  const semaphore = new Semaphore(options.maxConcurrent, options.maxQueued);

  const hash = (password: string): Promise<string> =>
    semaphore.run(async () => {
      const secret = Buffer.from(password.normalize('NFKC'), 'utf8');
      const out = Buffer.alloc(PHC_BYTES);
      try {
        await sodium.crypto_pwhash_str_async(out, secret, ARGON2ID_POLICY.opslimit, ARGON2ID_POLICY.memlimitBytes);
      } finally {
        sodium.sodium_memzero(secret);
      }
      return out.subarray(0, out.indexOf(0)).toString('utf8');
    });

  const dummy = phcBuffer(await hash(randomBytes(32).toString('base64url'))) ?? Buffer.alloc(PHC_BYTES);

  const verify = (storedHash: string | undefined, password: string): Promise<boolean> =>
    semaphore.run(async () => {
      const stored = storedHash === undefined ? undefined : phcBuffer(storedHash);
      const secret = Buffer.from(password.normalize('NFKC'), 'utf8');
      try {
        // libsodium refuses empty input; an empty password still costs one full verification and never matches.
        const input = secret.length > 0 ? secret : Buffer.alloc(1);
        const matches = await sodium.crypto_pwhash_str_verify_async(stored ?? dummy, input);
        return matches && stored !== undefined && secret.length > 0;
      } finally {
        sodium.sodium_memzero(secret);
      }
    });

  const needsRehash = (storedHash: string): boolean => {
    const stored = phcBuffer(storedHash);
    return (
      stored === undefined ||
      sodium.crypto_pwhash_str_needs_rehash(stored, ARGON2ID_POLICY.opslimit, ARGON2ID_POLICY.memlimitBytes)
    );
  };

  return { hash, verify, needsRehash };
}
