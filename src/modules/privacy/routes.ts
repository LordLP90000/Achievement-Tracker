import type { FastifyPluginCallback } from 'fastify';
import { Problems } from '../../platform/http/problem.ts';
import { ProblemError } from '../../platform/http/validation.ts';
import { requestContext } from '../audit/context.ts';
import { principalOf } from '../sessions/guard.ts';
import type { ExportService } from './export-service.ts';

/** Privacy endpoints of `openapi/openapi.yaml` (tag `privacy`), mounted under `/v1` behind the auth guard. */

export interface PrivacyRoutesOptions {
  readonly exports: ExportService;
}

export const privacyRoutes: FastifyPluginCallback<PrivacyRoutesOptions> = (app, { exports }, done) => {
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

  done();
};
