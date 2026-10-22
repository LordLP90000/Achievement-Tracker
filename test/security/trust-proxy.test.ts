import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.ts';

const SOCKET_ADDRESS = '10.0.0.5';

describe('client IP behind proxies [S-10]', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  const ipSeenBy = async (trustProxyHops: number, forwardedFor?: string) => {
    app = await buildTestApp({ trustProxyHops });
    const response = await app.inject({
      method: 'GET',
      url: '/__test/ip',
      remoteAddress: SOCKET_ADDRESS,
      headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    });
    return response.json<{ ip: string }>().ip;
  };

  it('ignores X-Forwarded-For entirely when no proxy is trusted', async () => {
    expect(await ipSeenBy(0, '203.0.113.9')).toBe(SOCKET_ADDRESS);
  });

  it('trusts exactly the configured number of hops and ignores spoofed entries before them', async () => {
    expect(await ipSeenBy(1, '198.51.100.66, 203.0.113.9')).toBe('203.0.113.9');
  });

  it('uses the socket address when a trusted proxy sends no header', async () => {
    expect(await ipSeenBy(1)).toBe(SOCKET_ADDRESS);
  });
});
