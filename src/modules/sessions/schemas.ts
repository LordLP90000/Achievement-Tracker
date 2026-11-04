import { z } from 'zod';
import { boundedText } from '../../platform/http/validation.ts';
import { email, opaqueToken, password } from '../accounts/schemas.ts';
import { passkeyAssertion, totpCode, type PasskeyAssertion } from '../sign-in-methods/schemas.ts';
import type { SecondFactor } from '../sign-in-methods/second-factor.ts';

/** Request bodies of the session endpoints (`LoginRequest`, refresh), mirroring `openapi/openapi.yaml`. */

export const CLIENTS = ['ios', 'android'] as const;

export const loginRequest = z.strictObject({
  email,
  password,
  client: z.enum(CLIENTS),
  // Q-09: optional, user-chosen, stored encrypted.
  device_label: boundedText(1, 64).optional(),
});

export type LoginRequest = z.output<typeof loginRequest>;

export const refreshRequest = z.strictObject({ refresh_token: opaqueToken });

/** `RecoveryCode` in the contract: as shown (`XXXX-XXXX-XXXX-XXXX`), any case, with or without hyphens and spaces. */
export const recoveryCode = z
  .string()
  .min(16)
  .max(32)
  .regex(/^[\d a-z-]+$/i);

/** `SecondFactorLoginRequest` in the contract: the token of the first step and exactly one code. */
export const secondFactorLoginRequest = z
  .strictObject({
    second_factor_token: opaqueToken,
    totp_code: totpCode.optional(),
    recovery_code: recoveryCode.optional(),
    client: z.enum(CLIENTS),
    device_label: boundedText(1, 64).optional(),
  })
  .refine((body) => (body.totp_code === undefined) !== (body.recovery_code === undefined), {
    message: 'needs exactly one of totp_code and recovery_code',
    when: (payload) => payload.issues.length === 0,
  });

export type SecondFactorLoginRequest = z.output<typeof secondFactorLoginRequest>;

/** How a step-up proves the user (ADR-0019): the password — with TOTP on, a code as well — or a passkey. */
export type StepUp =
  | { readonly method: 'password'; readonly password: string; readonly secondFactor: SecondFactor | undefined }
  | { readonly method: 'passkey'; readonly credential: PasskeyAssertion };

const secondFactorOf = (totp: string | undefined, recovery: string | undefined): SecondFactor | undefined => {
  if (totp !== undefined) return { totpCode: totp };
  return recovery === undefined ? undefined : { recoveryCode: recovery };
};

/**
 * `ReauthRequest` in the contract: exactly one of `password` and `passkey`; with the password at most one code,
 * with the passkey none.
 */
export const reauthRequest = z
  .strictObject({
    password: password.optional(),
    totp_code: totpCode.optional(),
    recovery_code: recoveryCode.optional(),
    passkey: passkeyAssertion.optional(),
  })
  .transform((body, ctx): StepUp => {
    const codes = [body.totp_code, body.recovery_code].filter((code) => code !== undefined).length;
    if (body.passkey !== undefined && body.password === undefined && codes === 0) {
      return { method: 'passkey', credential: body.passkey };
    }
    if (body.password !== undefined && body.passkey === undefined && codes < 2) {
      return {
        method: 'password',
        password: body.password,
        secondFactor: secondFactorOf(body.totp_code, body.recovery_code),
      };
    }
    ctx.issues.push({ code: 'custom', message: 'needs a password, with at most one code, or a passkey', input: body });
    return z.NEVER;
  });

/** `PasskeyLoginRequest` in the contract: the platform's assertion and the device. */
export const passkeyLoginRequest = z.strictObject({
  credential: passkeyAssertion,
  client: z.enum(CLIENTS),
  device_label: boundedText(1, 64).optional(),
});

export type PasskeyLoginRequest = z.output<typeof passkeyLoginRequest>;
