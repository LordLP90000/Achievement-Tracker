import { describe, expect, it } from 'vitest';
import { specOperations } from '../helpers/openapi.ts';

const IF_MATCH = '#/components/parameters/IfMatch';
const conditional = specOperations.filter((operation) => operation.parameters.includes(IF_MATCH));

/** Every mutation of a versioned resource answers a missing, malformed or stale `If-Match` the same way. */
describe('conditional requests in the contract [ADR-0008]', () => {
  it('finds the operations that need If-Match', () => {
    expect(conditional.map((operation) => operation.operationId)).toEqual(
      expect.arrayContaining(['updateMe', 'updateQuest', 'deleteQuest']),
    );
  });

  it.each([
    ['400', 'a malformed If-Match', ['ValidationError']],
    ['409', 'a stale version', ['VersionConflict', 'VersionOrStateConflict']],
    ['428', 'a missing If-Match', ['PreconditionRequired']],
  ])('documents %s for %s on every operation that needs it', (status, _case, components) => {
    const allowed = components.map((component) => `#/components/responses/${component}`);
    const missing = conditional
      .filter(
        (operation) => !allowed.includes(String((operation.responses[status] as { $ref?: unknown } | undefined)?.$ref)),
      )
      .map((operation) => operation.operationId);

    expect(missing).toEqual([]);
  });
});
