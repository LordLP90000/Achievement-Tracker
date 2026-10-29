import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { inject } from 'vitest';
import { describeErrors, resolveRef, specOperations, validatorFor } from './openapi.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    contractCoverageDir: string;
  }
}

type Node = Record<string, unknown>;

export interface ContractRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly payload?: string;
  /** Client address as the server sees it (default 127.0.0.1). */
  readonly remoteAddress?: string;
}

const coverageDir = inject('contractCoverageDir');
const coverageFile = join(coverageDir, `${randomUUID()}.txt`);

function fail(message: string): never {
  throw new Error(`OpenAPI contract violation: ${message}`);
}

function validate(schema: unknown, value: unknown, what: string): void {
  const validator = validatorFor(schema);
  if (!validator(value)) fail(`${what}: ${describeErrors(validator)}`);
}

function headerValue(schema: Node, raw: string): unknown {
  return schema['type'] === 'integer' || schema['type'] === 'number' ? Number(raw) : raw;
}

/**
 * Validates a response against openapi/openapi.yaml (ADR-0010): the status must be documented, documented
 * headers present and valid, and the body valid for its media type. Unknown routes must answer with the generic
 * 404 problem; test-only routes (`/__test/*`) are outside the contract.
 */
export function assertMatchesContract(request: ContractRequest, response: LightMyRequestResponse): void {
  const path = request.url.split('?', 1)[0] ?? '';
  if (path.startsWith('/__test/')) return;

  const operation = specOperations.find(
    (candidate) => candidate.method === request.method && candidate.pattern.test(path),
  );
  if (operation === undefined) {
    if (response.statusCode !== 404)
      fail(`undocumented route ${request.method} ${path} answered ${String(response.statusCode)}`);
    validate({ $ref: '#/components/schemas/Problem' }, response.json(), `${request.method} ${path} (404)`);
    return;
  }

  const name = `${operation.operationId} ${String(response.statusCode)}`;
  const documented = operation.responses[String(response.statusCode)] ?? operation.responses['default'];
  if (documented === undefined) fail(`${name}: status is not documented`);
  const definition = resolveRef(documented);

  for (const [headerName, rawHeader] of Object.entries((definition['headers'] ?? {}) as Node)) {
    const header = resolveRef(rawHeader);
    const actual = response.headers[headerName.toLowerCase()];
    if (actual === undefined) {
      if (header['required'] === true) fail(`${name}: required header ${headerName} is missing`);
      continue;
    }
    const schema = header['schema'] as Node;
    validate(schema, headerValue(schema, String(actual)), `${name} header ${headerName}`);
  }

  const content = definition['content'] as Node | undefined;
  if (content === undefined) {
    if (response.body.length > 0) fail(`${name}: a body was sent but none is documented`);
  } else {
    const mediaType = (response.headers['content-type'] ?? '').split(';', 1)[0]?.trim() ?? '';
    const media = content[mediaType] as Node | undefined;
    if (media === undefined) fail(`${name}: media type "${mediaType}" is not documented`);
    validate(media['schema'], response.json(), `${name} body`);
  }

  appendFileSync(coverageFile, `${operation.operationId}\n`);
}

/** `app.inject` that fails the test unless the response matches the OpenAPI contract. */
export async function contractInject(app: FastifyInstance, request: ContractRequest): Promise<LightMyRequestResponse> {
  const response = await app.inject(request);
  assertMatchesContract(request, response);
  return response;
}
