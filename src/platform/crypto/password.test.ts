import sodium from 'sodium-native';
import { describe, expect, it, vi } from 'vitest';
import { ARGON2ID_POLICY, createArgon2idHasher } from './password.ts';
import { SemaphoreFullError } from './semaphore.ts';

const PASSWORD = 'correct horse battery staple';
const PHC = /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[\w+/]+\$[\w+/]+$/;
const isWiped = (buffer: Uint8Array) => buffer.every((byte) => byte === 0);

function legacyHash(password: string, opslimit: number, memlimit: number): string {
  const out = Buffer.alloc(sodium.crypto_pwhash_STRBYTES);
  sodium.crypto_pwhash_str(out, Buffer.from(password, 'utf8'), opslimit, memlimit);
  return out.toString('utf8').replace(/\0+$/, '');
}

describe('Argon2id password hasher (ADR-0005) [R-AUTH-02]', () => {
  // A new hasher per test, so mutants inside its factory run within the test that covers them.
  const newHasher = () => createArgon2idHasher({ maxConcurrent: 2, maxQueued: 8 });

  it('uses at least OWASP parameters: Argon2id, m = 64 MiB, t = 3, p = 1', async () => {
    const hasher = await newHasher();

    expect(ARGON2ID_POLICY).toEqual({ opslimit: 3, memlimitBytes: 64 * 1024 * 1024 });
    expect(await hasher.hash(PASSWORD)).toMatch(PHC);
  });

  it('salts every hash and verifies only the right password', async () => {
    const hasher = await newHasher();
    const first = await hasher.hash(PASSWORD);
    const second = await hasher.hash(PASSWORD);

    expect(first).not.toBe(second);
    expect(await hasher.verify(first, PASSWORD)).toBe(true);
    expect(await hasher.verify(second, PASSWORD)).toBe(true);
    expect(await hasher.verify(first, `${PASSWORD}!`)).toBe(false);
  });

  it('normalises to NFKC, so composed and decomposed spellings are the same password', async () => {
    const hasher = await newHasher();
    const stored = await hasher.hash('caf\u00e9 au lait, s\u2019il vous pla\u00eet');

    expect(await hasher.verify(stored, 'cafe\u0301 au lait, s\u2019il vous plai\u0302t')).toBe(true);
  });

  it('never truncates: passwords differing only at character 120 are different', async () => {
    const hasher = await newHasher();
    const long = 'a'.repeat(119);
    const stored = await hasher.hash(`${long}b`);

    expect(await hasher.verify(stored, `${long}c`)).toBe(false);
  });

  it('answers false for an unknown account after the same work: one verification against a real hash with the same parameters', async () => {
    const hasher = await newHasher();
    const verification = vi.spyOn(sodium, 'crypto_pwhash_str_verify_async');

    expect(await hasher.verify(undefined, PASSWORD)).toBe(false);
    expect(verification).toHaveBeenCalledTimes(1);
    const [dummy] = verification.mock.calls[0] ?? [];
    const dummyHash = Buffer.from(dummy ?? []).toString();
    expect(dummyHash.replace(/\0+$/, '')).toMatch(PHC);
  });

  it('refuses a stored hash that does not fit the PHC buffer, even when it starts with a valid hash', async () => {
    const hasher = await newHasher();
    const valid = await hasher.hash(PASSWORD);
    // Exactly the buffer size: a NUL right after the valid hash would end the string if the length were not checked.
    const oversized = `${valid}\u0000${'x'.repeat(sodium.crypto_pwhash_STRBYTES - valid.length - 1)}`;

    expect(Buffer.byteLength(oversized)).toBe(sodium.crypto_pwhash_STRBYTES);
    expect(await hasher.verify(oversized, PASSWORD)).toBe(false);
    expect(await hasher.verify(`${oversized}x`, PASSWORD)).toBe(false);
    expect(hasher.needsRehash(oversized)).toBe(true);
  });

  it('wipes its copy of the password after hashing and after every verification', async () => {
    const hasher = await newHasher();
    const hashing = vi.spyOn(sodium, 'crypto_pwhash_str_async');
    const verification = vi.spyOn(sodium, 'crypto_pwhash_str_verify_async');

    const stored = await hasher.hash(PASSWORD);
    await hasher.verify(stored, PASSWORD);
    await hasher.verify(undefined, PASSWORD);

    const copies = [...hashing.mock.calls, ...verification.mock.calls].map(([, password]) => password);
    expect(copies).toHaveLength(3);
    for (const copy of copies) {
      expect(copy).toHaveLength(Buffer.byteLength(PASSWORD));
      expect(isWiped(copy)).toBe(true);
    }
  });

  it('answers false for a malformed stored hash instead of throwing', async () => {
    const hasher = await newHasher();

    expect(await hasher.verify('$argon2id$v=19$garbage', PASSWORD)).toBe(false);
    expect(await hasher.verify('x'.repeat(127), PASSWORD)).toBe(false);
    expect(await hasher.verify('x'.repeat(128), PASSWORD)).toBe(false);
    expect(await hasher.verify('x'.repeat(200), PASSWORD)).toBe(false);
  });

  it('never accepts an empty password, not even against the hash of a single NUL byte', async () => {
    const hasher = await newHasher();
    const nulHash = await hasher.hash('\u0000');

    expect(await hasher.verify(nulHash, '\u0000')).toBe(true);
    expect(await hasher.verify(nulHash, '')).toBe(false);
    expect(await hasher.verify(undefined, '')).toBe(false);
  });

  it('asks for a rehash when a stored hash used weaker parameters, so they can be raised on login', async () => {
    const hasher = await newHasher();

    expect(hasher.needsRehash(await hasher.hash(PASSWORD))).toBe(false);
    expect(hasher.needsRehash(legacyHash(PASSWORD, 2, 19 * 1024 * 1024))).toBe(true);
    expect(hasher.needsRehash('not a hash')).toBe(true);
    expect(hasher.needsRehash('x'.repeat(200))).toBe(true);
  });

  it('rejects work beyond its queue instead of letting a flood exhaust memory [D-01]', async () => {
    const hasher = await createArgon2idHasher({ maxConcurrent: 1, maxQueued: 1 });
    const attempts = [hasher.hash(PASSWORD), hasher.hash(PASSWORD), hasher.hash(PASSWORD)];

    const results = await Promise.allSettled(attempts);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(results[2]).toMatchObject({ status: 'rejected', reason: expect.any(SemaphoreFullError) as unknown });
  });
});
