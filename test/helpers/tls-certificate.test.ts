import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { connect, createServer, type TLSSocket } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { createTestCertificate } from './tls-certificate.ts';

async function handshake(certificate: { key: string; cert: string }, ca?: string): Promise<TLSSocket> {
  const server = createServer({ key: certificate.key, cert: certificate.cert }, (socket) => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const socket = connect({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      servername: 'localhost',
      ...(ca === undefined ? {} : { ca }),
    });
    await once(socket, 'secureConnect');
    socket.destroy();
    return socket;
  } finally {
    server.close();
  }
}

describe('createTestCertificate', () => {
  it('creates a self-signed certificate for localhost and 127.0.0.1 that is valid now', () => {
    const certificate = new X509Certificate(createTestCertificate().cert);

    expect(certificate.checkHost('localhost')).toBe('localhost');
    expect(certificate.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(Date.parse(certificate.validFrom)).toBeLessThan(Date.now());
    expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now());
  });

  it('creates a new key pair every time', () => {
    const first = createTestCertificate();
    const second = createTestCertificate();

    expect(second.key).not.toBe(first.key);
    expect(new X509Certificate(second.cert).serialNumber).not.toBe(new X509Certificate(first.cert).serialNumber);
  });

  it('is trusted by a TLS client only when passed as a trust anchor', async () => {
    const certificate = createTestCertificate();

    await expect(handshake(certificate, certificate.cert)).resolves.toMatchObject({ authorized: true });
    await expect(handshake(certificate)).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    await expect(handshake(certificate, createTestCertificate().cert)).rejects.toThrow();
  });
});
