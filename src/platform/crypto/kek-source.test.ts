import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { envKekSource, KekSourceError, onePasswordConnectKekSource } from './kek-source.ts';

const VAULT = 'a1b2c3d4e5f6g7h8i9j0k1l2m3';
const ITEM = 'z9y8x7w6v5u4t3s2r1q0p9o8n7';
const TOKEN = 'connect-token-QzRmYjM1ZDYtNmQxNS00';
const KEK = randomBytes(32);

const kekItem = (value: string = KEK.toString('base64'), extra: Record<string, unknown> = {}) => ({
  id: ITEM,
  title: 'Questline KEK',
  version: 3,
  vault: { id: VAULT },
  category: 'PASSWORD',
  fields: [
    { id: 'notesPlain', type: 'STRING', purpose: 'NOTES', label: 'notesPlain', value: '' },
    { id: 'kek', type: 'CONCEALED', label: 'kek', value },
  ],
  ...extra,
});

interface Stub {
  readonly url: URL;
  readonly requests: { method: string; path: string; authorization: string | undefined }[];
  close(): Promise<void>;
}

const servers: Stub[] = [];

async function connectStub(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      authorization: request.headers.authorization,
    });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const stub: Stub = {
    url: new URL(`http://127.0.0.1:${String(port)}`),
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
  servers.push(stub);
  return stub;
}

const json = (status: number, body: unknown) => (_request: IncomingMessage, response: ServerResponse) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const source = (url: URL, timeoutMs = 2000) =>
  onePasswordConnectKekSource({ url, token: TOKEN, vaultId: VAULT, itemId: ITEM, timeoutMs });

async function failure(promise: Promise<unknown>): Promise<KekSourceError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(KekSourceError);
  const serialized = `${String(error)} ${JSON.stringify(error)}`;
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toContain(KEK.toString('base64'));
  return error as KekSourceError;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((stub) => stub.close()));
});

describe('onePasswordConnectKekSource (ADR-0013) [R-ENC-05, E-11]', () => {
  it('reads the KEK item with the Connect token and returns the key in guarded memory', async () => {
    const stub = await connectStub(json(200, kekItem()));

    const kek = await source(stub.url)();

    expect(stub.requests).toEqual([
      { method: 'GET', path: `/v1/vaults/${VAULT}/items/${ITEM}`, authorization: `Bearer ${TOKEN}` },
    ]);
    expect(Buffer.from(kek.key)).toEqual(KEK);
    expect(kek.key.secure).toBe(true);
    expect(kek).toMatchObject({ id: `onepassword:${VAULT}/${ITEM}`, version: 3 });
  });

  it('accepts the key in base64url as well', async () => {
    const stub = await connectStub(json(200, kekItem(KEK.toString('base64url'))));

    expect(Buffer.from((await source(stub.url)()).key)).toEqual(KEK);
  });

  it.each([401, 403, 404, 500])('refuses to start when Connect answers %s', async (status) => {
    const stub = await connectStub(json(status, { status, message: 'nope' }));

    expect((await failure(source(stub.url)())).code).toBe(`connect_http_${String(status)}`);
  });

  it('does not follow redirects, so the token is never sent anywhere else', async () => {
    const elsewhere = await connectStub(json(200, kekItem()));
    const stub = await connectStub((_request, response) => {
      response.writeHead(302, { location: new URL('/v1/vaults/x/items/y', elsewhere.url).href });
      response.end();
    });

    expect((await failure(source(stub.url)())).code).toBe('connect_unreachable');
    expect(elsewhere.requests).toEqual([]);
  });

  it('refuses to start when Connect does not answer in time', async () => {
    const stub = await connectStub(() => undefined);

    expect((await failure(source(stub.url, 150)())).code).toBe('connect_timeout');
  });

  it('refuses to start when Connect is unreachable', async () => {
    const stub = await connectStub(json(200, kekItem()));
    await stub.close();

    expect((await failure(source(stub.url)())).code).toBe('connect_unreachable');
  });

  it.each([
    ['a body that is not JSON', 'not json', 'invalid_item'],
    ['an item without a kek field', { ...kekItem(), fields: [] }, 'invalid_item'],
    ['an item without a version', { ...kekItem(), version: undefined }, 'invalid_item'],
    ['an item from another vault', kekItem(undefined, { vault: { id: ITEM } }), 'invalid_item'],
    ['a key that is not base64', kekItem('not base64 at all, sorry!!!!!!!!!!!!!!!!!!!'), 'invalid_kek'],
    ['a key with an embedded space', kekItem(KEK.toString('base64').replace(/^(.{10})/, '$1 ')), 'invalid_kek'],
    ['a key of 31 bytes', kekItem(randomBytes(31).toString('base64')), 'invalid_kek'],
    ['a key of 33 bytes', kekItem(randomBytes(33).toString('base64')), 'invalid_kek'],
    ['a key of identical bytes', kekItem(Buffer.alloc(32, 7).toString('base64')), 'invalid_kek'],
    ['a body over 64 KiB', { ...kekItem(), padding: 'x'.repeat(70_000) }, 'invalid_item'],
  ])('refuses %s', async (_name, body, code) => {
    const stub = await connectStub(json(200, body));

    expect((await failure(source(stub.url)())).code).toBe(code);
  });

  it.each([
    { vaultId: '../../v1/health', itemId: ITEM },
    { vaultId: VAULT, itemId: `${ITEM}?x=1` },
    { vaultId: VAULT.toUpperCase(), itemId: ITEM },
    { vaultId: VAULT.slice(1), itemId: ITEM },
  ])('refuses identifiers that could change the request path: %j', (ids) => {
    expect(() =>
      onePasswordConnectKekSource({ url: new URL('https://connect.example.test'), token: TOKEN, timeoutMs: 1, ...ids }),
    ).toThrow(new RangeError('1Password vault and item IDs must be 26 lower-case letters or digits'));
  });

  it('names its error and keeps only a code, the details the log is allowed to see', () => {
    const error = new KekSourceError('connect_timeout');

    expect(error.name).toBe('KekSourceError');
    expect(error.message).toBe('KEK unavailable (connect_timeout)');
  });
});

describe('envKekSource (development and tests only)', () => {
  it('copies a 32-byte key into guarded memory and wipes the given buffer', async () => {
    const given = Buffer.from(KEK);

    const kek = await envKekSource(given)();

    expect(Buffer.from(kek.key)).toEqual(KEK);
    expect(kek.key.secure).toBe(true);
    expect(kek).toMatchObject({ id: 'local', version: 1 });
    expect(given.every((byte) => byte === 0)).toBe(true);
  });

  it.each([31, 33])('refuses a key of %i bytes', (length) => {
    expect(() => envKekSource(randomBytes(length))).toThrow(new RangeError('the KEK must be 32 bytes'));
  });
});
