import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { breakingChanges } from '../helpers/contract-freeze.ts';
import { spec, specOperations } from '../helpers/openapi.ts';
import { NOT_YET_IMPLEMENTED } from './not-yet-implemented.ts';

type Tree = Record<string, unknown>;

/**
 * The core contract is frozen since 0.3.0 (Q-45): afterwards it only grows, each addition approved by the PM.
 * `openapi/frozen/openapi.yaml` is `openapi/openapi.yaml` as last frozen, byte for byte: 0.3.0, renewed as 0.3.1 when
 * `exportData` and as 0.3.2 when `deleteAccount` was implemented and joined the freeze, and since then with every
 * approved change (0.3.3: Q-47, 0.3.4: Q-48, 0.4.0: M5's operations, outside the freeze until implemented, 0.4.1:
 * the export's sign-in methods and Q-53, 0.4.2: the TOTP operations, 0.4.3: the login's second step, implemented),
 * once the contract passed this check against the snapshot before it — so that what a change added is frozen as well.
 */
const FROZEN = parse(readFileSync(new URL('../../openapi/frozen/openapi.yaml', import.meta.url), 'utf8')) as Tree;
const FROZEN_VERSION = '0.4.3';

/**
 * Operations not frozen yet: M5's (0.4.0, ADR-0019), each until it is implemented — the rule of M4: implemented
 * operations join the freeze. Shrink-only: an operation here must still be unimplemented; once implemented it leaves
 * this list, and the snapshot is renewed from the contract of that day once that contract passed this check against
 * the old snapshot.
 */
const OUTSIDE_FREEZE: ReadonlySet<string> = new Set([
  'createPasskeyChallenge',
  'loginWithPasskey',
  'listPasskeys',
  'registerPasskey',
  'createPasskeyRegistrationOptions',
  'deletePasskey',
]);

const nodeAt = (tree: Tree, ...keys: readonly string[]): Tree =>
  keys.reduce<Tree>((node, key) => node[key] as Tree, tree);

describe('the core contract, frozen since 0.3.0 [Q-45, ADR-0010]', () => {
  it('keeps every operation, parameter, response, property and value it froze and requires nothing new', () => {
    expect(breakingChanges(FROZEN, spec, OUTSIDE_FREEZE)).toEqual([]);
  });

  it('compares against the snapshot of the last frozen version', () => {
    expect(nodeAt(FROZEN, 'info')['version']).toBe(FROZEN_VERSION);
  });

  it('notices when the contract loses something it froze', () => {
    const current = structuredClone<Tree>(spec);
    Reflect.deleteProperty(nodeAt(current, 'paths', '/quests/{questId}', 'patch', 'responses'), '409');
    const rank = nodeAt(current, 'components', 'schemas', 'Rank');
    rank['enum'] = (rank['enum'] as string[]).filter((value) => value !== 'champion');

    const found = breakingChanges(FROZEN, current, OUTSIDE_FREEZE);

    expect(found).toContain('updateQuest: response 409 removed');
    expect(found).toContain('getAchievement: response 200 application/json #/rank: value "champion" removed');
  });

  it('leaves outside the freeze only operations of the contract that are not implemented yet', () => {
    const known = new Set(specOperations.map((operation) => operation.operationId));

    expect([...OUTSIDE_FREEZE].filter((id) => !known.has(id) || !NOT_YET_IMPLEMENTED.has(id))).toEqual([]);
  });
});
