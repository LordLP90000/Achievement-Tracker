import { randomBytes, randomUUID } from 'node:crypto';
import sodium from 'sodium-native';
import { describe, expect, it, vi } from 'vitest';
import { envKekSource, type Kek } from './kek-source.ts';
import { rewrapDataKey } from './key-rotation.ts';
import { generateDataKey, localKeyWrapper } from './key-wrapper.ts';

const newKek = () => envKekSource(randomBytes(32))();
/** A KEK as the 1Password Connect source labels it: its item, and the item's version. */
const itemKek = async (item: string, version = 1): Promise<Kek> => ({ ...(await newKek()), id: item, version });

/** Re-wrapping a data key under a new KEK (ADR-0020, Q-56): the KEK rotation's core. */
describe('rewrapDataKey (ADR-0020) [R-ENC-01, E-11]', () => {
  it('leaves a data key the current KEK opens and is labelled with', async () => {
    const current = await itemKek('onepassword:vault/new');
    const userId = randomUUID();
    const wrapped = localKeyWrapper(current).wrap(generateDataKey(), userId);

    expect(rewrapDataKey(wrapped, userId, current, [await itemKek('onepassword:vault/old')])).toEqual({
      outcome: 'current',
    });
  });

  it('re-wraps a data key of the previous KEK under the current one, with the current labels', async () => {
    const [previous, current] = [await itemKek('onepassword:vault/old', 3), await itemKek('onepassword:vault/new', 1)];
    const userId = randomUUID();
    const dataKey = generateDataKey();
    const wrapped = localKeyWrapper(previous).wrap(dataKey, userId);

    const result = rewrapDataKey(wrapped, userId, current, [previous]);

    expect(result).toMatchObject({
      outcome: 'rewrapped',
      wrapped: { kekId: 'onepassword:vault/new', kekVersion: 1 },
    });
    if (result.outcome !== 'rewrapped') throw new Error('not re-wrapped');
    expect(Buffer.from(localKeyWrapper(current).unwrap(result.wrapped, userId))).toEqual(Buffer.from(dataKey));
    expect(result.wrapped.blob.equals(wrapped.blob)).toBe(false);
  });

  it('lets the key decide, not the label: a local rotation, where both KEKs are labelled local', async () => {
    const [previous, current] = [await newKek(), await newKek()];
    const userId = randomUUID();
    const dataKey = generateDataKey();
    const wrapped = localKeyWrapper(previous).wrap(dataKey, userId);

    const result = rewrapDataKey(wrapped, userId, current, [previous]);

    if (result.outcome !== 'rewrapped') throw new Error(`not re-wrapped: ${result.outcome}`);
    expect(Buffer.from(localKeyWrapper(current).unwrap(result.wrapped, userId))).toEqual(Buffer.from(dataKey));
  });

  it('relabels a data key the current KEK opens under another label', async () => {
    const current = await itemKek('onepassword:vault/new', 2);
    const userId = randomUUID();
    const dataKey = generateDataKey();
    const wrapped = {
      ...localKeyWrapper(current).wrap(dataKey, userId),
      kekId: 'onepassword:vault/old',
      kekVersion: 7,
    };

    const result = rewrapDataKey(wrapped, userId, current, []);

    expect(result).toMatchObject({ outcome: 'rewrapped', wrapped: { kekId: 'onepassword:vault/new', kekVersion: 2 } });
    if (result.outcome !== 'rewrapped') throw new Error('not re-wrapped');
    expect(Buffer.from(localKeyWrapper(current).unwrap(result.wrapped, userId))).toEqual(Buffer.from(dataKey));
  });

  it('keeps a data key the current item opens though its version moved on: an edit of the item changes no key', async () => {
    const current = await itemKek('onepassword:vault/new', 5);
    const userId = randomUUID();
    const wrapped = localKeyWrapper({ ...current, version: 4 }).wrap(generateDataKey(), userId);

    expect(rewrapDataKey(wrapped, userId, current, [])).toEqual({ outcome: 'current' });
  });

  it('reports a data key no given KEK opens, and one wrapped for another user', async () => {
    const [current, previous, unknown] = [await newKek(), await newKek(), await newKek()];
    const userId = randomUUID();
    const foreign = localKeyWrapper(unknown).wrap(generateDataKey(), userId);
    const otherUsers = localKeyWrapper(previous).wrap(generateDataKey(), randomUUID());

    expect(rewrapDataKey(foreign, userId, current, [previous])).toEqual({ outcome: 'unknown' });
    expect(rewrapDataKey(otherUsers, userId, current, [previous])).toEqual({ outcome: 'unknown' });
  });

  it('wipes the opened data key, re-wrapped or not, so it outlives the call nowhere', async () => {
    const [previous, current] = [await newKek(), await newKek()];
    const userId = randomUUID();
    const wipe = vi.spyOn(sodium, 'sodium_memzero');

    rewrapDataKey(localKeyWrapper(previous).wrap(generateDataKey(), userId), userId, current, [previous]);
    rewrapDataKey(localKeyWrapper(current).wrap(generateDataKey(), userId), userId, current, [previous]);

    const wiped = wipe.mock.calls.map(([buffer]) => buffer).filter((buffer) => buffer.length === 32);
    expect(wiped).toHaveLength(2);
    expect(wiped.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
  });

  it('fails on a malformed user ID instead of calling the key unknown', async () => {
    const current = await newKek();
    const wrapped = localKeyWrapper(current).wrap(generateDataKey(), randomUUID());

    expect(() => rewrapDataKey(wrapped, 'NOT-A-UUID', current, [])).toThrow(RangeError);
  });

  it('treats a damaged wrapped key as unknown, not as an error', async () => {
    const current = await newKek();
    const userId = randomUUID();
    const wrapped = localKeyWrapper(current).wrap(generateDataKey(), userId);

    expect(rewrapDataKey({ ...wrapped, blob: wrapped.blob.subarray(1) }, userId, current, [])).toEqual({
      outcome: 'unknown',
    });
  });
});
