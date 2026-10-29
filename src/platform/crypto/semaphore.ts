/** Too many operations waiting: the caller answers 503/429 instead of letting a flood exhaust memory (D-01). */
export class SemaphoreFullError extends Error {
  override readonly name = 'SemaphoreFullError';

  constructor() {
    super('too many concurrent operations');
  }
}

/** Limits concurrent work (e.g. 64 MiB Argon2id hashes) and bounds the queue behind it. */
export class Semaphore {
  readonly #maxConcurrent: number;
  readonly #maxQueued: number;
  readonly #queue: (() => void)[] = [];
  #active = 0;

  constructor(maxConcurrent: number, maxQueued: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError('maxConcurrent must be a positive integer');
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new RangeError('maxQueued must be a non-negative integer');
    }
    this.#maxConcurrent = maxConcurrent;
    this.#maxQueued = maxQueued;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#maxConcurrent) {
      this.#active += 1;
      return Promise.resolve();
    }
    if (this.#queue.length >= this.#maxQueued) return Promise.reject(new SemaphoreFullError());
    return new Promise((resolve) => {
      this.#queue.push(resolve);
    });
  }

  /** Hands the slot straight to the next waiter, so the number of active tasks never exceeds the limit. */
  #release(): void {
    const next = this.#queue.shift();
    if (next === undefined) this.#active -= 1;
    else next();
  }
}
