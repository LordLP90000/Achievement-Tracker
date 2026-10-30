import type { FastifyPluginCallback } from 'fastify';
import { levelForXp } from '../../domain/xp.ts';
import { etagOf, requireIfMatch } from '../../platform/http/concurrency.ts';
import { Problems } from '../../platform/http/problem.ts';
import { parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { principalOf } from '../sessions/guard.ts';
import type { AccountView, ProfileService } from './profile-service.ts';
import { accountUpdate } from './schemas.ts';

/** `GET`/`PATCH /me` of `openapi/openapi.yaml`, mounted under `/v1` behind the auth guard. */

export interface ProfileRoutesOptions {
  readonly profiles: ProfileService;
}

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
    xp_total: account.xpTotal,
    level: levelForXp(account.xpTotal),
    version: account.version,
  };
}

export const profileRoutes: FastifyPluginCallback<ProfileRoutesOptions> = (app, { profiles }, done) => {
  app.get('/me', async (request, reply) => {
    const account = await profiles.get(principalOf(request));
    return reply.header('etag', etagOf(account.version)).send(accountJson(account));
  });

  app.patch('/me', async (request, reply) => {
    const expectedVersion = requireIfMatch(request.headers['if-match']);
    const update = parseRequest(accountUpdate, request.body);
    const result = await profiles.update(principalOf(request), expectedVersion, update);
    if (result.outcome === 'version_conflict') {
      throw new ProblemError({ ...Problems.versionConflict, extensions: { current_version: result.currentVersion } });
    }
    return reply.header('etag', etagOf(result.account.version)).send(accountJson(result.account));
  });

  done();
};
