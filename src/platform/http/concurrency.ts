import { Problems } from './problem.ts';
import { ProblemError } from './validation.ts';

/** Entity tags for versioned resources (ADR-0008): the ETag mirrors `version`, `If-Match` must name it. */

export type IfMatch =
  { readonly kind: 'version'; readonly version: number } | { readonly kind: 'missing' } | { readonly kind: 'invalid' };

/** `"3"` — a strong tag; versions start at 1 (contract `IfMatch`/`ETag`: up to 9 digits). */
const ENTITY_TAG = /^"([1-9]\d{0,8})"$/;

export function etagOf(version: number): string {
  return `"${String(version)}"`;
}

/** Weak tags, lists and `*` are refused: an update must name exactly the version the client saw. */
export function parseIfMatch(header: string | undefined): IfMatch {
  if (header === undefined) return { kind: 'missing' };
  const match = ENTITY_TAG.exec(header);
  return match?.[1] === undefined ? { kind: 'invalid' } : { kind: 'version', version: Number(match[1]) };
}

const INVALID_IF_MATCH = {
  ...Problems.validation,
  errors: [{ pointer: '', message: 'If-Match must name one version, e.g. "3"' }],
};

/** The version a mutation's `If-Match` names: without one `428`, anything but one strong tag `400`. */
export function requireIfMatch(header: string | undefined): number {
  const ifMatch = parseIfMatch(header);
  if (ifMatch.kind === 'missing') throw new ProblemError(Problems.preconditionRequired);
  if (ifMatch.kind === 'invalid') throw new ProblemError(INVALID_IF_MATCH);
  return ifMatch.version;
}
