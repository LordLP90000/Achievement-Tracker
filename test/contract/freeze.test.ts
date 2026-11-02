import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { breakingChanges } from '../helpers/contract-freeze.ts';
import { spec, specOperations } from '../helpers/openapi.ts';
import { NOT_YET_IMPLEMENTED } from './not-yet-implemented.ts';

type Tree = Record<string, unknown>;

/**
 * The core contract is frozen as 0.3.0 (Q-45): afterwards it only grows, each addition approved by the PM.
 * `openapi/frozen/openapi-0.3.0.yaml` is `openapi/openapi.yaml` as it was frozen, byte for byte.
 */
const FROZEN = parse(readFileSync(new URL('../../openapi/frozen/openapi-0.3.0.yaml', import.meta.url), 'utf8')) as Tree;

/**
 * Outside the freeze until M4 implements them, with their schemas `ExportDocument` and `AccountDeletionScheduled`
 * (PM, 2026-11-02). Shrink-only: an implemented operation joins the freeze, and the snapshot is then renewed from the
 * contract of that day, once that contract has passed this check against the old snapshot.
 */
const OUTSIDE_FREEZE: ReadonlySet<string> = new Set(['exportData', 'deleteAccount']);

const nodeAt = (tree: Tree, ...keys: readonly string[]): Tree =>
  keys.reduce<Tree>((node, key) => node[key] as Tree, tree);

describe('the core contract, frozen as 0.3.0 [Q-45, ADR-0010]', () => {
  it('keeps every operation, parameter, response, property and value of 0.3.0 and requires nothing new', () => {
    expect(breakingChanges(FROZEN, spec, OUTSIDE_FREEZE)).toEqual([]);
  });

  it('compares against the snapshot of version 0.3.0', () => {
    expect(nodeAt(FROZEN, 'info')['version']).toBe('0.3.0');
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
