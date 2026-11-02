import type { FastifyPluginCallback } from 'fastify';
import { Problems } from '../../platform/http/problem.ts';
import { ProblemError } from '../../platform/http/validation.ts';
import { requestContext } from '../audit/context.ts';
import { principalOf } from '../sessions/guard.ts';
import type { DeletionService } from './deletion-service.ts';
import type { ExportService } from './export-service.ts';

/** Privacy endpoints of `openapi/openapi.yaml` (tag `privacy`), mounted under `/v1` behind the auth guard. */

export interface PrivacyRoutesOptions {
  readonly exports: ExportService;
  readonly deletions: DeletionService;
}

export const privacyRoutes: FastifyPluginCallback<PrivacyRoutesOptions> = (app, { exports, deletions }, done) => {
  app.get('/me/export', async (request, reply) => {
    const result = await exports.export(principalOf(request), requestContext(request));
    switch (result.outcome) {
      case 'reauthentication_required':
        throw new ProblemError(Problems.reauthenticationRequired);
      case 'rate_limited':
        request.log.warn({ scope: 'export' }, 'rate limited');
        throw new ProblemError({ ...Problems.rateLimited, retryAfterSeconds: result.retryAfterSeconds });
      case 'exported':
        return reply
          .header('content-disposition', 'attachment; filename="questline-export.json"')
          .send(result.document);
    }
  });

  app.delete('/me', async (request, reply) => {
    const result = await deletions.requestDeletion(principalOf(request), requestContext(request));
    switch (result.outcome) {
      case 'reauthentication_required':
        throw new ProblemError(Problems.reauthenticationRequired);
      case 'session_ended':
        throw new ProblemError(Problems.unauthorized);
      case 'scheduled':
        return reply.code(202).send({ deletion_scheduled_for: result.deletionScheduledFor.toISOString() });
    }
  });

  done();
};
