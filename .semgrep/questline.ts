// Rule tests for questline.yml (`semgrep --test .semgrep/`). `ruleid:` marks a line that must be reported,
// `ok:` a line that must not be. This file is excluded from every other scan, lint and typecheck.
import * as crypto from 'node:crypto';
import { createHash, createHmac, hash, randomInt, timingSafeEqual } from 'node:crypto';
import * as https from 'node:https';

declare const userUrl: string;
declare const tokenHash: string;
declare const storedHash: string;
declare const presented: string;
declare const expectedMac: Buffer;
declare const mac: Buffer;
declare const row: { token_hash: string; tokenId: string; userId: string };
declare const session: { refreshTokenHash: string; tokenType: string };
declare const config: { webhookSecret: string; hashAlgorithm: string };
declare const machineName: string;
declare const otherMachine: string;
declare function computeSignature(body: string): string;
declare const header: string;
declare const secret: string | undefined;
declare const password: string;
declare const map: Map<string, string>;

export function randomness(): number {
  // ruleid: questline-insecure-random
  const insecure = Math.random();
  // ok: questline-insecure-random
  const secure = randomInt(10);
  return insecure + secure;
}

export function hashes(data: string): string[] {
  return [
    // ruleid: questline-weak-hash
    createHash('md5').update(data).digest('hex'),
    // ruleid: questline-weak-hash
    crypto.createHash('sha1').update(data).digest('hex'),
    // ruleid: questline-weak-hash
    createHmac('SHA1', data).digest('hex'),
    // ruleid: questline-weak-hash
    hash('md5', data),
    // ok: questline-weak-hash
    createHash('sha256').update(data).digest('hex'),
    // ok: questline-weak-hash
    crypto.createHmac('sha512', data).digest('hex'),
  ];
}

export function comparisons(): boolean[] {
  return [
    // ruleid: questline-timing-unsafe-secret-comparison
    tokenHash === storedHash,
    // ruleid: questline-timing-unsafe-secret-comparison
    presented !== storedHash,
    // ruleid: questline-timing-unsafe-secret-comparison
    row.token_hash == presented,
    // ruleid: questline-timing-unsafe-secret-comparison
    expectedMac === mac,
    // ruleid: questline-timing-unsafe-secret-comparison
    session.refreshTokenHash === presented,
    // ruleid: questline-timing-unsafe-secret-comparison
    computeSignature(presented) === header,
    // ruleid: questline-timing-unsafe-secret-comparison
    header !== config.webhookSecret,
    // ruleid: questline-timing-unsafe-secret-comparison
    password === presented,
    // ok: questline-timing-unsafe-secret-comparison
    timingSafeEqual(expectedMac, mac),
    // ok: questline-timing-unsafe-secret-comparison
    secret === undefined,
    // ok: questline-timing-unsafe-secret-comparison
    secret !== null,
    // ok: questline-timing-unsafe-secret-comparison
    typeof secret === 'string',
    // ok: questline-timing-unsafe-secret-comparison
    session.tokenType === 'refresh',
    // ok: questline-timing-unsafe-secret-comparison
    row.tokenId === row.userId,
    // ok: questline-timing-unsafe-secret-comparison
    config.hashAlgorithm === header,
    // ok: questline-timing-unsafe-secret-comparison
    tokenHash.length === presented.length,
    // ok: questline-timing-unsafe-secret-comparison
    machineName === otherMachine,
  ];
}

export async function outbound(): Promise<void> {
  // ruleid: questline-non-constant-outbound-url
  await fetch(userUrl);
  // ruleid: questline-non-constant-outbound-url
  await fetch(`${userUrl}/v1/items`, { method: 'GET' });
  // ruleid: questline-non-constant-outbound-url
  https.request(userUrl);
  // ruleid: questline-non-constant-outbound-url
  https.get({ host: userUrl, path: '/' });
  // ok: questline-non-constant-outbound-url
  await fetch('https://connect.example.test/health');
  // ok: questline-non-constant-outbound-url
  https.get('https://connect.example.test/heartbeat');
  // ok: questline-non-constant-outbound-url
  map.get(userUrl);
}
