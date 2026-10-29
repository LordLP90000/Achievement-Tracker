import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

type Node = Record<string, unknown>;

export interface SpecOperation {
  readonly operationId: string;
  readonly method: string;
  /** Full path template including the server base path, e.g. `/v1/quests/{questId}`. */
  readonly path: string;
  /** The same path in Fastify syntax, e.g. `/v1/quests/:questId`. */
  readonly fastifyPath: string;
  readonly pattern: RegExp;
  /** True when the operation declares a `requestBody`. */
  readonly hasRequestBody: boolean;
  /** True unless the operation (or the spec) declares `security: []`. */
  readonly requiresAuth: boolean;
  readonly responses: Node;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;
const SCHEMA_REF_PREFIX = '#/components/schemas/';

export const spec = parse(readFileSync(new URL('../../openapi/openapi.yaml', import.meta.url), 'utf8')) as Node;

/** Resolves a local `$ref` such as `#/components/responses/NotFound`. */
export function resolveRef(node: unknown): Node {
  const ref = (node as { $ref?: unknown }).$ref;
  if (typeof ref !== 'string') return node as Node;
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((current, key) => (current as Node)[key], spec) as Node;
}

function basePathOf(servers: unknown): string {
  const url = (servers as { url?: string }[] | undefined)?.[0]?.url;
  return url === undefined ? '' : new URL(url).pathname.replace(/\/$/, '');
}

export const specOperations: readonly SpecOperation[] = Object.entries(spec['paths'] as Node).flatMap(
  ([template, rawItem]) => {
    const item = rawItem as Node;
    const path = `${basePathOf(item['servers'] ?? spec['servers'])}${template}`;
    return HTTP_METHODS.filter((method) => method in item).map((method) => {
      const operation = item[method] as Node;
      return {
        operationId: String(operation['operationId']),
        method: method.toUpperCase(),
        path,
        fastifyPath: path.replace(/\{([^}]+)\}/g, ':$1'),
        pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
        hasRequestBody: operation['requestBody'] !== undefined,
        requiresAuth: ((operation['security'] ?? spec['security'] ?? []) as unknown[]).length > 0,
        responses: operation['responses'] as Node,
      };
    });
  },
);

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats.default(ajv);
const toAjvRefs = (schema: unknown): unknown =>
  JSON.parse(JSON.stringify(schema).replaceAll(`"${SCHEMA_REF_PREFIX}`, '"spec#/$defs/'));
ajv.addSchema({ $id: 'spec', $defs: toAjvRefs((spec['components'] as Node)['schemas']) as Node });

const validators = new Map<string, ValidateFunction>();

/** Compiles (once) a schema taken from the spec, with `#/components/schemas/*` references resolved. */
export function validatorFor(schema: unknown): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = validators.get(key);
  if (validate === undefined) {
    validate = ajv.compile(toAjvRefs(schema) as Node);
    validators.set(key, validate);
  }
  return validate;
}

export function describeErrors(validate: ValidateFunction): string {
  return ajv.errorsText(validate.errors);
}
