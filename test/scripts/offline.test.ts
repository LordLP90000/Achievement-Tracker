import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { refuseConnections } from '../../scripts/offline.ts';

/** The offline preload for development tools (scripts/offline-preload.ts): nothing they try leaves the machine. */
describe('refuseConnections (scripts/offline.ts)', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('refuses a connection and reports where it was going', async () => {
    const reported: string[] = [];
    restore = refuseConnections((line) => {
      reported.push(line);
    });

    const socket = net.connect(443, 'telemetry.example.invalid');
    const error = await new Promise<Error>((resolve) => {
      socket.once('error', resolve);
    });

    expect(error.message).toBe('network access is disabled in this process');
    expect(reported).toEqual(['connection-attempt telemetry.example.invalid:443\n']);
  });

  it('refuses fetch too, which connects through the same sockets', async () => {
    const reported: string[] = [];
    restore = refuseConnections((line) => {
      reported.push(line);
    });

    await expect(fetch('https://telemetry.example.invalid/v1/traces')).rejects.toThrow();
    expect(reported.join('')).toContain('connection-attempt telemetry.example.invalid:443');
  });

  it('gives the connections back when restored', () => {
    const original = Object.getOwnPropertyDescriptor(net.Socket.prototype, 'connect');

    refuseConnections(() => undefined)();

    expect(Object.getOwnPropertyDescriptor(net.Socket.prototype, 'connect')).toEqual(original);
  });
});
