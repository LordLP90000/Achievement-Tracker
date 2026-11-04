import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeErrors, validatorFor } from '../../../test/helpers/openapi.ts';
import {
  assert,
  otherKey,
  register,
  type AssertionSettings,
  type PasskeyAlgorithm,
  type SoftwarePasskey,
} from '../../../test/helpers/software-authenticator.ts';
import type { WebAuthnConfig } from '../config/config.ts';
import {
  challengeHash,
  claimedAssertion,
  claimedChallenge,
  creationOptions,
  issueChallenge,
  requestOptions,
  verifyAssertion,
  verifyRegistration,
  type RegisteredPasskey,
} from './webauthn.ts';

const ANDROID_ORIGIN = `android:apk-key-hash:${createHash('sha256').update('questline-release-key').digest('base64url')}`;
const CONFIG: WebAuthnConfig = {
  rpId: 'questline.test',
  rpName: 'Questline',
  origins: ['https://questline.test', ANDROID_ORIGIN],
};
const ORIGIN = 'https://questline.test';
const USER_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

const registrationOptions = (userId = USER_ID) =>
  creationOptions(CONFIG, {
    challenge: issueChallenge().challenge,
    userId,
    userName: 'anna@example.test',
    exclude: [],
  });

/** A passkey registered through the wrapper, as the API stores it. */
async function registered(
  settings: { algorithm?: PasskeyAlgorithm; count?: 'increment' | 'zero' } = {},
): Promise<{ passkey: SoftwarePasskey; stored: RegisteredPasskey }> {
  const options = registrationOptions();
  const { credential, passkey } = register(options, { origin: ORIGIN, ...settings });
  const stored = await verifyRegistration(CONFIG, credential, options.challenge);
  if (stored === undefined) throw new Error('the registration did not verify');
  return { passkey, stored };
}

const tamper = (credential: Record<string, unknown>, change: (copy: Record<string, unknown>) => void) => {
  const copy = structuredClone(credential);
  change(copy);
  return copy;
};

describe('WebAuthn challenges [ADR-0019]', () => {
  it('issues 32 random bytes as unpadded base64url and keeps only their SHA-256', () => {
    const first = issueChallenge();
    const second = issueChallenge();

    expect(first.challenge).toMatch(/^[\w-]{43}$/);
    expect(first.hash).toEqual(createHash('sha256').update(Buffer.from(first.challenge, 'base64url')).digest());
    expect(challengeHash(first.challenge)).toEqual(first.hash);
    expect(second.challenge).not.toBe(first.challenge);
  });

  it.each([
    ['31 bytes', randomBytes(31).toString('base64url')],
    ['33 bytes', randomBytes(33).toString('base64url')],
    ['padding', `${randomBytes(32).toString('base64url')}=`],
    ['a character outside base64url', `${randomBytes(32).toString('base64url').slice(0, 42)}.`],
    ['non-zero padding bits', `${randomBytes(32).toString('base64url').slice(0, 42)}B`],
    ['nothing', ''],
  ])('has no hash for a challenge with %s', (_label, challenge) => {
    expect(challengeHash(challenge)).toBeUndefined();
  });
});

describe('WebAuthn options [ADR-0019]', () => {
  it('asks to create a discoverable passkey with user verification, no attestation and the three algorithms', () => {
    const challenge = issueChallenge().challenge;
    const known = randomBytes(32);

    const options = creationOptions(CONFIG, {
      challenge,
      userId: USER_ID,
      userName: 'anna@example.test',
      exclude: [
        { credentialId: known, transports: ['internal', 'hybrid'] },
        { credentialId: Buffer.of(1, 2, 3), transports: [] },
      ],
    });

    const validate = validatorFor({ $ref: '#/components/schemas/PasskeyCreationOptions' });
    expect(validate(options), describeErrors(validate)).toBe(true);
    expect(options).toEqual({
      rp: { id: 'questline.test', name: 'Questline' },
      user: {
        id: Buffer.from(USER_ID.replaceAll('-', ''), 'hex').toString('base64url'),
        name: 'anna@example.test',
        displayName: 'anna@example.test',
      },
      challenge,
      pubKeyCredParams: [
        { type: 'public-key', alg: -8 },
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: 300_000,
      excludeCredentials: [
        { id: known.toString('base64url'), type: 'public-key', transports: ['internal', 'hybrid'] },
        { id: 'AQID', type: 'public-key' },
      ],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none',
      extensions: { credProps: true },
    });
  });

  it('asks to sign in with any discoverable passkey of the relying party, with user verification', () => {
    const challenge = issueChallenge().challenge;

    const options = requestOptions(CONFIG, challenge);

    const validate = validatorFor({ $ref: '#/components/schemas/PasskeyRequestOptions' });
    expect(validate(options), describeErrors(validate)).toBe(true);
    expect(options).toEqual({ challenge, timeout: 300_000, rpId: 'questline.test', userVerification: 'required' });
  });
});

describe('passkey registration [ADR-0019, R-AUTH-01]', () => {
  it.each(['EdDSA', 'ES256', 'RS256'] as const)(
    'verifies a %s passkey and returns what to store',
    async (algorithm) => {
      const options = registrationOptions();
      const { credential, passkey } = register(options, { origin: ORIGIN, algorithm });

      const stored = await verifyRegistration(CONFIG, credential, options.challenge);

      expect(stored).toEqual({
        credentialId: passkey.credentialId,
        publicKey: passkey.publicKey,
        signCount: 1,
        transports: ['internal', 'hybrid'],
        backedUp: true,
      });
    },
  );

  it("accepts the Android app's origin and a passkey that is not backed up", async () => {
    const options = registrationOptions();
    const { credential } = register(options, { origin: ANDROID_ORIGIN, backedUp: false });

    expect(await verifyRegistration(CONFIG, credential, options.challenge)).toMatchObject({ backedUp: false });
  });

  it("accepts a credential ID and a key at the columns' limits: 1 023 and 2 048 bytes", async () => {
    const options = registrationOptions();
    const { credential } = register(options, { origin: ORIGIN, credentialIdBytes: 1023, publicKeyBytes: 2048 });

    const stored = await verifyRegistration(CONFIG, credential, options.challenge);

    expect([stored?.credentialId.length, stored?.publicKey.length]).toEqual([1023, 2048]);
  });

  it('accepts a packed self-attestation and refuses one its key did not sign', async () => {
    const options = registrationOptions();
    const genuine = register(options, { origin: ORIGIN, attestation: { format: 'packed' } });
    const forged = register(options, { origin: ORIGIN, attestation: { format: 'packed', signWith: otherKey() } });

    expect(await verifyRegistration(CONFIG, genuine.credential, options.challenge)).toMatchObject({ signCount: 1 });
    expect(await verifyRegistration(CONFIG, forged.credential, options.challenge)).toBeUndefined();
  });

  it('keeps only the transports WebAuthn defines, each once, and none when the platform reports none', async () => {
    const options = registrationOptions();
    const transports = ['usb', 'internal', 'usb', 'carrier-pigeon', 'hybrid', 'smart-card', ''];
    const { credential } = register(options, { origin: ORIGIN, transports });
    const { credential: silent } = register(options, { origin: ORIGIN, transports: null });

    const stored = await verifyRegistration(CONFIG, credential, options.challenge);

    expect(stored?.transports).toEqual(['usb', 'internal', 'hybrid', 'smart-card']);
    expect((await verifyRegistration(CONFIG, silent, options.challenge))?.transports).toEqual([]);
  });

  it.each([
    ['another origin', { origin: 'https://evil.test' }],
    ['a subdomain that is not configured', { origin: 'https://app.questline.test' }],
    ['another relying party', { rpId: 'evil.test' }],
    ['a sign-in instead of a creation', { type: 'webauthn.get' }],
    ['another challenge', { challenge: issueChallenge().challenge }],
    ['no user verification', { userVerified: false }],
    ['no user presence', { userPresent: false }],
    ['an algorithm the options did not offer (ES384)', { algorithm: 'ES384' as const }],
    ['a credential ID over 1 023 bytes', { credentialIdBytes: 1024 }],
    ['a public key over 2 048 bytes', { publicKeyBytes: 2049 }],
  ])('refuses a registration with %s', async (_label, settings) => {
    const options = registrationOptions();
    const { credential } = register(options, { origin: ORIGIN, ...settings });

    expect(await verifyRegistration(CONFIG, credential, options.challenge)).toBeUndefined();
  });

  it.each([
    [
      'an ID other than the registered one',
      (copy: Record<string, unknown>) => {
        copy['id'] = randomBytes(32).toString('base64url');
        copy['rawId'] = copy['id'];
      },
    ],
    [
      'an ID that differs from its raw ID',
      (copy: Record<string, unknown>) => {
        copy['rawId'] = randomBytes(32).toString('base64url');
      },
    ],
    [
      'a broken attestation object',
      (copy: Record<string, unknown>) => {
        (copy['response'] as Record<string, unknown>)['attestationObject'] = 'AAAA';
      },
    ],
    ['no response', (copy: Record<string, unknown>) => Reflect.deleteProperty(copy, 'response')],
  ])('refuses a registration result with %s', async (_label, change) => {
    const options = registrationOptions();
    const { credential } = register(options, { origin: ORIGIN });

    expect(await verifyRegistration(CONFIG, tamper(credential, change), options.challenge)).toBeUndefined();
  });

  it.each([null, 'credential', 42, [], {}])('refuses %j as a registration result', async (credential) => {
    expect(await verifyRegistration(CONFIG, credential, issueChallenge().challenge)).toBeUndefined();
  });

  it('reads the challenge a registration result claims to sign, before verifying anything', () => {
    const options = registrationOptions();
    const { credential } = register(options, { origin: ORIGIN });

    expect(claimedChallenge(credential)).toBe(options.challenge);
    expect(claimedChallenge(register(options, { origin: ORIGIN, challenge: 'c2hvcnQ' }).credential)).toBeUndefined();
    expect(claimedChallenge({ response: { clientDataJSON: Buffer.from('{').toString('base64url') } })).toBeUndefined();
    expect(claimedChallenge({ response: { clientDataJSON: '***' } })).toBeUndefined();
    expect(claimedChallenge({ response: {} })).toBeUndefined();
    expect(claimedChallenge(null)).toBeUndefined();
  });
});

describe('passkey sign-in [ADR-0019, R-AUTH-01, S-01]', () => {
  const signIn = (passkey: SoftwarePasskey, settings: AssertionSettings = { origin: ORIGIN }) => {
    const challenge = issueChallenge().challenge;
    return { challenge, credential: assert(passkey, requestOptions(CONFIG, challenge), settings) };
  };

  it('reads the challenge, the credential and the account an assertion claims, before verifying anything', () => {
    const userId = randomUUID();
    const { passkey } = register(registrationOptions(userId), { origin: ORIGIN });

    const { challenge, credential } = signIn(passkey);

    expect(claimedAssertion(credential)).toEqual({ challenge, credentialId: passkey.credentialId, userId });
  });

  it.each([
    ['no user handle', { userHandle: '' }],
    ['a user handle that is not 16 bytes', { userHandle: Buffer.from('anna').toString('base64url') }],
    ['a user handle that is not base64url', { userHandle: `${randomBytes(16).toString('base64')}!` }],
    ['a challenge that is not 32 bytes', { challenge: 'c2hvcnQ' }],
  ])('claims nothing for an assertion with %s', async (_label, settings) => {
    const { passkey } = await registered();

    expect(claimedAssertion(signIn(passkey, { origin: ORIGIN, ...settings }).credential)).toBeUndefined();
  });

  it('claims nothing for an assertion whose ID differs from its raw ID, is empty or not base64url, or that is no object', async () => {
    const { passkey } = await registered();
    const { credential } = signIn(passkey);

    expect(claimedAssertion({ ...credential, rawId: randomBytes(32).toString('base64url') })).toBeUndefined();
    expect(claimedAssertion({ ...credential, id: '', rawId: '' })).toBeUndefined();
    expect(claimedAssertion({ ...credential, id: 'not base64url', rawId: 'not base64url' })).toBeUndefined();
    expect(claimedAssertion({ ...credential, response: 'signed' })).toBeUndefined();
    expect(claimedAssertion(null)).toBeUndefined();
    expect(claimedAssertion('credential')).toBeUndefined();
  });

  it.each(['EdDSA', 'ES256', 'RS256'] as const)(
    'verifies a %s sign-in and returns the new counter',
    async (algorithm) => {
      const { passkey, stored } = await registered({ algorithm });
      const { challenge, credential } = signIn(passkey);

      expect(await verifyAssertion(CONFIG, credential, challenge, stored)).toEqual({
        outcome: 'verified',
        signCount: 2,
        backedUp: true,
      });
    },
  );

  it('accepts the counter 0 again and again from an authenticator that always reports 0', async () => {
    const { passkey, stored } = await registered({ count: 'zero' });

    for (let round = 0; round < 2; round += 1) {
      const { challenge, credential } = signIn(passkey);
      expect(await verifyAssertion(CONFIG, credential, challenge, stored)).toMatchObject({ outcome: 'verified' });
    }
  });

  it.each([
    ['the same counter', 5, 5],
    ['a lower counter', 5, 3],
    ['0 after counting', 5, 0],
  ])('reports a possible clone for a valid signature with %s', async (_label, storedCount, reported) => {
    const { passkey, stored } = await registered();
    const { challenge, credential } = signIn(passkey, { origin: ORIGIN, counter: reported });

    expect(await verifyAssertion(CONFIG, credential, challenge, { ...stored, signCount: storedCount })).toEqual({
      outcome: 'counter_not_increased',
    });
  });

  it('calls a forged signature invalid, not a clone, whatever counter it reports', async () => {
    const { passkey, stored } = await registered();
    const { challenge, credential } = signIn(passkey, { origin: ORIGIN, counter: 3, signWith: otherKey() });

    expect(await verifyAssertion(CONFIG, credential, challenge, { ...stored, signCount: 5 })).toEqual({
      outcome: 'invalid',
    });
  });

  it.each([
    ['another origin', { origin: 'https://evil.test' }],
    ['another relying party', { rpId: 'evil.test' }],
    ['a creation instead of a sign-in', { type: 'webauthn.create' }],
    ['another challenge', { challenge: issueChallenge().challenge }],
    ['no user verification', { userVerified: false }],
    ['no user presence', { userPresent: false }],
    ['a forged signature', { signWith: otherKey() }],
  ])('refuses a sign-in with %s', async (_label, settings) => {
    const { passkey, stored } = await registered();
    const { challenge, credential } = signIn(passkey, { origin: ORIGIN, ...settings });

    expect(await verifyAssertion(CONFIG, credential, challenge, stored)).toEqual({ outcome: 'invalid' });
  });

  it("refuses a sign-in checked against another passkey's key or ID", async () => {
    const { passkey, stored } = await registered();
    const { stored: other } = await registered();
    const { challenge, credential } = signIn(passkey);

    expect(await verifyAssertion(CONFIG, credential, challenge, { ...stored, publicKey: other.publicKey })).toEqual({
      outcome: 'invalid',
    });
    expect(
      await verifyAssertion(CONFIG, credential, challenge, { ...stored, credentialId: other.credentialId }),
    ).toEqual({ outcome: 'invalid' });
  });

  it.each([null, 'credential', {}, { response: {} }])('refuses %j as a sign-in', async (credential) => {
    const { stored } = await registered();

    expect(await verifyAssertion(CONFIG, credential, issueChallenge().challenge, stored)).toEqual({
      outcome: 'invalid',
    });
  });
});
