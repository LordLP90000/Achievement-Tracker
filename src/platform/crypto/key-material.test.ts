import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { decodeKeyMaterial } from './key-material.ts';

describe('decodeKeyMaterial [R-ENC-05]', () => {
  it.each([
    ['is too short', randomBytes(31)],
    ['is too long', randomBytes(33)],
    ['repeats one byte', Buffer.alloc(32, 7)],
  ])('wipes the decoded bytes of a key it refuses because it %s', (_reason, key) => {
    const encoded = key.toString('base64');
    const from = vi.spyOn(Buffer, 'from');

    const decoded = decodeKeyMaterial(encoded, 32, 32);

    const call = (from.mock.calls as unknown[][]).findIndex(([value]) => value === encoded);
    const bytes = from.mock.results[call]?.value as Buffer;
    expect(decoded).toBeUndefined();
    expect([bytes.length, bytes.every((byte) => byte === 0)]).toEqual([key.length, true]);
  });

  it('returns the bytes of a key it accepts, in base64 or base64url', () => {
    const key = randomBytes(48);

    expect([
      decodeKeyMaterial(key.toString('base64'), 32, 64),
      decodeKeyMaterial(key.toString('base64url'), 32, 64),
    ]).toEqual([key, key]);
  });
});
