import { z } from 'zod';
import { boundedText } from '../../platform/http/validation.ts';
import { email, opaqueToken, password } from '../accounts/schemas.ts';
import { totpCode } from '../sign-in-methods/schemas.ts';

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

export const reauthRequest = z.strictObject({ password });

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
