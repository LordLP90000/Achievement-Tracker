import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BODY_LIMIT_BYTES } from '../../src/app.ts';
import { toDayNumber } from '../../src/domain/dates.ts';
import { parseDecimal } from '../../src/domain/decimal.ts';
import { email, opaqueToken } from '../../src/modules/accounts/schemas.ts';
import { bearerTokenOf } from '../../src/modules/sessions/guard.ts';
import { tokenHash } from '../../src/platform/crypto/tokens.ts';
import { parseIfMatch } from '../../src/platform/http/concurrency.ts';
import { decodeCursor, pageParams } from '../../src/platform/http/pagination.ts';
import { decimalText, isUuidV4 } from '../../src/platform/http/validation.ts';
import { canonicalTimeZone } from '../../src/platform/time/time-zones.ts';
import { spec } from '../helpers/openapi.ts';

/** The threat model's bound for one adversarial input (D-08). */
const BUDGET_MS = 5;
/** No client input is longer than a request body may be. */
const LENGTH = BODY_LIMIT_BYTES;

/** Prefixes that let an input reach deep into a pattern before it fails, and fillers that loop there. */
const PREFIXES = ['', 'ql_vr_', 'urn:questline:problem:', '"', '-', '1.', '2026-10-', 'bearer ', 'Europe/', 'a@'];
const FILLERS = ['a', 'Z', '0', '9', '-', '_', '.', ' ', '@', '"', '/', '+', '=', 'é'];
const ADVERSARIAL = PREFIXES.flatMap((prefix) =>
  FILLERS.map((filler) => `${prefix}${filler.repeat(LENGTH - prefix.length - 1)}!`),
);

/** Every `pattern` of the contract, with where it occurs. */
function contractPatterns(node: unknown, path = '', found = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(node)) node.forEach((item, index) => contractPatterns(item, `${path}/${String(index)}`, found));
  else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'pattern' && typeof value === 'string') found.set(value, path);
      else contractPatterns(value, `${path}/${key}`, found);
    }
  }
  return found;
}

/** The slowest adversarial input for `check`: the best of three runs each, so a pause of the collector is no cause. */
function slowest(check: (input: string) => unknown): { readonly ms: number; readonly input: string } {
  check('warm-up');
  let worst = { ms: 0, input: '' };
  for (const input of ADVERSARIAL) {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3 && best > BUDGET_MS / 10; run += 1) {
      const started = performance.now();
      check(input);
      best = Math.min(best, performance.now() - started);
    }
    if (best > worst.ms) worst = { ms: best, input: input.slice(0, 30) };
    // One input over the budget decides it; the rest would only take long.
    if (worst.ms >= BUDGET_MS) break;
  }
  return worst;
}

const quietly = (parse: (input: string) => unknown) => (input: string) => {
  try {
    parse(input);
  } catch {
    // Refusing the input is what most of them do.
  }
};

/**
 * Validation patterns stay linear (D-08): no input a client can send — at most a request body long — keeps a pattern
 * busy for more than 5 ms, neither in the contract (which clients may validate with) nor in the parsers that the
 * server applies to client input. ESLint (`eslint-plugin-regexp`) checks the server's patterns statically as well.
 */
describe('validation patterns [D-08]', () => {
  const patterns = [...contractPatterns(spec)];

  it('finds the contract’s patterns', () => {
    expect(patterns.length).toBeGreaterThanOrEqual(7);
  });

  it.each(patterns)('the contract pattern %s (%s) stays linear', (pattern) => {
    const regex = new RegExp(pattern, 'u');

    expect(slowest((input) => regex.test(input)).ms).toBeLessThan(BUDGET_MS);
  });

  it.each([
    ['path and body IDs (isUuidV4)', (input: string) => isUuidV4(input)],
    ['decimals (decimalText)', (input: string) => decimalText.safeParse(input)],
    ['decimal values (parseDecimal)', quietly(parseDecimal)],
    ['local dates (z.iso.date)', (input: string) => z.iso.date().safeParse(input)],
    ['local dates (toDayNumber)', quietly(toDayNumber)],
    ['page cursors (pageParams)', (input: string) => pageParams.cursor.safeParse(input)],
    ['page cursors (decodeCursor)', (input: string) => decodeCursor(input)],
    ['page sizes (pageParams)', (input: string) => pageParams.limit.safeParse(input)],
    ['If-Match (parseIfMatch)', (input: string) => parseIfMatch(input)],
    ['Authorization (bearerTokenOf)', (input: string) => bearerTokenOf(input)],
    ['opaque tokens (opaqueToken)', (input: string) => opaqueToken.safeParse(input)],
    ['opaque tokens (tokenHash)', (input: string) => tokenHash('verification', input)],
    ['addresses (email)', (input: string) => email.safeParse(input)],
    ['time zones (canonicalTimeZone)', (input: string) => canonicalTimeZone(input)],
  ])('the parser of %s stays linear', (_name, check) => {
    expect(slowest(check).ms).toBeLessThan(BUDGET_MS);
  });
});
