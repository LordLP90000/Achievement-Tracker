import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPoller } from './poller.ts';

describe('startPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the task at once and then once per interval', async () => {
    const task = vi.fn(() => Promise.resolve());
    const poller = startPoller(task, 1000, () => undefined);

    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(task).toHaveBeenCalledTimes(5);
    await poller.stop();
  });

  it('never runs the task twice at once: ticks during a slow run are skipped', async () => {
    let finish: () => void = () => undefined;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const poller = startPoller(task, 1000, () => undefined);

    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
    finish();
    await poller.stop();
  });

  it('reports a failed run and keeps polling', async () => {
    const failure = new Error('database unavailable');
    const task = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const onError = vi.fn();
    const poller = startPoller(task, 1000, onError);

    await vi.advanceTimersByTimeAsync(1000);

    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(task).toHaveBeenCalledTimes(2);
    await poller.stop();
  });

  it('stops after the run in progress has finished and runs no more', async () => {
    let finish: () => void = () => undefined;
    let finished = false;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            finished = true;
            resolve();
          };
        }),
    );
    const poller = startPoller(task, 1000, () => undefined);

    const stopping = poller.stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(finished).toBe(false);
    finish();
    await stopping;
    await vi.advanceTimersByTimeAsync(5000);

    expect(task).toHaveBeenCalledTimes(1);
  });

  it('stops at once when no run is in progress', async () => {
    const task = vi.fn(() => Promise.resolve());
    const poller = startPoller(task, 1000, () => undefined);
    await vi.advanceTimersByTimeAsync(0);

    await poller.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(task).toHaveBeenCalledTimes(1);
  });
});
