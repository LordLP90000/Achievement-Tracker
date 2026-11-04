import type { FastifyPluginCallback } from 'fastify';
import { limitReached, Problems, type ProblemDefinition } from '../../platform/http/problem.ts';
import { isUuidV4, parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { TOTP } from '../../platform/crypto/totp.ts';
import { requestContext } from '../audit/context.ts';
import { principalOf } from '../sessions/guard.ts';
import type { PasskeysService, PasskeyView } from './passkey-service.ts';
import { confirmTotpRequest, passkeyRegistrationRequest } from './schemas.ts';
import type { TotpService } from './totp-service.ts';

/** Sign-in method endpoints of `openapi/openapi.yaml` (tag `sign-in-methods`), mounted under `/v1` behind the guard. */

export interface SignInMethodsRoutesOptions {
  readonly totp: TotpService;
  readonly passkeys: PasskeysService;
}

const FAILURES: Readonly<Record<string, ProblemDefinition>> = {
  reauthentication_required: Problems.reauthenticationRequired,
  totp_enabled: Problems.totpEnabled,
  totp_not_enabled: Problems.totpNotEnabled,
  totp_not_started: Problems.totpNotStarted,
  invalid_code: Problems.invalidCode,
  invalid_passkey: Problems.invalidPasskey,
  limit_reached: limitReached('An account has at most 10 passkeys.'),
  not_found: Problems.notFound,
};

/** The problem for a refused request; every outcome but the success has one. */
function refused(outcome: string): never {
  const problem = FAILURES[outcome];
  if (problem === undefined) throw new Error(`no problem for the outcome ${outcome}`);
  throw new ProblemError(problem);
}

/** `Passkey` in the contract. */
const passkeyOf = (passkey: PasskeyView) => ({
  id: passkey.id,
  name: passkey.name,
  created_at: passkey.createdAt.toISOString(),
  last_used_at: passkey.lastUsedAt?.toISOString() ?? null,
  backed_up: passkey.backedUp,
});

export const signInMethodsRoutes: FastifyPluginCallback<SignInMethodsRoutesOptions> = (
  app,
  { totp, passkeys },
  done,
) => {
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

  app.get('/me/passkeys', async (request, reply) => {
    const items = await passkeys.list(principalOf(request));
    return reply.code(200).send({ items: items.map(passkeyOf) });
  });

  app.post('/me/passkeys/options', async (request, reply) => {
    const result = await passkeys.creationOptions(principalOf(request));
    if (result.outcome !== 'options') refused(result.outcome);
    return reply.code(200).send(result.options);
  });

  app.post('/me/passkeys', async (request, reply) => {
    const { credential, name } = parseRequest(passkeyRegistrationRequest, request.body);
    const result = await passkeys.register(principalOf(request), credential, name, requestContext(request));
    if (result.outcome !== 'registered') refused(result.outcome);
    return reply.code(201).send(passkeyOf(result.passkey));
  });

  app.delete<{ Params: { passkeyId: string } }>('/me/passkeys/:passkeyId', async (request, reply) => {
    const { passkeyId } = request.params;
    // A malformed ID names no passkey of anyone (R-AUTHZ-02).
    if (!isUuidV4(passkeyId)) throw new ProblemError(Problems.notFound);
    const result = await passkeys.remove(principalOf(request), passkeyId, requestContext(request));
    if (result.outcome !== 'removed') refused(result.outcome);
    return reply.code(204).send();
  });

  done();
};
