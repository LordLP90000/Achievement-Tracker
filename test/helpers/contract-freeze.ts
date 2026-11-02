/**
 * The contract freeze (Q-45): lists every change from a frozen contract that a client built against it could break
 * on. Requests may only accept more than they did; responses keep every promise. So it reports a removed or moved
 * operation, a change of authentication, a removed parameter, request body, response, response header, media type,
 * property or value, a parameter, body or property newly required of a request, a type or value a request no longer
 * accepts, a type a response may now return, and a response property no longer always present. Additive changes —
 * new operations, optional parameters, properties, responses and values — pass; each still needs the PM's approval.
 * Not compared: formats, patterns, lengths, bounds and conditional (`if`/`then`) rules; every response is still
 * validated against the current contract by the contract tests.
 */

type Node = Readonly<Record<string, unknown>>;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;

/** What a schema allows, flattened: references resolved, `allOf` intersected, `oneOf` and `anyOf` united. */
interface Surface {
  /** The JSON types it allows; null when any type is allowed. */
  readonly types: ReadonlySet<string> | null;
  /** The values it allows as JSON text (`enum`, `const`, `type: 'null'`); null when not limited. */
  readonly values: ReadonlySet<string> | null;
  readonly properties: ReadonlyMap<string, Surface>;
  /** The properties present whenever the value is an object. */
  readonly required: ReadonlySet<string>;
  readonly items: Surface | null;
  /** No property beyond the listed ones (`additionalProperties` or `unevaluatedProperties` false). */
  readonly closed: boolean;
}

const ANY: Surface = {
  types: null,
  values: null,
  properties: new Map(),
  required: new Set(),
  items: null,
  closed: false,
};

interface Operation {
  readonly id: string;
  readonly method: string;
  /** The path with its server's base path, e.g. `/v1/quests/{questId}`. */
  readonly path: string;
  readonly auth: boolean;
  /** By `in:name`; an operation's own parameter replaces its path's. */
  readonly parameters: ReadonlyMap<string, Node>;
  readonly requestBody: Node | null;
  readonly responses: ReadonlyMap<string, Node>;
}

function asNode(value: unknown): Node {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the contract has a malformed or dangling node');
  }
  return value as Node;
}

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const textOf = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

/** A contract document and its local references. */
class Contract {
  readonly root: Node;

  constructor(root: object) {
    this.root = asNode(root);
  }

  /** The node a local reference such as `#/components/schemas/Quest` points at. */
  target(ref: string): Node {
    if (!ref.startsWith('#/')) throw new Error(`the freeze check follows only local references, not ${ref}`);
    const keys = ref
      .slice(2)
      .split('/')
      .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'));
    return asNode(keys.reduce<unknown>((at, key) => asNode(at)[key], this.root));
  }

  /** The node itself, or what its chain of references points at. */
  resolve(node: unknown): Node {
    let current = asNode(node);
    for (let hops = 0; typeof current['$ref'] === 'string'; hops += 1) {
      if (hops > 20) throw new Error('the contract has a reference loop');
      current = this.target(current['$ref']);
    }
    return current;
  }
}

const covers = (types: ReadonlySet<string>, type: string): boolean =>
  types.has(type) || (type === 'integer' && types.has('number'));

const typeList = (types: ReadonlySet<string> | null): string => (types === null ? 'any' : [...types].sort().join(', '));

function typesOf(type: unknown): ReadonlySet<string> | null {
  if (typeof type === 'string') return new Set([type]);
  return Array.isArray(type) ? new Set(type.filter((entry): entry is string => typeof entry === 'string')) : null;
}

function valuesOf(schema: Node, types: ReadonlySet<string> | null): ReadonlySet<string> | null {
  if ('const' in schema) return new Set([JSON.stringify(schema['const'])]);
  if (Array.isArray(schema['enum'])) return new Set(schema['enum'].map((value) => JSON.stringify(value)));
  return types?.size === 1 && types.has('null') ? new Set(['null']) : null;
}

const intersectTypes = (a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> =>
  new Set([...a, ...b].filter((type) => covers(a, type) && covers(b, type)));

const intersectValues = (a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> =>
  new Set([...a].filter((value) => b.has(value)));

/** Both apply (`allOf`). */
function intersect(a: Surface, b: Surface): Surface {
  const properties = new Map(a.properties);
  for (const [name, property] of b.properties) {
    const known = properties.get(name);
    properties.set(name, known === undefined ? property : intersect(known, property));
  }
  return {
    types: a.types === null ? b.types : b.types === null ? a.types : intersectTypes(a.types, b.types),
    values: a.values === null ? b.values : b.values === null ? a.values : intersectValues(a.values, b.values),
    properties,
    required: new Set([...a.required, ...b.required]),
    items: a.items === null ? b.items : b.items === null ? a.items : intersect(a.items, b.items),
    closed: a.closed || b.closed,
  };
}

const canBe = (surface: Surface, type: string): boolean => surface.types === null || surface.types.has(type);

/** One of them applies (`oneOf`, `anyOf`). */
function unite(variants: readonly Surface[]): Surface {
  const properties = new Map<string, Surface>();
  for (const variant of variants) {
    for (const [name, property] of variant.properties) {
      const known = properties.get(name);
      properties.set(name, known === undefined ? property : unite([known, property]));
    }
  }
  const objects = variants.filter((variant) => canBe(variant, 'object'));
  const arrays = variants.filter((variant) => canBe(variant, 'array'));
  const items = arrays.map((variant) => variant.items);
  const typed = variants.map((variant) => variant.types);
  const valued = variants.map((variant) => variant.values);
  return {
    types: typed.includes(null) ? null : new Set(typed.flatMap((types) => [...(types ?? [])])),
    values: valued.includes(null) ? null : new Set(valued.flatMap((values) => [...(values ?? [])])),
    properties,
    // Present whenever the value is an object: required by every variant that can be one.
    required: new Set(
      [...(objects[0]?.required ?? [])].filter((name) => objects.every((variant) => variant.required.has(name))),
    ),
    items:
      items.length === 0 || items.includes(null)
        ? null
        : unite(items.filter((entry): entry is Surface => entry !== null)),
    closed: variants.every((variant) => variant.closed),
  };
}

/** The schema's surface; a reference already being followed (a recursive schema) allows anything. */
function flatten(contract: Contract, node: unknown, following: ReadonlySet<string> = new Set()): Surface {
  const schema = asNode(node);
  const types = typesOf(schema['type']);
  let surface: Surface = {
    types,
    values: valuesOf(schema, types),
    properties: new Map(
      Object.entries(asNode(schema['properties'] ?? {})).map(([name, property]) => [
        name,
        flatten(contract, property, following),
      ]),
    ),
    required: new Set(listOf(schema['required']).filter((name): name is string => typeof name === 'string')),
    items: schema['items'] === undefined ? null : flatten(contract, schema['items'], following),
    closed: schema['additionalProperties'] === false || schema['unevaluatedProperties'] === false,
  };
  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const target = following.has(ref) ? ANY : flatten(contract, contract.target(ref), new Set([...following, ref]));
    surface = intersect(surface, target);
  }
  for (const part of listOf(schema['allOf'])) surface = intersect(surface, flatten(contract, part, following));
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const variants = listOf(schema[keyword]);
    if (variants.length > 0) {
      surface = intersect(surface, unite(variants.map((variant) => flatten(contract, variant, following))));
    }
  }
  return surface;
}

const schemaOf = (contract: Contract, holder: Node): Surface => flatten(contract, holder['schema'] ?? {});

/** A request may only accept more: everything the frozen contract accepted is still accepted. */
function compareAccepted(before: Surface, after: Surface, at: string, found: string[]): void {
  if (
    after.types !== null &&
    (before.types === null || [...before.types].some((type) => !covers(after.types ?? new Set(), type)))
  ) {
    found.push(`${at}: accepts fewer types (${typeList(before.types)} → ${typeList(after.types)})`);
  }
  if (after.values !== null) {
    if (before.values === null) found.push(`${at}: now limited to listed values`);
    else for (const value of before.values) if (!after.values.has(value)) found.push(`${at}: value ${value} removed`);
  }
  if (!before.closed && after.closed) found.push(`${at}: closed to other properties`);
  for (const [name, property] of before.properties) {
    const now = after.properties.get(name);
    if (now === undefined) found.push(`${at}/${name}: removed`);
    else compareAccepted(property, now, `${at}/${name}`, found);
  }
  for (const name of after.required) if (!before.required.has(name)) found.push(`${at}/${name}: newly required`);
  if (before.items !== null || after.items !== null) {
    compareAccepted(before.items ?? ANY, after.items ?? ANY, `${at}[]`, found);
  }
}

/** A response keeps every promise: no new type, every value, property and always-present property it had. */
function compareReturned(before: Surface, after: Surface, at: string, found: string[]): void {
  if (
    before.types !== null &&
    (after.types === null || [...after.types].some((type) => !covers(before.types ?? new Set(), type)))
  ) {
    found.push(`${at}: may return other types (${typeList(before.types)} → ${typeList(after.types)})`);
  }
  if (before.values !== null) {
    if (after.values === null) found.push(`${at}: no longer limited to its values`);
    else for (const value of before.values) if (!after.values.has(value)) found.push(`${at}: value ${value} removed`);
  }
  for (const [name, property] of before.properties) {
    const now = after.properties.get(name);
    if (now === undefined) found.push(`${at}/${name}: removed`);
    else compareReturned(property, now, `${at}/${name}`, found);
  }
  for (const name of before.required) {
    const removed = before.properties.has(name) && !after.properties.has(name);
    if (!removed && !after.required.has(name)) found.push(`${at}/${name}: no longer always present`);
  }
  if (before.items !== null || after.items !== null) {
    compareReturned(before.items ?? ANY, after.items ?? ANY, `${at}[]`, found);
  }
}

function basePathOf(servers: unknown): string {
  const url = textOf(asNodeOrEmpty(listOf(servers)[0])['url'], '');
  return url === '' ? '' : new URL(url, 'https://base.invalid').pathname.replace(/\/$/, '');
}

function asNodeOrEmpty(value: unknown): Node {
  return value === undefined ? {} : asNode(value);
}

function parameterKey(parameter: Node): string {
  const location = textOf(parameter['in'], '?');
  const name = textOf(parameter['name'], '?');
  return `${location}:${location === 'header' ? name.toLowerCase() : name}`;
}

function operationsOf(contract: Contract): ReadonlyMap<string, Operation> {
  const { root } = contract;
  const operations = new Map<string, Operation>();
  for (const [template, rawItem] of Object.entries(asNode(root['paths'] ?? {}))) {
    const item = contract.resolve(rawItem);
    const base = basePathOf(item['servers'] ?? root['servers']);
    for (const method of HTTP_METHODS) {
      if (item[method] === undefined) continue;
      const operation = asNode(item[method]);
      const parameters = new Map<string, Node>();
      for (const raw of [...listOf(item['parameters']), ...listOf(operation['parameters'])]) {
        const parameter = contract.resolve(raw);
        parameters.set(parameterKey(parameter), parameter);
      }
      const id = textOf(operation['operationId'], `${method.toUpperCase()} ${template}`);
      operations.set(id, {
        id,
        method: method.toUpperCase(),
        path: `${base}${template}`,
        auth: listOf(operation['security'] ?? root['security']).length > 0,
        parameters,
        requestBody: operation['requestBody'] === undefined ? null : contract.resolve(operation['requestBody']),
        responses: new Map(
          Object.entries(asNode(operation['responses'] ?? {})).map(([status, response]) => [
            status,
            contract.resolve(response),
          ]),
        ),
      });
    }
  }
  return operations;
}

const contentOf = (holder: Node): Node => asNode(holder['content'] ?? {});

function headersOf(contract: Contract, response: Node): ReadonlyMap<string, Node> {
  return new Map(
    Object.entries(asNode(response['headers'] ?? {})).map(([name, header]) => [
      name.toLowerCase(),
      contract.resolve(header),
    ]),
  );
}

interface Pair {
  readonly was: Contract;
  readonly now: Contract;
}

function compareParameters({ was, now }: Pair, before: Operation, after: Operation, found: string[]): void {
  const { id } = before;
  for (const [key, parameter] of before.parameters) {
    const current = after.parameters.get(key);
    if (current === undefined) {
      found.push(`${id}: parameter ${key} removed`);
      continue;
    }
    if (current['required'] === true && parameter['required'] !== true)
      found.push(`${id}: parameter ${key} now required`);
    compareAccepted(schemaOf(was, parameter), schemaOf(now, current), `${id}: parameter ${key} #`, found);
  }
  for (const [key, parameter] of after.parameters) {
    if (!before.parameters.has(key) && parameter['required'] === true)
      found.push(`${id}: new required parameter ${key}`);
  }
}

function compareRequestBody({ was, now }: Pair, before: Operation, after: Operation, found: string[]): void {
  const { id } = before;
  const body = before.requestBody;
  const current = after.requestBody;
  if (body === null) {
    if (current?.['required'] === true) found.push(`${id}: request body now required`);
    return;
  }
  if (current === null) {
    found.push(`${id}: request body removed`);
    return;
  }
  if (current['required'] === true && body['required'] !== true) found.push(`${id}: request body now required`);
  for (const [media, content] of Object.entries(contentOf(body))) {
    const accepted = contentOf(current)[media];
    if (accepted === undefined) found.push(`${id}: request body ${media} removed`);
    else {
      compareAccepted(
        schemaOf(was, asNode(content)),
        schemaOf(now, asNode(accepted)),
        `${id}: request body ${media} #`,
        found,
      );
    }
  }
}

function compareResponses({ was, now }: Pair, before: Operation, after: Operation, found: string[]): void {
  const { id } = before;
  for (const [status, response] of before.responses) {
    const current = after.responses.get(status);
    if (current === undefined) {
      found.push(`${id}: response ${status} removed`);
      continue;
    }
    const headers = headersOf(now, current);
    for (const [name, header] of headersOf(was, response)) {
      const kept = headers.get(name);
      if (kept === undefined) found.push(`${id}: response ${status} header ${name} removed`);
      else
        compareReturned(
          schemaOf(was, header),
          schemaOf(now, kept),
          `${id}: response ${status} header ${name} #`,
          found,
        );
    }
    for (const [media, content] of Object.entries(contentOf(response))) {
      const returned = contentOf(current)[media];
      if (returned === undefined) found.push(`${id}: response ${status} ${media} removed`);
      else {
        compareReturned(
          schemaOf(was, asNode(content)),
          schemaOf(now, asNode(returned)),
          `${id}: response ${status} ${media} #`,
          found,
        );
      }
    }
  }
}

/**
 * Every change from `frozen` to `current` that can break a client of `frozen`, as readable lines; empty when the
 * current contract only adds. Operations whose ID is in `outside` are not compared.
 */
export function breakingChanges(frozen: object, current: object, outside: ReadonlySet<string> = new Set()): string[] {
  const pair: Pair = { was: new Contract(frozen), now: new Contract(current) };
  const found: string[] = [];
  const operations = operationsOf(pair.now);
  for (const [id, before] of operationsOf(pair.was)) {
    if (outside.has(id)) continue;
    const after = operations.get(id);
    if (after === undefined) {
      found.push(`${id}: removed`);
      continue;
    }
    if (before.method !== after.method || before.path !== after.path) {
      found.push(`${id}: moved from ${before.method} ${before.path} to ${after.method} ${after.path}`);
    }
    if (before.auth !== after.auth) {
      found.push(`${id}: authentication ${before.auth ? 'no longer required' : 'now required'}`);
    }
    compareParameters(pair, before, after, found);
    compareRequestBody(pair, before, after, found);
    compareResponses(pair, before, after, found);
  }
  return found;
}
