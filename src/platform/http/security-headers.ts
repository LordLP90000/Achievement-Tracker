import type { FastifyInstance } from 'fastify';

/** Sent on every response (R-TLS-01/02). CORS headers are never sent (R-TLS-03). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'permissions-policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
  pragma: 'no-cache',
});

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onRequest', async (_request, reply) => {
    reply.headers(SECURITY_HEADERS);
  });
}
