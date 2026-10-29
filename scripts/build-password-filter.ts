// Builds src/modules/accounts/breached-passwords.bloom from a pinned, checksum-verified public list (ADR-0012).
// Run with `npm run build:password-filter` (needs network access to raw.githubusercontent.com); commit the result.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { BloomFilter } from '../src/modules/accounts/bloom-filter.ts';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../src/modules/accounts/password-policy.ts';

/** SecLists (MIT), xato-net top 1 000 000, pinned to a commit. */
const SOURCE_URL =
  'https://raw.githubusercontent.com/danielmiessler/SecLists/c205c36a445bff37f8e58a9ec829105cd4975c58/Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt';
const SOURCE_SHA256 = Buffer.from('424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51', 'hex');
const FALSE_POSITIVE_RATE = 0.01;
const OUTPUT = new URL('../src/modules/accounts/breached-passwords.bloom', import.meta.url);

const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) throw new Error(`download failed with HTTP ${String(response.status)}`);
const list = Buffer.from(await response.arrayBuffer());
if (!createHash('sha256').update(list).digest().equals(SOURCE_SHA256)) {
  throw new Error('the downloaded list does not match the pinned SHA-256');
}

// Shorter passwords are rejected by the length rule anyway, so only entries that could pass it are kept.
const entries = new Set(
  list
    .toString('utf8')
    .split('\n')
    .map((line) => line.normalize('NFKC'))
    .filter((line) => {
      const length = Array.from(line).length;
      return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH && !/\p{Cc}/u.test(line);
    }),
);

const filter = BloomFilter.create(entries.size, FALSE_POSITIVE_RATE);
for (const entry of entries) filter.add(entry);
const file = filter.serialize({ entries: entries.size, minLength: PASSWORD_MIN_LENGTH, source: SOURCE_SHA256 });
writeFileSync(OUTPUT, file);
process.stdout.write(
  `${String(entries.size)} entries, ${String(filter.bits)} bits, ${String(filter.hashes)} hashes, ${String(file.length)} bytes\n`,
);
