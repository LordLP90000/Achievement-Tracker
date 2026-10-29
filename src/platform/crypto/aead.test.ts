import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AEAD_KEY_BYTES,
  DecryptionError,
  fieldAssociatedData,
  keyWrapAssociatedData,
  open,
  seal,
  type FieldContext,
} from './aead.ts';

const hex = (value: string) => Buffer.from(value.replaceAll(/\s+/g, ''), 'hex');

/** Official test vector of draft-irtf-cfrg-xchacha-03, appendix A.1 (AEAD_XChaCha20_Poly1305). */
const VECTOR = {
  key: hex('808182838485868788898a8b8c8d8e8f 909192939495969798999a9b9c9d9e9f'),
  nonce: hex('404142434445464748494a4b4c4d4e4f 5051525354555657'),
  aad: hex('50515253c0c1c2c3c4c5c6c7'),
  plaintext:
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
  ciphertext: hex(`
    bd6d179d3e83d43b9576579493c0e939 572a1700252bfaccbed2902c21396cbb 731c7f1b0b4aa6440bf3a82f4eda7e39
    ae64c6708c54c216cb96b72e1213b452 2f8c9ba40db5d945b11b69b982c1bb9e 3f3fac2bc369488f76b2383565d3fff9
    21f9664c97637da9768812f615c68b13 b52e`),
  tag: hex('c0875924c1c7987947deafd8780acf49'),
};

const newKey = () => randomBytes(AEAD_KEY_BYTES);
const context = (): FieldContext => ({ userId: randomUUID(), recordId: randomUUID(), field: 'email_enc' });

describe('seal and open (XChaCha20-Poly1305, ADR-0006) [R-ENC-01]', () => {
  it('opens the official draft-irtf-cfrg-xchacha-03 A.1 vector laid out in our blob format', () => {
    const blob = Buffer.concat([Buffer.from([0x01]), VECTOR.nonce, VECTOR.ciphertext, VECTOR.tag]);

    expect(open(VECTOR.key, blob, VECTOR.aad).toString('utf8')).toBe(VECTOR.plaintext);
  });

  it('lays a sealed value out as version 0x01, 24-byte nonce, ciphertext and 16-byte tag', () => {
    const key = newKey();
    const ad = fieldAssociatedData(context());
    const plaintext = Buffer.from('alice@example.test');

    const blob = seal(key, plaintext, ad);

    expect(blob[0]).toBe(0x01);
    expect(blob).toHaveLength(1 + 24 + plaintext.length + 16);
    expect(blob.includes(plaintext)).toBe(false);
    expect(open(key, blob, ad)).toEqual(plaintext);
  });

  it('round-trips an empty value', () => {
    const key = newKey();
    const ad = fieldAssociatedData(context());

    expect(open(key, seal(key, Buffer.alloc(0), ad), ad)).toHaveLength(0);
  });

  it('uses a fresh random nonce for every value', () => {
    const key = newKey();
    const ad = fieldAssociatedData(context());
    const blobs = Array.from({ length: 1000 }, () => seal(key, Buffer.from('same value'), ad));

    expect(new Set(blobs.map((blob) => blob.subarray(1, 25).toString('hex'))).size).toBe(1000);
    expect(new Set(blobs.map((blob) => blob.toString('hex'))).size).toBe(1000);
  });

  it('rejects a single flipped bit anywhere in the blob, including version, nonce and tag', () => {
    const key = newKey();
    const ad = fieldAssociatedData(context());
    const blob = seal(key, Buffer.from('tamper-evident'), ad);

    for (let index = 0; index < blob.length; index += 1) {
      const tampered = Buffer.from(blob);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      expect(() => open(key, tampered, ad), `byte ${String(index)}`).toThrow(DecryptionError);
    }
  });

  it('rejects the wrong key and the wrong associated data with the same uninformative error', () => {
    const key = newKey();
    const blob = seal(key, Buffer.from('secret goal'), fieldAssociatedData(context()));

    const failures = [
      () => open(newKey(), blob, fieldAssociatedData(context())),
      () => open(key, blob, fieldAssociatedData(context())),
      () => open(key, Buffer.alloc(0), fieldAssociatedData(context())),
      () => open(key, blob.subarray(0, 40), fieldAssociatedData(context())),
    ];
    for (const attempt of failures) {
      expect(attempt).toThrow(DecryptionError);
      expect(attempt).toThrow(/^decryption failed$/);
    }
  });

  it('rejects blobs too short to hold version, nonce and tag', () => {
    const key = newKey();
    const ad = fieldAssociatedData(context());

    for (const length of [0, 1, 25, 40]) {
      expect(() => open(key, Buffer.alloc(length, 1), ad)).toThrow(DecryptionError);
    }
  });

  it('refuses keys that are not exactly 32 bytes, a programming error rather than a decryption failure', () => {
    const ad = fieldAssociatedData(context());

    expect(() => seal(Buffer.alloc(31), Buffer.from('x'), ad)).toThrow(new RangeError('key must be 32 bytes'));
    expect(() => open(Buffer.alloc(33), Buffer.alloc(41), ad)).toThrow(new RangeError('key must be 32 bytes'));
  });

  it('names the error DecryptionError: the error name is the only detail the log keeps [I-02]', () => {
    expect(new DecryptionError().name).toBe('DecryptionError');
  });

  it('decrypts into a caller-provided buffer such as guarded memory, and only of the exact size', () => {
    const key = newKey();
    const ad = fieldAssociatedData(context());
    const plaintext = randomBytes(32);
    const blob = seal(key, plaintext, ad);

    const out = Buffer.alloc(32);
    expect(open(key, blob, ad, out)).toBe(out);
    expect(out).toEqual(plaintext);
    expect(() => open(key, blob, ad, Buffer.alloc(31))).toThrow(new RangeError('out must be exactly 32 bytes'));
  });
});

describe('associated data (ADR-0006, ADR-0013)', () => {
  const userId = '0b5ac6f2-7d6f-4b8a-9d61-2f4f0f3c1a11';
  const recordId = 'f3d2c1b0-a9e8-4d7c-b6a5-948372615049';

  it('binds a field to its user, record and column', () => {
    expect(fieldAssociatedData({ userId, recordId, field: 'nickname_enc' }).toString()).toBe(
      `questline|v1|${userId}|${recordId}|nickname_enc`,
    );
  });

  it('binds a wrapped data key to its user, separate from any field', () => {
    expect(keyWrapAssociatedData(userId).toString()).toBe(`questline|v1|dek|${userId}`);
  });

  it.each([
    [{ userId: 'not-a-uuid', recordId, field: 'email_enc' }, 'userId must be a lower-case UUID v4'],
    [{ userId: userId.toUpperCase(), recordId, field: 'email_enc' }, 'userId must be a lower-case UUID v4'],
    [
      { userId: userId.replace('-4b8a-', '-1b8a-'), recordId, field: 'email_enc' },
      'userId must be a lower-case UUID v4',
    ],
    [
      { userId: userId.replace('-9d61-', '-7d61-'), recordId, field: 'email_enc' },
      'userId must be a lower-case UUID v4',
    ],
    [{ userId, recordId: `${recordId}|x`, field: 'email_enc' }, 'recordId must be a lower-case UUID v4'],
    [{ userId, recordId, field: 'email|enc' }, 'field must be a lower-case column name'],
    [{ userId, recordId, field: 'Email_enc' }, 'field must be a lower-case column name'],
    [{ userId, recordId, field: '' }, 'field must be a lower-case column name'],
  ])('refuses ambiguous parts %j', (parts, message) => {
    expect(() => fieldAssociatedData(parts)).toThrow(new RangeError(message));
  });

  it('refuses a wrapped-key user id that is not a UUID', () => {
    expect(() => keyWrapAssociatedData('dek|someone')).toThrow(new RangeError('userId must be a lower-case UUID v4'));
  });

  it('cannot open a value as another user, record or column', () => {
    const key = newKey();
    const original = { userId, recordId, field: 'email_enc' };
    const blob = seal(key, Buffer.from('alice@example.test'), fieldAssociatedData(original));

    for (const other of [
      { ...original, userId: randomUUID() },
      { ...original, recordId: randomUUID() },
      { ...original, field: 'nickname_enc' },
    ]) {
      expect(() => open(key, blob, fieldAssociatedData(other))).toThrow(DecryptionError);
    }
  });
});
