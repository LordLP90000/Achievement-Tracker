import { z } from 'zod';
import { boundedText } from '../../platform/http/validation.ts';
import { email, opaqueToken, password } from '../accounts/schemas.ts';

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
