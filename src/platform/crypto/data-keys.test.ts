import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptionError } from './aead.ts';
import { createDataKeys } from './data-keys.ts';
import { decryptText, encryptText } from './field-cipher.ts';
import { envKekSource } from './kek-source.ts';
import { localKeyWrapper } from './key-wrapper.ts';

const newDataKeys = async () => createDataKeys(localKeyWrapper(await envKekSource(randomBytes(32))()));
const isWiped = (key: Uint8Array) => key.every((byte) => byte === 0);

describe('encryptText and decryptText (field encryption, ADR-0006) [R-ENC-01]', () => {
  const key = randomBytes(32);
  const context = { userId: randomUUID(), recordId: randomUUID(), field: 'email_enc' };

  it.each(['alice@example.test', 'Zoë 🐉 über Zürich', ''])('round-trips %j', (value) => {
    const blob = encryptText(key, context, value);

    expect(blob.includes(Buffer.from(value))).toBe(value === '');
    expect(decryptText(key, context, blob)).toBe(value);
  });

  it('only decrypts in the row and column the value was written for', () => {
    const blob = encryptText(key, context, 'alice@example.test');

    expect(() => decryptText(key, { ...context, field: 'nickname_enc' }, blob)).toThrow(DecryptionError);
    expect(() => decryptText(key, { ...context, recordId: randomUUID() }, blob)).toThrow(DecryptionError);
  });
});

describe('data keys (ADR-0006: plaintext data keys live only for one unit of work)', () => {
  it('creates a guarded data key and its wrapped form, and wipes the key afterwards', async () => {
    const dataKeys = await newDataKeys();
    const userId = randomUUID();
    let seen: Uint8Array = new Uint8Array();

    const result = await dataKeys.withNewKey(userId, (key, wrapped) => {
      seen = key;
      expect(key.secure).toBe(true);
      expect(isWiped(key)).toBe(false);
      return Promise.resolve({
        blob: encryptText(key, { userId, recordId: userId, field: 'email_enc' }, 'x'),
        wrapped,
      });
    });

    expect(isWiped(seen)).toBe(true);
    const reopened = await dataKeys.withKey(userId, result.wrapped, (key) =>
      Promise.resolve(decryptText(key, { userId, recordId: userId, field: 'email_enc' }, result.blob)),
    );
    expect(reopened).toBe('x');
  });

  it('wipes an unwrapped key even when the work fails', async () => {
    const dataKeys = await newDataKeys();
    const userId = randomUUID();
    const wrapped = await dataKeys.withNewKey(userId, (_key, created) => Promise.resolve(created));
    let seen: Uint8Array = new Uint8Array();

    await expect(
      dataKeys.withKey(userId, wrapped, (key) => {
        seen = key;
        return Promise.reject(new Error('work failed'));
      }),
    ).rejects.toThrow('work failed');
    expect(seen).toHaveLength(32);
    expect(isWiped(seen)).toBe(true);
  });

  it("refuses another user's wrapped key without running the work", async () => {
    const dataKeys = await newDataKeys();
    const wrapped = await dataKeys.withNewKey(randomUUID(), (_key, created) => Promise.resolve(created));
    let ran = false;

    await expect(
      dataKeys.withKey(randomUUID(), wrapped, () => {
        ran = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow(DecryptionError);
    expect(ran).toBe(false);
  });
});
