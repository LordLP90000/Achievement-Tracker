import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { principalOf, type Principal } from './guard.ts';

describe('principalOf', () => {
  const principal: Principal = {
    userId: '6f1c2a4e-8d3b-4c5a-9e7f-1a2b3c4d5e6f',
    sessionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    lastReauthAt: new Date('2026-10-29T12:00:00Z'),
  };

  it('returns the principal the guard attached', () => {
    expect(principalOf({ principal } as FastifyRequest)).toBe(principal);
  });

  it('fails loudly on a route that is not behind the guard instead of acting for nobody', () => {
    expect(() => principalOf({ principal: null } as FastifyRequest)).toThrow('route is not behind the auth guard');
  });
});
