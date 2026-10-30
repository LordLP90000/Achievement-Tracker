import type { FastifyReply, FastifyRequest } from 'fastify';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';
const MAX_INSTANCE_LENGTH = 300;

export interface ProblemFieldError {
  readonly pointer: string;
  readonly message: string;
}

/** A problem type of ADR-0007: static title, never any detail derived from user input or internals. */
export interface ProblemDefinition {
  readonly status: number;
  readonly slug: string;
  readonly title: string;
  readonly errors?: readonly ProblemFieldError[];
  /** Sent as `Retry-After` (whole seconds, ≥ 1), required on every `429` by the contract. */
  readonly retryAfterSeconds?: number;
  /** Further fixed response headers, e.g. `WWW-Authenticate` on a 401. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Extension members of the problem body, e.g. `current_version` of a version conflict (never user input). */
  readonly extensions?: Readonly<Record<string, string | number>>;
}

export const Problems = {
  invalidBody: {
    status: 400,
    slug: 'validation',
    title: 'Request validation failed',
    errors: [{ pointer: '', message: 'The request body is not valid JSON.' }],
  },
  validation: { status: 400, slug: 'validation', title: 'Request validation failed' },
  invalidCredentials: { status: 401, slug: 'invalid-credentials', title: 'Invalid email or password' },
  invalidToken: { status: 401, slug: 'invalid-token', title: 'Invalid or expired token' },
  /** Missing, expired or revoked access token (contract `Unauthorized`). */
  unauthorized: { status: 401, slug: 'unauthorized', title: 'Unauthorized', headers: { 'www-authenticate': 'Bearer' } },
  emailNotVerified: { status: 403, slug: 'email-not-verified', title: 'Email address not verified' },
  reauthenticationRequired: { status: 403, slug: 'reauthentication-required', title: 'Re-authentication required' },
  /** Goal content is created only with the active `goal_content` consent (R-PRIV-04). */
  consentRequired: { status: 403, slug: 'consent-required', title: 'Consent to store goal content required' },
  notFound: { status: 404, slug: 'not-found', title: 'Not Found' },
  emailTaken: { status: 409, slug: 'email-taken', title: 'Email address already in use' },
  consentAlreadyGranted: { status: 409, slug: 'consent-already-granted', title: 'Consent already granted' },
  /** R-ACH-07, R-QST-07: a completed achievement and its quests are the user's read-only archive. */
  achievementCompleted: { status: 409, slug: 'achievement-completed', title: 'Completed achievements are read-only' },
  /** R-CHK-05: check-ins only on quests of an active achievement… */
  achievementNotActive: { status: 409, slug: 'achievement-not-active', title: 'The achievement is not active' },
  /** …whose prerequisite is completed… */
  questLocked: { status: 409, slug: 'quest-locked', title: 'The quest waits for its prerequisite' },
  /** …that were not reset (R-QST-04)… */
  questNeedsRestart: { status: 409, slug: 'quest-needs-restart', title: 'The habit was reset and needs a restart' },
  /** …and are not completed yet (Q-42). */
  questCompleted: { status: 409, slug: 'quest-completed', title: 'The quest is already completed' },
  /** Q-36: an undo only on the day the check-in was made. */
  checkInFinal: { status: 409, slug: 'check-in-final', title: 'The check-in can no longer be undone' },
  /** One pending gamble per user (R-GMB-01, Q-31, Q-43); its target date is fixed (T-17). */
  gamblePending: { status: 409, slug: 'gamble-pending', title: 'A gamble is pending' },
  /** R-GMB-01: a gamble needs a target date after today to be won or lost by. */
  gambleTargetDateRequired: {
    status: 409,
    slug: 'gamble-target-date-required',
    title: 'A gamble needs a target date after today',
  },
  /** A-27, T-16: no second gamble on an achievement in the attempt that lost one. */
  gambleLostThisAttempt: {
    status: 409,
    slug: 'gamble-lost-this-attempt',
    title: 'A gamble was already lost in this attempt',
  },
  /** R-GMB-01: the XP above the current level's threshold is the stake; at 0 there is nothing to stake. */
  nothingToStake: { status: 422, slug: 'nothing-to-stake', title: 'Nothing to stake' },
  /** Use with `extensions: { current_version }` (contract `VersionConflictProblem`). */
  versionConflict: { status: 409, slug: 'version-conflict', title: 'The resource was changed meanwhile' },
  preconditionRequired: { status: 428, slug: 'precondition-required', title: 'If-Match header required' },
  payloadTooLarge: { status: 413, slug: 'payload-too-large', title: 'Payload Too Large' },
  unsupportedMediaType: { status: 415, slug: 'unsupported-media-type', title: 'Unsupported Media Type' },
  weakPassword: { status: 422, slug: 'weak-password', title: 'Password is too easy to guess' },
  /** ADR-0008: an `Idempotency-Key` already used for a different request of the same operation (T-13). */
  idempotencyKeyReused: {
    status: 422,
    slug: 'idempotency-key-reused',
    title: 'Idempotency key already used for another request',
    errors: [{ pointer: '', message: 'Use a new Idempotency-Key for a different request.' }],
  },
  /** A rate limit (R-AUTH-08) or saturated password hashing (D-01); set `retryAfterSeconds` to the real wait. */
  rateLimited: { status: 429, slug: 'rate-limited', title: 'Too Many Requests', retryAfterSeconds: 1 },
  internal: { status: 500, slug: 'internal', title: 'Internal Server Error' },
} as const satisfies Record<string, ProblemDefinition>;

/** A per-user limit of R-IN-01 (Q-16) is reached; `message` names it, statically. */
export function limitReached(message: string): ProblemDefinition {
  return { status: 422, slug: 'limit-reached', title: 'Limit reached', errors: [{ pointer: '', message }] };
}

/** A well-formed request that breaks a rule (contract `UnprocessableContent`); static message, never the value. */
export function unprocessable(pointer: string, message: string): ProblemDefinition {
  return { status: 422, slug: 'unprocessable', title: 'The request breaks a rule', errors: [{ pointer, message }] };
}

function instanceOf(url: string): string {
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  return path.slice(0, MAX_INSTANCE_LENGTH);
}

export function sendProblem(request: FastifyRequest, reply: FastifyReply, problem: ProblemDefinition): FastifyReply {
  if (problem.retryAfterSeconds !== undefined) void reply.header('retry-after', String(problem.retryAfterSeconds));
  if (problem.headers !== undefined) void reply.headers(problem.headers);
  return reply
    .code(problem.status)
    .type(PROBLEM_CONTENT_TYPE)
    .send({
      ...problem.extensions,
      type: `urn:questline:problem:${problem.slug}`,
      title: problem.title,
      status: problem.status,
      instance: instanceOf(request.url),
      request_id: request.id,
      ...(problem.errors === undefined ? {} : { errors: problem.errors }),
    });
}
