import type { FastifyPluginCallback } from 'fastify';
import { etagOf, parseIfMatch } from '../../platform/http/concurrency.ts';
import { Problems } from '../../platform/http/problem.ts';
import { parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { principalOf } from '../sessions/guard.ts';
import type { AccountView, ProfileService } from './profile-service.ts';
import { accountUpdate } from './schemas.ts';

/** `GET`/`PATCH /me` of `openapi/openapi.yaml`, mounted under `/v1` behind the auth guard. */

export interface ProfileRoutesOptions {
  readonly profiles: ProfileService;
}

/** XP and levels arrive with the domain in M3; until then no account can have earned any. */
const NO_XP_YET = { xp_total: 0, level: 1 } as const;

/** `Account` in the contract. */
function accountJson(account: AccountView) {
  return {
    id: account.id,
    email: account.email,
    nickname: account.nickname,
    timezone: account.timezone,
    locale: account.locale,
    week_start: account.weekStart,
    email_verified: account.emailVerified,
    created_at: account.createdAt.toISOString(),
    ...NO_XP_YET,
    version: account.version,
  };
}

const INVALID_IF_MATCH = {
  ...Problems.validation,
  errors: [{ pointer: '', message: 'If-Match must name one version, e.g. "3"' }],
};

export const profileRoutes: FastifyPluginCallback<ProfileRoutesOptions> = (app, { profiles }, done) => {
  app.get('/me', async (request, reply) => {
    const account = await profiles.get(principalOf(request));
    return reply.header('etag', etagOf(account.version)).send(accountJson(account));
  });

  app.patch('/me', async (request, reply) => {
    const ifMatch = parseIfMatch(request.headers['if-match']);
    if (ifMatch.kind === 'missing') throw new ProblemError(Problems.preconditionRequired);
    if (ifMatch.kind === 'invalid') throw new ProblemError(INVALID_IF_MATCH);
    const update = parseRequest(accountUpdate, request.body);
    const result = await profiles.update(principalOf(request), ifMatch.version, update);
    if (result.outcome === 'version_conflict') {
      throw new ProblemError({ ...Problems.versionConflict, extensions: { current_version: result.currentVersion } });
    }
    return reply.header('etag', etagOf(result.account.version)).send(accountJson(result.account));
  });

  done();
};
