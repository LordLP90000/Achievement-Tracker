import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptionError } from './aead.ts';
import { envKekSource } from './kek-source.ts';
import { generateDataKey, localKeyWrapper, UnknownKekError } from './key-wrapper.ts';

const newKek = () => envKekSource(randomBytes(32))();

describe('generateDataKey (ADR-0006)', () => {
  it('creates a fresh 32-byte data key in guarded memory', () => {
    const first = generateDataKey();
    const second = generateDataKey();

    expect(first).toHaveLength(32);
    expect(first.secure).toBe(true);
    expect(Buffer.from(first)).not.toEqual(Buffer.from(second));
  });
});

describe('localKeyWrapper (ADR-0006, ADR-0013) [R-ENC-01]', () => {
  it('wraps a data key for its user and unwraps it into guarded memory', async () => {
    const wrapper = localKeyWrapper(await newKek());
    const userId = randomUUID();
    const dek = generateDataKey();

    const wrapped = wrapper.wrap(dek, userId);
    const unwrapped = wrapper.unwrap(wrapped, userId);

    expect(wrapped.blob.includes(Buffer.from(dek))).toBe(false);
    expect(wrapped).toMatchObject({ kekId: 'local', kekVersion: 1 });
    expect(Buffer.from(unwrapped)).toEqual(Buffer.from(dek));
    expect(unwrapped.secure).toBe(true);
  });

  it('cannot unwrap a data key for another user', async () => {
    const wrapper = localKeyWrapper(await newKek());
    const wrapped = wrapper.wrap(generateDataKey(), randomUUID());

    expect(() => wrapper.unwrap(wrapped, randomUUID())).toThrow(DecryptionError);
  });

  it('cannot unwrap with another KEK of the same name, e.g. after the KEK was replaced', async () => {
    const userId = randomUUID();
    const wrapped = localKeyWrapper(await newKek()).wrap(generateDataKey(), userId);
    const replaced = localKeyWrapper(await newKek());

    expect(() => replaced.unwrap(wrapped, userId)).toThrow(DecryptionError);
  });

  it.each([
    { kekId: 'onepassword:other', kekVersion: 1 },
    { kekId: 'local', kekVersion: 2 },
  ])('refuses a data key wrapped by another KEK or version %j before trying to decrypt', async (origin) => {
    const wrapper = localKeyWrapper(await newKek());
    const userId = randomUUID();
    const wrapped = { ...wrapper.wrap(generateDataKey(), userId), ...origin };

    expect(() => wrapper.unwrap(wrapped, userId)).toThrow(UnknownKekError);
    expect(new UnknownKekError().name).toBe('UnknownKekError');
    expect(new UnknownKekError().message).toBe('data key was wrapped by an unknown KEK');
  });

  it('treats a damaged wrapped key of any length as a decryption failure', async () => {
    const wrapper = localKeyWrapper(await newKek());
    const userId = randomUUID();
    const wrapped = wrapper.wrap(generateDataKey(), userId);

    for (const blob of [wrapped.blob.subarray(0, 72), Buffer.concat([wrapped.blob, Buffer.alloc(1)])]) {
      expect(() => wrapper.unwrap({ ...wrapped, blob }, userId)).toThrow(DecryptionError);
    }
  });

  it('refuses to wrap anything but a 32-byte key', async () => {
    const wrapper = localKeyWrapper(await newKek());

    expect(() => wrapper.wrap(randomBytes(16), randomUUID())).toThrow(new RangeError('a data key must be 32 bytes'));
  });
});
