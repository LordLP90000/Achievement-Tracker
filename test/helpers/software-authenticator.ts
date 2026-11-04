import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * A software passkey authenticator for real WebAuthn ceremonies in tests (ADR-0019), written from the spec rather than
 * with the library under test: it builds `clientDataJSON`, authenticator data and a `none` attestation in CBOR, and
 * signs assertions with its own key. Every field a verifier must check can be bent: origin, RP ID, type, flags,
 * counter, signing key, user handle.
 */

export type PasskeyAlgorithm = 'ES256' | 'EdDSA' | 'RS256' | 'ES384';

/** The options the API hands out, as far as the authenticator reads them. */
export interface CreationOptions {
  readonly challenge: string;
  readonly rp: { readonly id: string };
  readonly user: { readonly id: string };
}

export interface RequestOptions {
  readonly challenge: string;
  readonly rpId: string;
}

export interface SoftwarePasskey {
  readonly algorithm: PasskeyAlgorithm;
  readonly credentialId: Buffer;
  readonly privateKey: KeyObject;
  /** The COSE public key the authenticator registered. */
  readonly publicKey: Buffer;
  /** The user handle (`user.id` of the creation options), base64url. */
  readonly userHandle: string;
  readonly rpId: string;
  /** The signature counter after the last ceremony; `count: 'zero'` authenticators always report 0. */
  counter: number;
  readonly count: 'increment' | 'zero';
}

export interface CeremonySettings {
  /** Where the platform says the ceremony took place, e.g. `https://questline.test`. */
  readonly origin: string;
  /** The RP ID the authenticator data is bound to; the options' by default. */
  readonly rpId?: string;
  /** `clientDataJSON.type`; `webauthn.create` / `webauthn.get` by default. */
  readonly type?: string;
  /** The challenge signed; the options' by default. */
  readonly challenge?: string;
  readonly userPresent?: boolean;
  readonly userVerified?: boolean;
  readonly backedUp?: boolean;
}

export interface RegistrationSettings extends CeremonySettings {
  readonly algorithm?: PasskeyAlgorithm;
  readonly credentialIdBytes?: number;
  /** `null` reports none, as some platforms do. */
  readonly transports?: readonly string[] | null;
  readonly count?: 'increment' | 'zero';
  /** `packed` self-attestation instead of `none`, signed with this key if given (a forged attestation). */
  readonly attestation?: { readonly format: 'packed'; readonly signWith?: KeyObject };
  /** Pads the COSE public key with an unassigned label to exactly this many bytes. */
  readonly publicKeyBytes?: number;
}

export interface AssertionSettings extends CeremonySettings {
  /** The counter reported; the next one by default. */
  readonly counter?: number;
  /** Signs with another key, as a forger would. */
  readonly signWith?: KeyObject;
  /** Reports another user handle, base64url. */
  readonly userHandle?: string;
}

const FLAGS = { up: 0x01, uv: 0x04, be: 0x08, bs: 0x10, at: 0x40 } as const;
const COSE_ALG: Readonly<Record<PasskeyAlgorithm, number>> = { ES256: -7, EdDSA: -8, RS256: -257, ES384: -35 };

type Cbor = number | string | Uint8Array | ReadonlyMap<Cbor, Cbor>;

function cborHead(major: number, length: number): Buffer {
  const type = major << 5;
  if (length < 24) return Buffer.of(type | length);
  if (length < 0x100) return Buffer.of(type | 24, length);
  if (length < 0x10000) return Buffer.of(type | 25, length >> 8, length & 0xff);
  const head = Buffer.alloc(5);
  head[0] = type | 26;
  head.writeUInt32BE(length, 1);
  return head;
}

/** Definite-length CBOR (RFC 8949) for the types WebAuthn needs: integers, text, bytes and maps. */
export function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') {
    const text = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, text.length), text]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), value]);
  return Buffer.concat([cborHead(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
}

const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest();
const fromJwk = (value: string | undefined): Buffer => Buffer.from(value ?? '', 'base64url');

function keyPair(algorithm: PasskeyAlgorithm): { privateKey: KeyObject; cose: ReadonlyMap<Cbor, Cbor> } {
  switch (algorithm) {
    case 'ES256':
    case 'ES384': {
      const curve = algorithm === 'ES256' ? 'P-256' : 'P-384';
      const pair = generateKeyPairSync('ec', { namedCurve: curve });
      const jwk = pair.publicKey.export({ format: 'jwk' });
      const cose = new Map<Cbor, Cbor>([
        [1, 2],
        [3, COSE_ALG[algorithm]],
        [-1, algorithm === 'ES256' ? 1 : 2],
        [-2, fromJwk(jwk.x)],
        [-3, fromJwk(jwk.y)],
      ]);
      return { privateKey: pair.privateKey, cose };
    }
    case 'EdDSA': {
      const pair = generateKeyPairSync('ed25519');
      const jwk = pair.publicKey.export({ format: 'jwk' });
      const cose = new Map<Cbor, Cbor>([
        [1, 1],
        [3, COSE_ALG.EdDSA],
        [-1, 6],
        [-2, fromJwk(jwk.x)],
      ]);
      return { privateKey: pair.privateKey, cose };
    }
    case 'RS256': {
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const jwk = pair.publicKey.export({ format: 'jwk' });
      const cose = new Map<Cbor, Cbor>([
        [1, 3],
        [3, COSE_ALG.RS256],
        [-1, fromJwk(jwk.n)],
        [-2, fromJwk(jwk.e)],
      ]);
      return { privateKey: pair.privateKey, cose };
    }
  }
}

/** The COSE key, padded with the unassigned label 99 to exactly `size` bytes if given. */
function encodedKey(cose: ReadonlyMap<Cbor, Cbor>, size: number | undefined): Buffer {
  if (size === undefined) return cbor(cose);
  for (let padding = 0; ; padding += 1) {
    const encoded = cbor(new Map<Cbor, Cbor>([...cose, [99, Buffer.alloc(padding)]]));
    if (encoded.length === size) return encoded;
    if (encoded.length > size) throw new Error(`a COSE key of exactly ${String(size)} bytes cannot be built`);
  }
}

function signatureOf(algorithm: PasskeyAlgorithm, key: KeyObject, data: Buffer): Buffer {
  switch (algorithm) {
    case 'ES256':
      return sign('sha256', data, { key, dsaEncoding: 'der' });
    case 'ES384':
      return sign('sha384', data, { key, dsaEncoding: 'der' });
    case 'EdDSA':
      return sign(null, data, key);
    case 'RS256':
      return sign('sha256', data, key);
  }
}

function flagsOf(settings: CeremonySettings, extra: number): number {
  return (
    extra |
    (settings.userPresent === false ? 0 : FLAGS.up) |
    (settings.userVerified === false ? 0 : FLAGS.uv) |
    (settings.backedUp === false ? 0 : FLAGS.be | FLAGS.bs)
  );
}

function clientData(type: string, challenge: string, origin: string): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
}

const counterBytes = (counter: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(counter);
  return bytes;
};

/** Creates a passkey for the options, as `navigator.credentials.create()` would: the platform's JSON and the key. */
export function register(
  options: CreationOptions,
  settings: RegistrationSettings,
): { readonly credential: Record<string, unknown>; readonly passkey: SoftwarePasskey } {
  const algorithm = settings.algorithm ?? 'ES256';
  const { privateKey, cose } = keyPair(algorithm);
  const publicKey = encodedKey(cose, settings.publicKeyBytes);
  const credentialId = randomBytes(settings.credentialIdBytes ?? 32);
  const rpId = settings.rpId ?? options.rp.id;
  const count = settings.count ?? 'increment';
  const counter = count === 'zero' ? 0 : 1;
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    sha256(rpId),
    Buffer.of(flagsOf(settings, FLAGS.at)),
    counterBytes(counter),
    Buffer.alloc(16),
    idLength,
    credentialId,
    publicKey,
  ]);
  const clientDataJSON = clientData(
    settings.type ?? 'webauthn.create',
    settings.challenge ?? options.challenge,
    settings.origin,
  );
  const attestation = settings.attestation;
  const attStmt =
    attestation === undefined
      ? new Map<Cbor, Cbor>()
      : new Map<Cbor, Cbor>([
          ['alg', COSE_ALG[algorithm]],
          [
            'sig',
            signatureOf(
              algorithm,
              attestation.signWith ?? privateKey,
              Buffer.concat([authData, sha256(clientDataJSON)]),
            ),
          ],
        ]);
  const attestationObject = cbor(
    new Map<Cbor, Cbor>([
      ['fmt', attestation === undefined ? 'none' : attestation.format],
      ['attStmt', attStmt],
      ['authData', authData],
    ]),
  );
  const id = credentialId.toString('base64url');
  return {
    credential: {
      id,
      rawId: id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: { credProps: { rk: true } },
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        ...(settings.transports === null ? {} : { transports: [...(settings.transports ?? ['internal', 'hybrid'])] }),
      },
    },
    passkey: { algorithm, credentialId, privateKey, publicKey, userHandle: options.user.id, rpId, counter, count },
  };
}

/** Signs in with the passkey for the options, as `navigator.credentials.get()` would, and returns the platform's JSON. */
export function assert(
  passkey: SoftwarePasskey,
  options: RequestOptions,
  settings: AssertionSettings,
): Record<string, unknown> {
  const counter = settings.counter ?? (passkey.count === 'zero' ? 0 : passkey.counter + 1);
  passkey.counter = counter;
  const authData = Buffer.concat([
    sha256(settings.rpId ?? options.rpId),
    Buffer.of(flagsOf(settings, 0)),
    counterBytes(counter),
  ]);
  const data = clientData(settings.type ?? 'webauthn.get', settings.challenge ?? options.challenge, settings.origin);
  const signature = signatureOf(
    passkey.algorithm,
    settings.signWith ?? passkey.privateKey,
    Buffer.concat([authData, sha256(data)]),
  );
  const id = passkey.credentialId.toString('base64url');
  return {
    id,
    rawId: id,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    clientExtensionResults: {},
    response: {
      clientDataJSON: data.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: signature.toString('base64url'),
      userHandle: settings.userHandle ?? passkey.userHandle,
    },
  };
}

/** Another key of the same kind, for forged signatures. */
export function otherKey(algorithm: PasskeyAlgorithm = 'ES256'): KeyObject {
  return keyPair(algorithm).privateKey;
}
