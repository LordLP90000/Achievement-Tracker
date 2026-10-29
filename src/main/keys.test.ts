import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KekSourceError } from '../platform/crypto/kek-source.ts';
import { CONNECT_TIMEOUT_MS, kekSourceFor } from './keys.ts';

describe('kekSourceFor (ADR-0013)', () => {
  it('uses the local key for KEK_SOURCE=env', async () => {
    const localKek = randomBytes(32);
    const expected = Buffer.from(localKek);

    const kek = await kekSourceFor({ kind: 'env', localKek })();

    expect(kek).toMatchObject({ id: 'local', version: 1 });
    expect(Buffer.from(kek.key)).toEqual(expected);
  });

  it('asks the 1Password Connect server for KEK_SOURCE=onepassword-connect, with a bounded wait', async () => {
    const source = kekSourceFor({
      kind: 'onepassword-connect',
      url: new URL('http://127.0.0.1:9'),
      token: 'synthetic-connect-token',
      vaultId: 'a1b2c3d4e5f6g7h8i9j0k1l2m3',
      itemId: 'z9y8x7w6v5u4t3s2r1q0p9o8n7',
    });

    await expect(source()).rejects.toEqual(new KekSourceError('connect_unreachable'));
    expect(CONNECT_TIMEOUT_MS).toBe(5000);
  });
});
