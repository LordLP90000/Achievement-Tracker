import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { IdempotentOutcome, IdempotentRequest, IdempotentRoute } from '../idempotency/idempotent.ts';
import { Problems, type ProblemDefinition } from './problem.ts';
import { isUuidV4, ProblemError } from './validation.ts';

export type {
  IdempotentOutcome,
  IdempotentRequest,
  IdempotentRoute,
  StoredResponse,
} from '../idempotency/idempotent.ts';

/** `Idempotency-Key` and replays of create operations (ADR-0008, Q-39); the store is `platform/idempotency`. */

const INVALID_KEY: ProblemDefinition = {
  ...Problems.validation,
  errors: [{ pointer: '', message: 'Idempotency-Key must be one UUID v4' }],
};

/** JSON with the properties of every object sorted, so a repeated request digests equally in any property order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  const record = value as Readonly<Record<string, unknown>>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}

/**
 * The key of a create request (anything but one UUID v4 → 400) and a SHA-256 digest of its path parameters and
 * body: reusing a key under another parent or with another body is a different request (T-13).
 */
export function idempotentRequest(
  route: IdempotentRoute,
  header: string | string[] | undefined,
  params: unknown,
  body: unknown,
): IdempotentRequest {
  if (typeof header !== 'string' || !isUuidV4(header)) throw new ProblemError(INVALID_KEY);
  const requestHash = createHash('sha256').update(canonicalJson({ params, body }), 'utf8').digest();
  return { route, key: header, requestHash };
}

/** Sends the first response or its replay (`Idempotency-Replayed: true`); a key reused for another request → 422. */
export function sendIdempotent(reply: FastifyReply, outcome: IdempotentOutcome): FastifyReply {
  if (outcome.outcome === 'key_reused') throw new ProblemError(Problems.idempotencyKeyReused);
  if (outcome.outcome === 'replayed') void reply.header('idempotency-replayed', 'true');
  return reply.code(outcome.response.status).headers(outcome.response.headers).send(outcome.response.body);
}
