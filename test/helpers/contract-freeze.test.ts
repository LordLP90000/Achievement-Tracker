import { describe, expect, it } from 'vitest';
import { breakingChanges } from './contract-freeze.ts';

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Fields = Readonly<Record<string, Json>>;

const INPUT_FIELDS: Fields = {
  title: { type: 'string' },
  note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  status: { $ref: '#/components/schemas/Status' },
};
const THING_FIELDS: Fields = {
  id: { type: 'string', format: 'uuid' },
  status: { $ref: '#/components/schemas/Status' },
  tags: { type: 'array', items: { type: 'string' } },
  parent: { oneOf: [{ $ref: '#/components/schemas/Parent' }, { type: 'null' }] },
};
const VERBOSE = { name: 'verbose', in: 'query', required: false, schema: { type: 'boolean' } } as const;
const ETAG: Fields = { ETag: { schema: { type: 'string' } } };
const JSON_OUTPUT: Fields = { 'application/json': { schema: { $ref: '#/components/schemas/Output' } } };
const NOT_FOUND: Json = { $ref: '#/components/responses/NotFound' };

const without = (fields: Fields, name: string): Fields =>
  Object.fromEntries(Object.entries(fields).filter(([key]) => key !== name));
const inputSchema = (fields: Fields = INPUT_FIELDS, required: readonly string[] = ['title'], closed = true): Json => ({
  type: 'object',
  ...(closed ? { additionalProperties: false } : {}),
  required,
  properties: fields,
});
const thingSchema = (fields: Fields = THING_FIELDS, required: readonly string[] = ['id', 'status', 'tags']): Json => ({
  type: 'object',
  required,
  properties: fields,
});
const ok = (headers: Fields = ETAG, content: Fields = JSON_OUTPUT): Json => ({
  description: 'The thing.',
  headers,
  content,
});

interface Parts {
  readonly method?: string;
  readonly path?: string;
  readonly operationId?: string;
  readonly security?: Json;
  readonly parameters?: readonly Json[];
  /** `null` leaves the body out. */
  readonly requestBody?: Json;
  readonly responses?: Fields;
  readonly schemas?: Fields;
  readonly paths?: Fields;
}

/** A small contract with one operation, `op`: `POST /v1/things/{thingId}` with a body and two responses. */
function contract(parts: Parts = {}): Fields {
  const requestBody =
    parts.requestBody === undefined
      ? { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } } }
      : parts.requestBody;
  return {
    openapi: '3.1.0',
    info: { title: 'Test', version: '1.0.0' },
    servers: [{ url: 'https://api.example.invalid/v1' }],
    security: [{ bearerAuth: [] }],
    paths: {
      [parts.path ?? '/things/{thingId}']: {
        parameters: [{ name: 'thingId', in: 'path', required: true, schema: { type: 'string' } }],
        [parts.method ?? 'post']: {
          operationId: parts.operationId ?? 'op',
          ...(parts.security === undefined ? {} : { security: parts.security }),
          parameters: parts.parameters ?? [VERBOSE],
          ...(requestBody === null ? {} : { requestBody }),
          responses: parts.responses ?? { '200': ok(), '404': NOT_FOUND },
        },
      },
      ...parts.paths,
    },
    components: {
      responses: {
        NotFound: {
          description: 'Not found.',
          content: { 'application/problem+json': { schema: { type: 'object', additionalProperties: true } } },
        },
      },
      schemas: {
        Status: { type: 'string', enum: ['open', 'done'] },
        Input: inputSchema(),
        Thing: thingSchema(),
        Parent: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        Output: { allOf: [{ $ref: '#/components/schemas/Thing' }], unevaluatedProperties: false },
        ...parts.schemas,
      },
    },
  };
}

const withInput = (input: Json) => contract({ schemas: { Input: input } });
const withThing = (thing: Json) => contract({ schemas: { Thing: thing } });

describe('contract freeze: what counts as breaking [Q-45]', () => {
  it('finds nothing between a contract and itself', () => {
    expect(breakingChanges(contract(), contract())).toEqual([]);
  });

  it.each<[string, Fields]>([
    ['a new operation', contract({ paths: { '/others': { get: { operationId: 'other', responses: {} } } } })],
    [
      'a new optional parameter',
      contract({ parameters: [VERBOSE, { name: 'page', in: 'query', schema: { type: 'string' } }] }),
    ],
    ['a new optional request property', withInput(inputSchema({ ...INPUT_FIELDS, extra: { type: 'string' } }))],
    ['a request property no longer required', withInput(inputSchema(INPUT_FIELDS, []))],
    ['null accepted in a request', withInput(inputSchema({ ...INPUT_FIELDS, title: { type: ['string', 'null'] } }))],
    [
      'a new value, in a request and a response',
      contract({ schemas: { Status: { type: 'string', enum: ['open', 'done', 'new'] } } }),
    ],
    [
      'an optional request body',
      contract({
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } } },
      }),
    ],
    ['a new response property', withThing(thingSchema({ ...THING_FIELDS, extra: { type: 'integer' } }))],
    [
      'a new response status',
      contract({ responses: { '200': ok(), '404': NOT_FOUND, '409': { description: 'Conflict.' } } }),
    ],
    [
      'a response type narrowed',
      withThing(thingSchema({ ...THING_FIELDS, parent: { $ref: '#/components/schemas/Parent' } })),
    ],
    ['a schema moved inline', contract({ schemas: { Output: thingSchema() } })],
  ])('lets %s through: additive', (_change, current) => {
    expect(breakingChanges(contract(), current)).toEqual([]);
  });

  it.each<[string, Fields, readonly string[]]>([
    ['a removed operation', contract({ operationId: 'renamed' }), ['op: removed']],
    [
      'another method',
      contract({ method: 'put' }),
      ['op: moved from POST /v1/things/{thingId} to PUT /v1/things/{thingId}'],
    ],
    [
      'a renamed path',
      contract({ path: '/items/{thingId}' }),
      ['op: moved from POST /v1/things/{thingId} to POST /v1/items/{thingId}'],
    ],
    ['a public operation', contract({ security: [] }), ['op: authentication no longer required']],
    ['a removed parameter', contract({ parameters: [] }), ['op: parameter query:verbose removed']],
    [
      'an optional parameter now required',
      contract({ parameters: [{ ...VERBOSE, required: true }] }),
      ['op: parameter query:verbose now required'],
    ],
    [
      'a new required parameter',
      contract({ parameters: [VERBOSE, { name: 'page', in: 'query', required: true, schema: { type: 'string' } }] }),
      ['op: new required parameter query:page'],
    ],
    [
      'a parameter of another type',
      contract({ parameters: [{ ...VERBOSE, schema: { type: 'string' } }] }),
      ['op: parameter query:verbose #: accepts fewer types (boolean → string)'],
    ],
    ['a removed request body', contract({ requestBody: null }), ['op: request body removed']],
    [
      'a request body of another media type',
      contract({ requestBody: { required: true, content: { 'text/plain': { schema: { type: 'string' } } } } }),
      ['op: request body application/json removed'],
    ],
    [
      'a removed request property',
      withInput(inputSchema(without(INPUT_FIELDS, 'note'))),
      ['op: request body application/json #/note: removed'],
    ],
    [
      'a renamed request property',
      withInput(inputSchema({ ...without(INPUT_FIELDS, 'title'), name: { type: 'string' } }, ['name'])),
      [
        'op: request body application/json #/title: removed',
        'op: request body application/json #/name: newly required',
      ],
    ],
    [
      'a new required request property',
      withInput(inputSchema({ ...INPUT_FIELDS, size: { type: 'string' } }, ['title', 'size'])),
      ['op: request body application/json #/size: newly required'],
    ],
    [
      'null no longer accepted in a request',
      withInput(inputSchema({ ...INPUT_FIELDS, note: { type: 'string' } })),
      ['op: request body application/json #/note: accepts fewer types (null, string → string)'],
    ],
    [
      'a free request value now limited',
      withInput(inputSchema({ ...INPUT_FIELDS, title: { type: 'string', enum: ['A'] } })),
      ['op: request body application/json #/title: now limited to listed values'],
    ],
    [
      'a removed value, in a request and a response',
      contract({ schemas: { Status: { type: 'string', enum: ['open'] } } }),
      [
        'op: request body application/json #/status: value "done" removed',
        'op: response 200 application/json #/status: value "done" removed',
      ],
    ],
    ['a removed response', contract({ responses: { '200': ok() } }), ['op: response 404 removed']],
    [
      'a removed response header',
      contract({ responses: { '200': ok({}), '404': NOT_FOUND } }),
      ['op: response 200 header etag removed'],
    ],
    [
      'a response header of another type',
      contract({ responses: { '200': ok({ ETag: { schema: { type: 'integer' } } }), '404': NOT_FOUND } }),
      ['op: response 200 header etag #: may return other types (string → integer)'],
    ],
    [
      'a response of another media type',
      contract({ responses: { '200': ok(ETAG, { 'text/plain': { schema: { type: 'string' } } }), '404': NOT_FOUND } }),
      ['op: response 200 application/json removed'],
    ],
    [
      'a removed response property',
      withThing(thingSchema(without(THING_FIELDS, 'parent'))),
      ['op: response 200 application/json #/parent: removed'],
    ],
    [
      'a response property no longer always present',
      withThing(thingSchema(THING_FIELDS, ['id', 'status'])),
      ['op: response 200 application/json #/tags: no longer always present'],
    ],
    [
      'null returned where it was not',
      withThing(thingSchema({ ...THING_FIELDS, id: { type: ['string', 'null'] } })),
      ['op: response 200 application/json #/id: may return other types (string → null, string)'],
    ],
    [
      'a response value no longer limited',
      withThing(thingSchema({ ...THING_FIELDS, status: { type: 'string' } })),
      ['op: response 200 application/json #/status: no longer limited to its values'],
    ],
    [
      'array items of another type',
      withThing(thingSchema({ ...THING_FIELDS, tags: { type: 'array', items: { type: 'integer' } } })),
      ['op: response 200 application/json #/tags[]: may return other types (string → integer)'],
    ],
    [
      'a property removed behind a nullable reference',
      contract({ schemas: { Parent: { type: 'object', properties: {} } } }),
      ['op: response 200 application/json #/parent/id: removed'],
    ],
    [
      'a property behind a nullable reference no longer always present',
      contract({ schemas: { Parent: { type: 'object', properties: { id: { type: 'string' } } } } }),
      ['op: response 200 application/json #/parent/id: no longer always present'],
    ],
  ])('reports %s', (_change, current, expected) => {
    expect(breakingChanges(contract(), current)).toEqual(expected);
  });

  it('reports a request body closed to other properties; opening one is additive', () => {
    const open = withInput(inputSchema(INPUT_FIELDS, ['title'], false));

    expect(breakingChanges(open, contract())).toEqual([
      'op: request body application/json #: closed to other properties',
    ]);
    expect(breakingChanges(contract(), open)).toEqual([]);
  });

  it('counts an integer as a number: a request may widen it, a response narrow it', () => {
    const parameter = (type: string) => contract({ parameters: [{ ...VERBOSE, schema: { type } }] });
    const returned = (type: string) => withThing(thingSchema({ ...THING_FIELDS, size: { type } }));

    expect(breakingChanges(parameter('integer'), parameter('number'))).toEqual([]);
    expect(breakingChanges(parameter('number'), parameter('integer'))).toEqual([
      'op: parameter query:verbose #: accepts fewer types (number → integer)',
    ]);
    expect(breakingChanges(returned('number'), returned('integer'))).toEqual([]);
    expect(breakingChanges(returned('integer'), returned('number'))).toEqual([
      'op: response 200 application/json #/size: may return other types (integer → number)',
    ]);
  });

  it('skips the operations outside the freeze', () => {
    expect(breakingChanges(contract(), contract({ operationId: 'renamed' }), new Set(['op']))).toEqual([]);
  });

  it('refuses references outside the document and stops at recursive schemas', () => {
    const remote = contract({ schemas: { Input: { $ref: 'https://example.invalid/input.json' } } });
    const recursive = withThing(
      thingSchema({ ...THING_FIELDS, children: { type: 'array', items: { $ref: '#/components/schemas/Thing' } } }),
    );

    expect(() => breakingChanges(contract(), remote)).toThrow(/only local references/);
    expect(breakingChanges(recursive, recursive)).toEqual([]);
  });
});
