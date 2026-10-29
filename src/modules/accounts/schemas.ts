import { z } from 'zod';
import { LOCALES } from '../../platform/i18n/locales.ts';
import { canonicalTimeZone } from '../../platform/time/time-zones.ts';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password-policy.ts';

/** Request bodies of the account endpoints, mirroring `openapi/openapi.yaml` (`RegisterRequest`, …). */

const email = z.email().min(3).max(254);

/**
 * 12–128 Unicode code points, as JSON Schema counts them; Zod's own length checks count UTF-16 code units, which
 * would let 11 emoji pass and refuse 128 of them. Messages are static, like every validation message (R-IN-01).
 */
const password = z.string().superRefine((value, ctx) => {
  // More than twice the limit in code units is more than the limit in code points: no need to count them all.
  const length = value.length > 2 * PASSWORD_MAX_LENGTH ? Number.POSITIVE_INFINITY : Array.from(value).length;
  if (length < PASSWORD_MIN_LENGTH) ctx.addIssue({ code: 'custom', message: 'is too short' });
  if (length > PASSWORD_MAX_LENGTH) ctx.addIssue({ code: 'custom', message: 'is too long' });
});

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

export const tokenRequest = z.strictObject({ token: z.string().regex(OPAQUE_TOKEN) });
