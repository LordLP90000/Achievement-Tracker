import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractInject } from '../helpers/contract.ts';

/** A deliberately wrong server: proves the harness rejects responses that break the contract. */
describe('contract harness rejects violations [ADR-0010]', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    app.get('/health/live', () => ({ status: 'fine' }));
    app.get('/health/ready', (_request, reply) => reply.code(418).send({ status: 'ok' }));
    app.get('/v1/undocumented', () => ({ ok: true }));
    app.get('/health/teapot', (_request, reply) => reply.code(404).send({ message: 'not a problem document' }));
    app.post('/health/live', (_request, reply) => reply.code(200).type('text/plain').send('ok'));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a body that does not match the schema', async () => {
    await expect(contractInject(app, { method: 'GET', url: '/health/live' })).rejects.toThrow(/healthLive 200 body/);
  });

  it('rejects an undocumented status code', async () => {
    await expect(contractInject(app, { method: 'GET', url: '/health/ready' })).rejects.toThrow(
      /healthReady 418: status is not documented/,
    );
  });

  it('rejects a route that is not in the contract', async () => {
    await expect(contractInject(app, { method: 'GET', url: '/v1/undocumented' })).rejects.toThrow(
      /undocumented route GET \/v1\/undocumented answered 200/,
    );
  });

  it('rejects a 404 that is not a problem document', async () => {
    await expect(contractInject(app, { method: 'GET', url: '/health/teapot' })).rejects.toThrow(/\(404\)/);
  });

  it('rejects an undocumented route even when it answers successfully', async () => {
    await expect(contractInject(app, { method: 'POST', url: '/health/live' })).rejects.toThrow(/undocumented route/);
  });
});
