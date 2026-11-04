import type { FastifyPluginCallback } from 'fastify';
import { Problems, type ProblemDefinition } from '../../platform/http/problem.ts';
import { parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { TOTP } from '../../platform/crypto/totp.ts';
import { requestContext } from '../audit/context.ts';
import { principalOf } from '../sessions/guard.ts';
import { confirmTotpRequest } from './schemas.ts';
import type { TotpService } from './totp-service.ts';

/** Sign-in method endpoints of `openapi/openapi.yaml` (tag `sign-in-methods`), mounted under `/v1` behind the guard. */

export interface SignInMethodsRoutesOptions {
  readonly totp: TotpService;
}

const FAILURES: Readonly<Record<string, ProblemDefinition>> = {
  reauthentication_required: Problems.reauthenticationRequired,
  totp_enabled: Problems.totpEnabled,
  totp_not_enabled: Problems.totpNotEnabled,
  totp_not_started: Problems.totpNotStarted,
  invalid_code: Problems.invalidCode,
};

/** The problem for a refused request; every outcome but the success has one. */
function refused(outcome: string): never {
  const problem = FAILURES[outcome];
  if (problem === undefined) throw new Error(`no problem for the outcome ${outcome}`);
  throw new ProblemError(problem);
}

export const signInMethodsRoutes: FastifyPluginCallback<SignInMethodsRoutesOptions> = (app, { totp }, done) => {
  app.post('/me/totp', async (request, reply) => {
    const result = await totp.start(principalOf(request));
    if (result.outcome !== 'started') refused(result.outcome);
    return reply.code(200).send({
      secret: result.enrolment.secret,
      otpauth_uri: result.enrolment.otpauthUri,
      algorithm: TOTP.algorithm,
      digits: TOTP.digits,
      period: TOTP.periodSeconds,
    });
  });

  app.post('/me/totp/confirm', async (request, reply) => {
    const { code } = parseRequest(confirmTotpRequest, request.body);
    const result = await totp.confirm(principalOf(request), code, requestContext(request));
    if (result.outcome !== 'enabled') refused(result.outcome);
    return reply.code(200).send({ recovery_codes: result.recoveryCodes });
  });

  app.delete('/me/totp', async (request, reply) => {
    const result = await totp.disable(principalOf(request), requestContext(request));
    if (result.outcome !== 'disabled') refused(result.outcome);
    return reply.code(204).send();
  });

  app.post('/me/recovery-codes', async (request, reply) => {
    const result = await totp.replaceRecoveryCodes(principalOf(request), requestContext(request));
    if (result.outcome !== 'replaced') refused(result.outcome);
    return reply.code(200).send({ recovery_codes: result.recoveryCodes });
  });

  done();
};
