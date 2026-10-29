import { z } from 'zod';
import { boundedText } from '../../platform/http/validation.ts';
import { LOCALES } from '../../platform/i18n/locales.ts';
import { canonicalTimeZone } from '../../platform/time/time-zones.ts';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password-policy.ts';

/** Request bodies of the account endpoints, mirroring `openapi/openapi.yaml` (`RegisterRequest`, …). */

/** `Email` in the contract. */
export const email = z.email().min(3).max(254);

/** `Password` in the contract: 12–128 characters, any Unicode, no composition rules (R-AUTH-02). */
export const password = boundedText(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH);

/** An IANA time zone, stored under its canonical name (A-02). */
const timezone = z.string().transform((value, ctx) => {
  const canonical = canonicalTimeZone(value);
  if (canonical === undefined) {
    ctx.addIssue({ code: 'custom', message: 'is not a supported time zone' });
    return z.NEVER;
  }
  return canonical;
});

const OPAQUE_TOKEN = /^ql_[a-z]{2}_[\w-]{43}$/;

/** `OpaqueToken` in the contract; the kind is checked where the token is used. */
export const opaqueToken = z.string().regex(OPAQUE_TOKEN);

export const registerRequest = z.strictObject({
  email,
  password,
  timezone: timezone.optional(),
  locale: z.enum(LOCALES).optional(),
  privacy_policy_version: z.iso.date(),
  // Self-declaration of being at least 13 (R-AUTH-11); no date of birth is ever asked for.
  age_confirmed: z.literal(true),
});

export type RegisterRequest = z.output<typeof registerRequest>;

export const emailRequest = z.strictObject({ email });

export const tokenRequest = z.strictObject({ token: opaqueToken });

export const changePasswordRequest = z.strictObject({ current_password: password, new_password: password });

export const resetPasswordRequest = z.strictObject({ token: opaqueToken, new_password: password });
