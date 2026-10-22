import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../platform/logging/logger.ts';
import { stopOnSignals } from './shutdown.ts';

function setup(stop: () => Promise<void>) {
  const lines: string[] = [];
  const logger = createLogger(
    { service: 'questline-api', level: 'info' },
    { write: (line: string) => lines.push(line) },
  );
  const host = Object.assign(new EventEmitter(), { exit: vi.fn<(code: number) => void>() });
  const service = { stop: vi.fn(stop) };
  stopOnSignals(host, service, logger, { timeoutMs: 1000 });
  const messages = () => lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
  return { host, service, messages, lines };
}

describe('stopOnSignals', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('stops the service once on %s and lets the process end', async (signal) => {
    const { host, service, messages } = setup(() => Promise.resolve());

    host.emit(signal);
    await vi.waitFor(() => {
      expect(messages()).toEqual(['shutting down', 'stopped']);
    });

    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(host.exit).not.toHaveBeenCalled();
  });

  it('ignores further signals while stopping', async () => {
    const { host, service, messages } = setup(() => Promise.resolve());

    host.emit('SIGTERM');
    host.emit('SIGINT');
    await vi.waitFor(() => {
      expect(messages()).toContain('stopped');
    });

    expect(service.stop).toHaveBeenCalledTimes(1);
  });

  it('exits with code 1 and logs only the error name when stopping fails', async () => {
    const { host, messages, lines } = setup(() => Promise.reject(new Error('pool end failed for SecretHost')));

    host.emit('SIGTERM');
    await vi.waitFor(() => {
      expect(host.exit).toHaveBeenCalledWith(1);
    });

    expect(messages()).toEqual(['shutting down', 'shutdown failed']);
    expect(lines.join('')).not.toContain('SecretHost');
  });

  it('exits with code 1 when stopping takes longer than the timeout', () => {
    vi.useFakeTimers();
    const { host, messages } = setup(() => new Promise<void>(() => undefined));

    host.emit('SIGTERM');
    vi.advanceTimersByTime(1000);

    expect(host.exit).toHaveBeenCalledWith(1);
    expect(messages()).toEqual(['shutting down', 'shutdown timed out']);
  });

  it('waits 10 seconds by default before forcing the exit', () => {
    vi.useFakeTimers();
    const host = Object.assign(new EventEmitter(), { exit: vi.fn<(code: number) => void>() });
    const logger = createLogger({ service: 'questline-api', level: 'silent' });
    stopOnSignals(host, { stop: () => new Promise<void>(() => undefined) }, logger);

    host.emit('SIGTERM');
    vi.advanceTimersByTime(9_999);
    expect(host.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(host.exit).toHaveBeenCalledWith(1);
  });
});
