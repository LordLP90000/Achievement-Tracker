import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * One Node.js release, adopted in one step (operations runbook §5): `.nvmrc` sets it for this machine and for CI,
 * and the stages that build the image run the same release on the runtime's Debian release, so that a native
 * add-on built there loads in the runtime (ADR-0017). Both base images are pinned by digest, since a tag can be
 * moved (threat T-11). The runtime image's tag names no release: that it carries this one is checked on the built
 * image (test/e2e/smoke.test.ts).
 */
describe('the Node.js release', () => {
  const release = readFileSync('.nvmrc', 'utf8').trim();
  const major = release.split('.')[0] ?? '';
  const dockerfile = readFileSync('docker/Dockerfile', 'utf8');
  const buildImage = /^ARG BUILD_IMAGE=(\S+)$/m.exec(dockerfile)?.[1] ?? '';
  const runtimeImage = /^ARG RUNTIME_IMAGE=(\S+)$/m.exec(dockerfile)?.[1] ?? '';
  const DIGEST = /@sha256:[\da-f]{64}$/;

  it('is exact in .nvmrc and inside the range package.json accepts [ADR-0002]', () => {
    const { engines } = JSON.parse(readFileSync('package.json', 'utf8')) as { engines: { node: string } };

    expect(release).toMatch(/^\d+\.\d+\.\d+$/);
    expect(engines.node).toBe(`>=${major}.0.0 <${String(Number(major) + 1)}`);
  });

  it('builds the image, on the Debian release of the runtime [T-10, ADR-0017]', () => {
    expect(buildImage.replace(DIGEST, '')).toBe(`node:${release}-trixie-slim`);
    expect(runtimeImage.replace(DIGEST, '')).toBe(`gcr.io/distroless/nodejs${major}-debian13:nonroot`);
  });

  it('comes in base images pinned by digest [T-11, ADR-0017]', () => {
    expect(buildImage).toMatch(DIGEST);
    expect(runtimeImage).toMatch(DIGEST);
  });
});
