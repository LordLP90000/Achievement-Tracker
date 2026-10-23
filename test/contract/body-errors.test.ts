import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { BODY_LIMIT_BYTES } from '../../src/app.ts';
import { buildTestApp } from '../helpers/app.ts';
import { describeErrors, resolveRef, specOperations, validatorFor } from '../helpers/openapi.ts';

type Node = Record<string, unknown>;

const BODY_ERROR_RESPONSES = [
  ['413', 'PayloadTooLarge'],
  ['415', 'UnsupportedMediaType'],
] as const;

const operationsWithBody = specOperations.filter((operation) => operation.hasRequestBody);

/** Fails unless the response matches the named entry of `#/components/responses` (media type and body). */
function expectDocumentedAs(component: string, response: LightMyRequestResponse): void {
  const definition = resolveRef({ $ref: `#/components/responses/${component}` }) as Node | undefined;
  expect(definition, `#/components/responses/${component}`).toBeDefined();
  const mediaType = (response.headers['content-type'] ?? '').split(';', 1)[0]?.trim() ?? '';
  const media = ((definition?.['content'] ?? {}) as Node)[mediaType] as Node | undefined;
  expect(media, `media type "${mediaType}" of ${component}`).toBeDefined();
  const validate = validatorFor(media?.['schema']);
  expect(validate(response.json()), describeErrors(validate)).toBe(true);
}

describe('request body errors in the contract [Q-25, R-IN-01, D-02]', () => {
  it('finds the operations that accept a request body', () => {
    expect(operationsWithBody.length).toBeGreaterThan(0);
  });

  it.each(BODY_ERROR_RESPONSES)('documents %s on every operation that accepts a body', (status, component) => {
    const missing = operationsWithBody
      .filter(
        (operation) =>
          (operation.responses[status] as { $ref?: unknown } | undefined)?.$ref !==
          `#/components/responses/${component}`,
      )
      .map((operation) => operation.operationId);

    expect(missing).toEqual([]);
  });
});

describe('documented body errors match what the server sends [Q-25, D-02]', () => {
  const post = async (contentType: string, payload: string) => {
    const app = await buildTestApp();
    try {
      return await app.inject({
        method: 'POST',
        url: '/__test/echo',
        headers: { 'content-type': contentType },
        payload,
      });
    } finally {
      await app.close();
    }
  };

  it('answers a body over 64 KiB with the documented 413 problem', async () => {
    const response = await post('application/json', JSON.stringify({ data: 'x'.repeat(BODY_LIMIT_BYTES) }));

    expect(response.statusCode).toBe(413);
    expectDocumentedAs('PayloadTooLarge', response);
  });

  it('answers a body that is not JSON with the documented 415 problem', async () => {
    const response = await post('text/plain', 'hello');

    expect(response.statusCode).toBe(415);
    expectDocumentedAs('UnsupportedMediaType', response);
  });
});
