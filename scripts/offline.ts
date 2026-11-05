// Keeps a development tool offline: `node --import ./scripts/offline-preload.ts <tool> …` runs the tool with every
// outbound connection refused and reported on stderr. The npm scripts run the Redocly CLI this way, so it can send no
// telemetry and fetch nothing, even if a later version ignored `telemetry: off` in redocly.yaml.
import net from 'node:net';

interface Destination {
  readonly host?: unknown;
  readonly port?: unknown;
  readonly path?: unknown;
}

function destination(args: readonly unknown[]): string {
  // `net.connect()` hands the socket its arguments already normalised, as one array.
  const [first, second] = Array.isArray(args[0]) ? args[0] : args;
  if (typeof first === 'object' && first !== null) {
    const { host, port, path } = first as Destination;
    return `${String(host ?? path)}:${String(port)}`;
  }
  return `${String(second)}:${String(first)}`;
}

/** Refuses every outbound connection of this process and reports it; returns a function that allows them again. */
export function refuseConnections(report: (line: string) => void): () => void {
  const original = Object.getOwnPropertyDescriptor(net.Socket.prototype, 'connect');
  function refuse(this: net.Socket, ...args: unknown[]): net.Socket {
    report(`connection-attempt ${destination(args)}\n`);
    return this.destroy(new Error('network access is disabled in this process'));
  }
  Object.defineProperty(net.Socket.prototype, 'connect', { value: refuse, writable: true, configurable: true });
  return () => {
    if (original !== undefined) Object.defineProperty(net.Socket.prototype, 'connect', original);
  };
}
