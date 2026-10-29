/** A fixed-interval background task (architecture §4.7). */
export interface Poller {
  /** Stops polling; resolves once a run in progress has finished. */
  stop(): Promise<void>;
}

/**
 * Runs `task` at once and then every `intervalMs`, never twice at the same time: a tick during a slow run is skipped
 * rather than queued. A failed run goes to `onError` and polling carries on.
 */
export function startPoller(
  task: () => Promise<unknown>,
  intervalMs: number,
  onError: (error: unknown) => void,
): Poller {
  let running: Promise<void> | undefined;
  const tick = (): void => {
    if (running !== undefined) return;
    running = task().then(
      () => {
        running = undefined;
      },
      (error: unknown) => {
        running = undefined;
        onError(error);
      },
    );
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
