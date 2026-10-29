import type { FastifyRequest } from 'fastify';
import { ipPrefix } from './ip-prefix.ts';

/** What the audit log may learn about a request: the client's network, never its address (C8). */
export interface RequestContext {
  readonly ipPrefix: string | null;
}

export function requestContext(request: FastifyRequest): RequestContext {
  return { ipPrefix: ipPrefix(request.ip) };
}
