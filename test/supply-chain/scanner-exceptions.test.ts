import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Container-scan exceptions (ADR-0016, R-SUP-02): each one names a single vulnerability in named packages, says why
 * and which decision of the PM accepted it, and expires — after its date Trivy counts the finding again.
 */

interface TrivyException {
  readonly id?: unknown;
  readonly purls?: unknown;
  readonly paths?: unknown;
  readonly statement?: unknown;
  readonly expired_at?: unknown;
}

describe('Trivy exceptions (.trivyignore.yaml)', () => {
  const exceptions = (): readonly TrivyException[] =>
    (parse(readFileSync('.trivyignore.yaml', 'utf8')) as { vulnerabilities: TrivyException[] }).vulnerabilities;

  it('accepts only single vulnerabilities in named packages, each with the PM’s decision, its reason and an expiry', () => {
    for (const exception of exceptions()) {
      expect(exception.id).toMatch(/^(?:CVE-\d{4}-\d{4,}|GHSA(?:-[\da-z]{4}){3})$/u);
      expect(exception.purls).toEqual([expect.stringMatching(/^pkg:[a-z]+\/[\w.-]+\/[\w.+-]+$/u)]);
      expect(exception.paths).toBeUndefined();
      expect(exception.statement).toMatch(/\bQ-\d{2,}\b.{40,}/su);
      expect(exception.expired_at).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
  });

  it('lists its exceptions under the key Trivy reads', () => {
    expect(Array.isArray(exceptions())).toBe(true);
  });
});
