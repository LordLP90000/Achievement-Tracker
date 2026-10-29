import { describe, expect, it } from 'vitest';
import { Semaphore, SemaphoreFullError } from './semaphore.ts';

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('Semaphore (threat D-01: bounded password hashing)', () => {
  it('runs at most maxConcurrent tasks at once and queues the rest in order', async () => {
    const semaphore = new Semaphore(2, 10);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((gate, index) =>
      semaphore.run(async () => {
        started.push(index);
        await gate.promise;
        return index;
      }),
    );

    await flush();
    expect(started).toEqual([0, 1]);

    gates[1]?.resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);

    gates[0]?.resolve();
    gates[2]?.resolve();
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2]);
  });

  it('refuses work beyond the queue instead of growing without bound', async () => {
    const semaphore = new Semaphore(1, 1);
    const gate = deferred();
    const running = semaphore.run(() => gate.promise);
    const queued = semaphore.run(() => Promise.resolve('queued'));

    await expect(semaphore.run(() => Promise.resolve('third'))).rejects.toBeInstanceOf(SemaphoreFullError);

    gate.resolve();
    await running;
    await expect(queued).resolves.toBe('queued');
  });

  it('frees the slot when a task fails', async () => {
    const semaphore = new Semaphore(1, 0);

    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(semaphore.run(() => Promise.resolve('next'))).resolves.toBe('next');
  });

  it('names its error, the only detail the log keeps', () => {
    expect(new SemaphoreFullError().name).toBe('SemaphoreFullError');
    expect(new SemaphoreFullError().message).toBe('too many concurrent operations');
  });

  it.each([
    [0, 1, 'maxConcurrent must be a positive integer'],
    [1.5, 1, 'maxConcurrent must be a positive integer'],
    [1, -1, 'maxQueued must be a non-negative integer'],
    [1, 0.5, 'maxQueued must be a non-negative integer'],
  ])('refuses maxConcurrent %s and maxQueued %s', (maxConcurrent, maxQueued, message) => {
    expect(() => new Semaphore(maxConcurrent, maxQueued)).toThrow(new RangeError(message));
  });
});
