import { z } from 'zod';
import { boundedText } from '../../platform/http/validation.ts';

/** Request bodies of the sign-in method endpoints (`TotpCode`, …), mirroring `openapi/openapi.yaml`. */

/** `TotpCode` in the contract: the authenticator app's current 6-digit code. */
export const totpCode = z.string().regex(/^\d{6}$/);

export const confirmTotpRequest = z.strictObject({ code: totpCode });

/** `Base64Url` and `CredentialId` in the contract. */
const base64url = z
  .string()
  .regex(/^[\w-]*$/)
  .max(16_384);
const credentialId = z
  .string()
  .regex(/^[\w-]+$/)
  .max(1366);

/**
 * `PasskeyRegistrationResponse`: the platform's `RegistrationResponseJSON`, open inside — a newer platform's extra
 * members are ignored — and verified as a whole by `platform/webauthn`.
 */
const registrationCredential = z.looseObject({
  id: credentialId,
  rawId: credentialId,
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: z.looseObject({}),
  response: z.looseObject({
    clientDataJSON: base64url,
    attestationObject: base64url,
    authenticatorData: base64url.optional(),
    transports: z.array(z.string().max(20)).max(10).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64url.optional(),
  }),
});

/**
 * `PasskeyAssertion`: the platform's `AuthenticationResponseJSON`, open inside, with the user handle discoverable
 * credentials always report; verified as a whole by `platform/webauthn`.
 */
export const passkeyAssertion = z.looseObject({
  id: credentialId,
  rawId: credentialId,
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
  clientExtensionResults: z.looseObject({}),
  response: z.looseObject({
    clientDataJSON: base64url,
    authenticatorData: base64url,
    signature: base64url,
    userHandle: base64url,
  }),
});

/** `PasskeyRegistrationRequest`: the result and an optional name (encrypted at rest). */
export const passkeyRegistrationRequest = z.strictObject({
  credential: registrationCredential,
  name: boundedText(1, 50).optional(),
});
