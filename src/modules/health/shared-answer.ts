import { performance } from 'node:perf_hooks';

/** Milliseconds on a clock that never goes back. */
export type MonotonicNow = () => number;

const processUptime: MonotonicNow = () => performance.now();

/**
 * One answer for everyone who asks while `check` runs, and for `reuseMs` after it ended: however many callers there
 * are, one check runs at a time and the next starts no sooner than `reuseMs` after the last one ended. A check that
 * fails leaves no answer behind.
 */
export function sharedAnswer<T>(
  check: () => Promise<T>,
  reuseMs: number,
  now: MonotonicNow = processUptime,
): () => Promise<T> {
  let running: Promise<T> | undefined;
  let last: { readonly answer: T; readonly until: number } | undefined;

  const run = async (): Promise<T> => {
    const answer = await check();
    last = { answer, until: now() + reuseMs };
    return answer;
  };
  const ended = (): void => {
    running = undefined;
  };

  return () => {
    if (last !== undefined && now() < last.until) return Promise.resolve(last.answer);
    if (running === undefined) {
      running = run();
      // Registered before any caller's own handler, so a caller that asks again from its handler starts a new check.
      running.then(ended, ended);
    }
    return running;
  };
}
