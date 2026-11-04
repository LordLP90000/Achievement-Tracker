import { z } from 'zod';

/** Request bodies of the sign-in method endpoints (`TotpCode`, …), mirroring `openapi/openapi.yaml`. */

/** `TotpCode` in the contract: the authenticator app's current 6-digit code. */
export const totpCode = z.string().regex(/^\d{6}$/);

export const confirmTotpRequest = z.strictObject({ code: totpCode });
