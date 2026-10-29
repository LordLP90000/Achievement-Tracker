import { describe, expect, it } from 'vitest';
import type { Transaction } from '../../platform/db/database.ts';
import { changeEmail } from './repository.ts';

/** A transaction whose savepoint fails with `error`; the update itself never runs. */
const failingSavepoint = (error: Error) => ({ transaction: () => Promise.reject(error) }) as unknown as Transaction;

const email = { emailEnc: Buffer.alloc(41), blindIndex: Buffer.alloc(32) };
const userId = '6f1c2a4e-8d3b-4c5a-9e7f-1a2b3c4d5e6f';
const now = new Date('2026-10-29T12:00:00Z');

describe('changeEmail error handling', () => {
  it('reports an address taken meanwhile (unique violation, wrapped by Drizzle) as false', async () => {
    const taken = new Error('Failed query', { cause: Object.assign(new Error('duplicate key'), { code: '23505' }) });

    await expect(changeEmail(failingSavepoint(taken), userId, email, now)).resolves.toBe(false);
  });

  it('lets every other failure through, so the request fails closed', async () => {
    const outage = new Error('connection terminated');

    await expect(changeEmail(failingSavepoint(outage), userId, email, now)).rejects.toBe(outage);
  });
});
