import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeImagePackages } from '../../scripts/remove-image-packages.ts';

const ELF_HEADER_BYTES = 64;
const PROGRAM_HEADER_BYTES = 56;
/** Where the test files are mapped: not at 0, so their strings are only found through the load segment. */
const LOAD_ADDRESS = 0x400000;

/**
 * A 64-bit little-endian program or library as the dynamic loader reads it: the libraries it needs (`DT_NEEDED`) and
 * the name it is linked by (`DT_SONAME`).
 */
function elf(needed: readonly string[] = [], soname?: string): Buffer {
  let strings = '\0';
  const entries: [tag: number, value: number][] = [];
  const add = (tag: number, name: string): void => {
    entries.push([tag, strings.length]);
    strings += `${name}\0`;
  };
  for (const name of needed) add(1, name);
  if (soname !== undefined) add(14, soname);
  const dynamicAt = ELF_HEADER_BYTES + 2 * PROGRAM_HEADER_BYTES;
  const dynamicBytes = (entries.length + 2) * 16;
  const stringsAt = dynamicAt + dynamicBytes;
  entries.push([5, LOAD_ADDRESS + stringsAt], [0, 0]);

  const file = Buffer.alloc(stringsAt + strings.length);
  file.write('\x7fELF', 0, 'latin1');
  file[4] = 2; // 64-bit
  file[5] = 1; // little-endian
  file.writeBigUInt64LE(BigInt(ELF_HEADER_BYTES), 32);
  file.writeUInt16LE(PROGRAM_HEADER_BYTES, 54);
  file.writeUInt16LE(2, 56);
  const segment = (index: number, type: number, offset: number, bytes: number): void => {
    const at = ELF_HEADER_BYTES + index * PROGRAM_HEADER_BYTES;
    file.writeUInt32LE(type, at);
    file.writeBigUInt64LE(BigInt(offset), at + 8);
    file.writeBigUInt64LE(BigInt(LOAD_ADDRESS + offset), at + 16);
    file.writeBigUInt64LE(BigInt(bytes), at + 32);
  };
  segment(0, 1, 0, file.length);
  segment(1, 2, dynamicAt, dynamicBytes);
  entries.forEach(([tag, value], index) => {
    file.writeBigInt64LE(BigInt(tag), dynamicAt + index * 16);
    file.writeBigUInt64LE(BigInt(value), dynamicAt + index * 16 + 8);
  });
  file.write(strings, stringsAt, 'latin1');
  return file;
}

const LIBRARIES = 'usr/lib/x86_64-linux-gnu';
/** A file list names each file after its MD5 digest. The build step reads the paths only: these stand in for one. */
const DIGEST = '0123456789abcdef'.repeat(2);

/**
 * The build step of `docker/Dockerfile` that takes the system OpenSSL, zstd and zlib out of the distroless image
 * (ADR-0017 as amended): only what nothing left in the image needs may go, and the build fails otherwise. The image
 * is a Linux file system, with its links.
 */
describe.runIf(process.platform !== 'win32')('removeImagePackages (scripts/remove-image-packages.ts)', () => {
  let outside: string;
  let root: string;

  const write = (path: string, content: string | Buffer = `${path}\n`): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const link = (path: string, target: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(target, join(root, path));
  };
  /** A package as the distroless images record it: its entry, the list of its files, and the files. */
  const install = (name: string, files: Readonly<Record<string, string | Buffer>>, fields: readonly string[] = []) => {
    const list = Object.entries(files).map(([path, content]) => {
      write(path, content);
      return `${DIGEST}  ${path}`;
    });
    write(`var/lib/dpkg/status.d/${name}`, [`Package: ${name}`, 'Version: 1.0-1', ...fields, ''].join('\n'));
    write(`var/lib/dpkg/status.d/${name}.md5sums`, `${list.join('\n')}\n`);
  };
  /** Every path of the image: directories end with `/`, links show where they point. */
  const paths = (directory = ''): string[] =>
    readdirSync(join(root, directory))
      .sort()
      .flatMap((name) => {
        const path = `${directory}${name}`;
        const entry = lstatSync(join(root, path));
        if (entry.isSymbolicLink()) return [`${path} -> ${readlinkSync(join(root, path))}`];
        return entry.isDirectory() ? [`${path}/`, ...paths(`${path}/`)] : [path];
      });
  const refused = (packages: readonly string[], reason: RegExp): void => {
    const before = paths();

    expect(() => removeImagePackages(root, packages)).toThrow(reason);
    // Nothing is removed before everything is checked.
    expect(paths()).toEqual(before);
  };

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'questline-image-'));
    root = join(outside, 'root');
    // The distroless Node.js image in small: Node.js, what it needs, and a system OpenSSL that only needs itself.
    install('libc6', { [`${LIBRARIES}/libc.so.6`]: elf([], 'libc.so.6'), 'usr/share/doc/libc6/copyright': 'libc' });
    install('libstdc++6', { [`${LIBRARIES}/libstdc++.so.6.0.33`]: elf(['libc.so.6'], 'libstdc++.so.6') }, [
      'Depends: gcc-14-base (= 14.2.0-19), libc6 (>= 2.38)',
    ]);
    link(`${LIBRARIES}/libstdc++.so.6`, 'libstdc++.so.6.0.33');
    install(
      'libssl3t64',
      {
        [`${LIBRARIES}/engines-3/afalg.so`]: elf(['libcrypto.so.3', 'libc.so.6']),
        [`${LIBRARIES}/libcrypto.so.3`]: elf(['libz.so.1', 'libzstd.so.1', 'libc.so.6'], 'libcrypto.so.3'),
        [`${LIBRARIES}/libssl.so.3`]: elf(['libcrypto.so.3', 'libc.so.6'], 'libssl.so.3'),
        'usr/share/doc/libssl3t64/copyright': 'openssl',
        'usr/share/lintian/overrides/libssl3t64': 'override',
      },
      ['Depends: libc6 (>= 2.38), libzstd1 (>= 1.5.5), zlib1g (>= 1:1.1.4)', 'Provides: libssl3 (= 3.5.7)'],
    );
    install(
      'libzstd1',
      {
        [`${LIBRARIES}/libzstd.so.1.5.7`]: elf(['libc.so.6'], 'libzstd.so.1'),
        'usr/share/doc/libzstd1/copyright': 'zstd',
      },
      ['Depends: libc6 (>= 2.34)'],
    );
    link(`${LIBRARIES}/libzstd.so.1`, 'libzstd.so.1.5.7');
    install(
      'zlib1g',
      { [`${LIBRARIES}/libz.so.1.3.1`]: elf(['libc.so.6'], 'libz.so.1'), 'usr/share/doc/zlib1g/copyright': 'zlib' },
      ['Depends: libc6 (>= 2.14)'],
    );
    link(`${LIBRARIES}/libz.so.1`, 'libz.so.1.3.1');
    // As in the distroless image: it asks for an `openssl` that was never there.
    install('ca-certificates', { 'etc/ssl/certs/ca-certificates.crt': 'certificates' }, [
      'Depends: openssl (>= 1.1.1), debconf (>= 0.5) | debconf-2.0',
    ]);
    // Node.js comes without a package, and /lib is a link (merged /usr).
    write('nodejs/bin/node', elf(['libstdc++.so.6', 'libc.so.6']));
    link('lib', 'usr/lib');
    write('etc/os-release', 'PRETTY_NAME="Distroless"\n');
    write('home/nonroot/.keep', '');
  });

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
  });

  it('takes the packages out — their files, the links to them, the directories that empties, their entries in the package list — and leaves the rest', () => {
    const before = paths();
    const gone = [
      `${LIBRARIES}/engines-3/`,
      `${LIBRARIES}/engines-3/afalg.so`,
      `${LIBRARIES}/libcrypto.so.3`,
      `${LIBRARIES}/libssl.so.3`,
      `${LIBRARIES}/libz.so.1 -> libz.so.1.3.1`,
      `${LIBRARIES}/libz.so.1.3.1`,
      `${LIBRARIES}/libzstd.so.1 -> libzstd.so.1.5.7`,
      `${LIBRARIES}/libzstd.so.1.5.7`,
      'usr/share/doc/libssl3t64/',
      'usr/share/doc/libssl3t64/copyright',
      'usr/share/doc/libzstd1/',
      'usr/share/doc/libzstd1/copyright',
      'usr/share/doc/zlib1g/',
      'usr/share/doc/zlib1g/copyright',
      // The override was the only file there: its two directories go with it.
      'usr/share/lintian/',
      'usr/share/lintian/overrides/',
      'usr/share/lintian/overrides/libssl3t64',
      'var/lib/dpkg/status.d/libssl3t64',
      'var/lib/dpkg/status.d/libssl3t64.md5sums',
      'var/lib/dpkg/status.d/libzstd1',
      'var/lib/dpkg/status.d/libzstd1.md5sums',
      'var/lib/dpkg/status.d/zlib1g',
      'var/lib/dpkg/status.d/zlib1g.md5sums',
    ];

    const result = removeImagePackages(root, ['libssl3t64', 'libzstd1', 'zlib1g']);

    expect(before).toEqual(expect.arrayContaining(gone));
    expect(paths()).toEqual(before.filter((path) => !gone.includes(path)));
    expect(result.removed).toEqual(gone.map((path) => path.replace(/(?: -> .*|\/)$/, '')));
    // Node.js, the C library and the C++ library were read; the removed OpenSSL needing zlib and zstd is no objection.
    expect(result.checked).toBe(3);
  });

  it('keeps a directory that still holds something else', () => {
    write('usr/share/lintian/overrides/libc6', 'override');

    removeImagePackages(root, ['libssl3t64', 'libzstd1', 'zlib1g']);

    expect(paths('usr/share/lintian/')).toEqual(['usr/share/lintian/overrides/', 'usr/share/lintian/overrides/libc6']);
  });

  it('removes a link to a link to a removed file, and a link that reaches the file through /lib', () => {
    link(`${LIBRARIES}/libz.so`, 'libz.so.1');
    link('usr/local/libz.so.1', '/lib/x86_64-linux-gnu/libz.so.1.3.1');
    link('usr/local/libc.so.6', '/lib/x86_64-linux-gnu/libc.so.6');

    removeImagePackages(root, ['libssl3t64', 'libzstd1', 'zlib1g']);

    expect(paths(`${LIBRARIES}/`).filter((path) => path.includes('libz'))).toEqual([]);
    expect(paths('usr/local/')).toEqual(['usr/local/libc.so.6 -> /lib/x86_64-linux-gnu/libc.so.6']);
  });

  it('does not mind a listed file that the image does not have', () => {
    rmSync(join(root, 'usr/share/doc/zlib1g'), { recursive: true });

    const result = removeImagePackages(root, ['libssl3t64', 'libzstd1', 'zlib1g']);

    expect(result.removed.filter((path) => path.includes('zlib1g'))).toEqual([
      'var/lib/dpkg/status.d/zlib1g',
      'var/lib/dpkg/status.d/zlib1g.md5sums',
    ]);
  });

  it('refuses a package the image does not have', () => {
    refused(['libssl3t64', 'libssl4'], /the image has no package libssl4/);
  });

  it('refuses to remove a library that a program left in the image needs, naming both', () => {
    // zlib alone: the system OpenSSL stays and needs it. So does zstd alone; all three go together.
    refused(['zlib1g'], /usr\/lib\/x86_64-linux-gnu\/libcrypto\.so\.3 needs libz\.so\.1/);
    refused(['libzstd1'], /libcrypto\.so\.3 needs libzstd\.so\.1/);
    refused(['libssl3t64', 'libzstd1', 'zlib1g', 'libstdc++6'], /nodejs\/bin\/node needs libstdc\+\+\.so\.6/);
  });

  it('knows a library by the name it is linked by, whatever its file is called, and by its file name when it has none', () => {
    install('libodd', { 'usr/lib/odd/libodd-2.4.so': elf([], 'libodd.so.2'), 'usr/lib/odd/plugin.so': elf() });
    write('usr/bin/by-name', elf(['libodd.so.2']));

    refused(['libodd'], /usr\/bin\/by-name needs libodd\.so\.2/);

    write('usr/bin/by-name', elf(['plugin.so']));

    refused(['libodd'], /usr\/bin\/by-name needs plugin\.so/);

    // … or by the name of a link to it, which is what a program linked through that link asks for.
    link('usr/lib/odd/libplug.so', 'plugin.so');
    write('usr/bin/by-name', elf(['libplug.so']));

    refused(['libodd'], /usr\/bin\/by-name needs libplug\.so/);
  });

  it('refuses to remove a package that a package left in the image depends on', () => {
    install('tzdata', { 'usr/share/zoneinfo/UTC': 'TZif' });
    install('tzdata-legacy', { 'usr/share/zoneinfo/US/Eastern': 'TZif' }, ['Depends: tzdata']);
    install('curl', { 'usr/share/doc/curl/copyright': 'curl' }, ['Pre-Depends: libssl3 (>= 3.0.0)']);

    refused(['tzdata'], /tzdata-legacy depends on tzdata/);
    // By a name the removed package provides, and before installation as well as after.
    refused(['libssl3t64', 'libzstd1', 'zlib1g'], /curl depends on libssl3 \(>= 3\.0\.0\)/);
  });

  it('removes a package while another one that satisfies the same dependency stays, and one nobody could rely on', () => {
    install('debconf', { 'usr/share/doc/debconf/copyright': 'debconf' });
    install('cdebconf', { 'usr/share/doc/cdebconf/copyright': 'cdebconf' }, ['Provides: debconf-2.0']);

    // ca-certificates accepts `debconf | debconf-2.0`: cdebconf still provides the second.
    expect(removeImagePackages(root, ['debconf']).removed).toContain('var/lib/dpkg/status.d/debconf');
    // Its `openssl` was never in the image, so nothing changes for it when the OpenSSL library goes.
    expect(removeImagePackages(root, ['libssl3t64', 'libzstd1', 'zlib1g']).checked).toBe(3);
    refused(['cdebconf'], /ca-certificates depends on debconf \(>= 0\.5\) \| debconf-2\.0/);
  });

  it('refuses when it cannot read a program or library that stays, rather than assume it needs nothing', () => {
    const thirtyTwoBit = elf(['libz.so.1']);
    thirtyTwoBit[4] = 1;
    write('usr/bin/old', thirtyTwoBit);

    refused(['libssl3t64', 'libzstd1', 'zlib1g'], /usr\/bin\/old.*64-bit little-endian/);

    write('usr/bin/old', elf(['libz.so.1']).subarray(0, 200));

    refused(['libssl3t64', 'libzstd1', 'zlib1g'], /usr\/bin\/old.*cut short/);
  });

  it('takes no notice of files that are not programs, of any size', () => {
    write('usr/share/empty', '');
    write('usr/share/short', '\x7fE');
    write('usr/share/text', 'libz.so.1 '.repeat(100));

    expect(removeImagePackages(root, ['libssl3t64', 'libzstd1', 'zlib1g']).checked).toBe(3);
  });

  it('refuses a file list that leads out of the image', () => {
    writeFileSync(join(outside, 'precious'), 'outside the image');
    write('var/lib/dpkg/status.d/zlib1g.md5sums', `${DIGEST}  ../precious\n`);

    refused(['zlib1g'], /zlib1g lists \.\.\/precious, which is not in the image/);

    // Through a link of the image that points out of it, too.
    link('var/run', outside);
    write('var/lib/dpkg/status.d/zlib1g.md5sums', `${DIGEST}  var/run/precious\n`);

    refused(['zlib1g'], /zlib1g lists var\/run\/precious, which is not in the image/);
    expect(readdirSync(outside).sort()).toEqual(['precious', 'root']);
  });

  it('refuses a file list it cannot read', () => {
    write('var/lib/dpkg/status.d/zlib1g.md5sums', 'not a list\n');

    refused(['zlib1g'], /the file list of zlib1g/);

    write('var/lib/dpkg/status.d/zlib1g.md5sums', `${DIGEST}  usr/share/doc/zlib1g\n`);

    refused(['zlib1g'], /zlib1g lists usr\/share\/doc\/zlib1g, which is not a file/);

    rmSync(join(root, 'var/lib/dpkg/status.d/zlib1g.md5sums'));

    refused(['zlib1g'], /the file list of zlib1g/);
  });
});
