// A build step of docker/Dockerfile (ADR-0017 as amended): takes Debian packages out of an image's file system.
//   node remove-image-packages.ts <root> <package>...
// The distroless Node.js image carries the system OpenSSL with the zstd and zlib that it needs, although Node.js
// brings its own and loads none of the three. Only what nothing left in the image needs may go: no package that
// stays depends on a removed one, and no program or library that stays is linked against a removed library.
// Otherwise this fails, and the image build with it, before anything is removed.
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the distroless images keep one entry and one file list (`<name>.md5sums`) per package. */
const PACKAGE_LIST = 'var/lib/dpkg/status.d';
const FILE_LIST_SUFFIX = '.md5sums';

export interface RemovedPackages {
  /** What was removed, relative to the root: the packages' files and entries, links to them, emptied directories. */
  readonly removed: readonly string[];
  /** How many programs and libraries that stay were read for what they need. */
  readonly checked: number;
}

interface Dependency {
  /** As the package states it, e.g. `debconf (>= 0.5) | debconf-2.0`. */
  readonly text: string;
  /** The package names that satisfy it. */
  readonly names: readonly string[];
}

interface Package {
  /** Its entry in the package list. */
  readonly entry: string;
  readonly name: string;
  /** The names others may depend on it by: its own and those it provides. */
  readonly names: readonly string[];
  readonly dependencies: readonly Dependency[];
}

/** The package name of `libssl3 (>= 3.0.0)` or `python3:any`. */
const packageName = (relation: string): string => /^[^\s(:]+/.exec(relation.trim())?.[0] ?? '';

function readPackage(directory: string, entry: string): Package {
  const fields = new Map<string, string>();
  for (const line of readFileSync(join(directory, entry), 'utf8').split('\n')) {
    const [, field, value] = /^([\w-]+):(.*)$/.exec(line) ?? [];
    if (field !== undefined && value !== undefined) fields.set(field.toLowerCase(), value.trim());
  }
  const listed = (field: string): string[] =>
    (fields.get(field) ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  const name = fields.get('package') ?? entry;
  return {
    entry,
    name,
    names: [name, ...listed('provides').map(packageName)],
    dependencies: [...listed('pre-depends'), ...listed('depends')].map((text) => ({
      text,
      names: text.split('|').map(packageName),
    })),
  };
}

/** The files of a package, as its file list names them: relative to the root. */
function fileList(directory: string, name: string): string[] {
  const file = join(directory, `${name}${FILE_LIST_SUFFIX}`);
  if (!existsSync(file)) throw new Error(`the image lacks the file list of ${name}`);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const path = /^[0-9a-f]{32} {2}(.+)$/.exec(line)?.[1];
      if (path === undefined) throw new Error(`cannot read the file list of ${name}: ${line}`);
      return path;
    });
}

/**
 * Where a path of the image is on this machine, its directory followed through the image's own links (`/lib` is a
 * link to `/usr/lib`); undefined when that leads out of the image.
 */
function locate(image: string, path: string): string | undefined {
  if (isAbsolute(path)) return undefined;
  const target = resolve(image, path);
  if (!target.startsWith(`${image}${sep}`)) return undefined;
  if (!existsSync(dirname(target))) return target;
  const directory = realpathSync(dirname(target));
  return directory === image || directory.startsWith(`${image}${sep}`) ? join(directory, basename(target)) : undefined;
}

/** Every file and link of the image, without following a link to a directory. */
function* entriesOf(directory: string): Generator<{ readonly path: string; readonly link: boolean }> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) yield { path, link: true };
    else if (entry.isDirectory()) yield* entriesOf(path);
    else if (entry.isFile()) yield { path, link: false };
  }
}

const ELF_MAGIC = Buffer.from('\x7fELF', 'latin1');
const ELF_HEADER_BYTES = 64;
const PROGRAM_HEADER_BYTES = 56;
const DYNAMIC_ENTRY_BYTES = 16;
const LOAD_SEGMENT = 1;
const DYNAMIC_SEGMENT = 2;
const DT_NEEDED = 1;
const DT_STRTAB = 5;
const DT_SONAME = 14;
/** Longer than any library name. */
const NAME_BYTES = 256;

interface Linkage {
  /** The libraries the dynamic loader must find for it. */
  readonly needed: readonly string[];
  /** The name others are linked against it by; a library without one is known by its file name. */
  readonly soname: string | undefined;
}

/**
 * What a program or library asks of the dynamic loader; undefined for a file that is neither. A file that says it is
 * one and cannot be read stops everything: assuming that it needs nothing could break the image.
 */
function linkageOf(file: string, label: string): Linkage | undefined {
  const descriptor = openSync(file, 'r');
  try {
    const { size } = fstatSync(descriptor);
    const read = (bytes: number, position: number): Buffer => {
      if (position < 0 || bytes < 0 || position + bytes > size) throw new Error(`${label} is cut short or damaged`);
      const buffer = Buffer.alloc(bytes);
      readSync(descriptor, buffer, 0, bytes, position);
      return buffer;
    };
    if (size < ELF_MAGIC.length || !read(ELF_MAGIC.length, 0).equals(ELF_MAGIC)) return undefined;
    const header = read(ELF_HEADER_BYTES, 0);
    if (header[4] !== 2 || header[5] !== 1) throw new Error(`${label} is not a 64-bit little-endian ELF file`);
    const segmentBytes = header.readUInt16LE(54);
    const segmentCount = header.readUInt16LE(56);
    if (segmentCount > 0 && segmentBytes < PROGRAM_HEADER_BYTES) throw new Error(`${label} is cut short or damaged`);
    const segments = read(segmentBytes * segmentCount, Number(header.readBigUInt64LE(32)));
    const loaded: { offset: number; address: number; bytes: number }[] = [];
    let dynamic: Buffer = Buffer.alloc(0);
    for (let index = 0; index < segmentCount; index += 1) {
      const at = index * segmentBytes;
      const offset = Number(segments.readBigUInt64LE(at + 8));
      const bytes = Number(segments.readBigUInt64LE(at + 32));
      const type = segments.readUInt32LE(at);
      if (type === LOAD_SEGMENT) loaded.push({ offset, address: Number(segments.readBigUInt64LE(at + 16)), bytes });
      if (type === DYNAMIC_SEGMENT) dynamic = read(bytes, offset);
    }

    const neededAt: number[] = [];
    let sonameAt: number | undefined;
    let stringsAddress: number | undefined;
    for (let at = 0; at + DYNAMIC_ENTRY_BYTES <= dynamic.length; at += DYNAMIC_ENTRY_BYTES) {
      const tag = Number(dynamic.readBigInt64LE(at));
      const value = Number(dynamic.readBigUInt64LE(at + 8));
      if (tag === 0) break;
      if (tag === DT_NEEDED) neededAt.push(value);
      if (tag === DT_SONAME) sonameAt = value;
      if (tag === DT_STRTAB) stringsAddress = value;
    }
    const name = (index: number): string => {
      const address = stringsAddress ?? -1;
      const segment = loaded.find((part) => address >= part.address && address < part.address + part.bytes);
      if (segment === undefined) throw new Error(`${label} is cut short or damaged`);
      const position = address - segment.address + segment.offset + index;
      const text = read(Math.min(NAME_BYTES, size - position), position);
      const end = text.indexOf(0);
      if (end < 0) throw new Error(`${label} is cut short or damaged`);
      return text.subarray(0, end).toString('latin1');
    };
    return { needed: neededAt.map(name), soname: sonameAt === undefined ? undefined : name(sonameAt) };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Removes the packages from the image at `root`: their files, their entries in the package list, links to their
 * files, and the directories this leaves empty. Throws, with nothing removed, when the image lacks one of them,
 * when a package that stays depends on one, or when a program or library that stays needs one of their libraries.
 */
export function removeImagePackages(root: string, packages: readonly string[]): RemovedPackages {
  const image = realpathSync(root);
  const list = join(image, PACKAGE_LIST);
  const shown = (path: string): string => relative(image, path).split(sep).join('/');

  // What goes: the listed files that exist, and the packages' entries.
  const going = new Set<string>();
  for (const name of new Set(packages)) {
    if (!existsSync(join(list, name))) throw new Error(`the image has no package ${name}`);
    for (const path of fileList(list, name)) {
      const file = locate(image, path);
      if (file === undefined) throw new Error(`${name} lists ${path}, which is not in the image`);
      const found = lstatSync(file, { throwIfNoEntry: false });
      if (found === undefined) continue;
      if (found.isDirectory()) throw new Error(`${name} lists ${path}, which is not a file`);
      going.add(file);
    }
    going.add(join(list, name)).add(join(list, `${name}${FILE_LIST_SUFFIX}`));
  }

  // With them, every link that points at one of them, directly or through another link.
  const entries = [...entriesOf(image)];
  const links = entries.filter((entry) => entry.link).map((entry) => entry.path);
  for (let found = true; found;) {
    found = false;
    for (const link of links.filter((path) => !going.has(path))) {
      const target = readlinkSync(link);
      const pointsAt = locate(
        image,
        isAbsolute(target) ? relative(sep, target) : relative(image, resolve(dirname(link), target)),
      );
      if (pointsAt !== undefined && going.has(pointsAt)) {
        going.add(link);
        found = true;
      }
    }
  }

  // No package that stays may depend on one that goes: on its name, or on a name only it provides.
  const problems: string[] = [];
  const installed = readdirSync(list)
    .filter((entry) => !entry.endsWith(FILE_LIST_SUFFIX))
    .map((entry) => readPackage(list, entry));
  const staying = installed.filter((candidate) => !packages.includes(candidate.entry));
  const namesBefore = new Set(installed.flatMap((candidate) => candidate.names));
  const namesAfter = new Set(staying.flatMap((candidate) => candidate.names));
  for (const { name, dependencies } of staying) {
    for (const { text, names } of dependencies) {
      // A dependency that was not met before is not broken by this (the image's ca-certificates asks for openssl).
      if (names.some((needed) => namesBefore.has(needed)) && !names.some((needed) => namesAfter.has(needed))) {
        problems.push(`${name} depends on ${text}`);
      }
    }
  }

  // No program or library that stays may need a library that goes.
  const libraries = new Set<string>();
  for (const { path, link } of entries.filter((entry) => going.has(entry.path))) {
    const linkage = link ? undefined : linkageOf(path, shown(path));
    if (link || linkage !== undefined) libraries.add(basename(path));
    if (linkage?.soname !== undefined) libraries.add(linkage.soname);
  }
  let checked = 0;
  for (const { path, link } of entries.filter((entry) => !going.has(entry.path))) {
    const linkage = link ? undefined : linkageOf(path, shown(path));
    if (linkage === undefined) continue;
    checked += 1;
    for (const needed of linkage.needed.filter((library) => libraries.has(library))) {
      problems.push(`${shown(path)} needs ${needed}`);
    }
  }
  if (problems.length > 0) throw new Error(`cannot remove ${packages.join(', ')}: ${problems.join('; ')}`);

  for (const path of going) unlinkSync(path);
  const emptied: string[] = [];
  for (const start of new Set([...going].map((path) => dirname(path)))) {
    for (
      let directory = start;
      directory !== image && existsSync(directory) && readdirSync(directory).length === 0;
      directory = dirname(directory)
    ) {
      rmdirSync(directory);
      emptied.push(directory);
    }
  }
  return { removed: [...going, ...emptied].map(shown).sort(), checked };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root, ...packages] = process.argv.slice(2);
  if (root === undefined || packages.length === 0) {
    throw new Error('usage: node remove-image-packages.ts <root> <package>...');
  }
  const { removed, checked } = removeImagePackages(root, packages);
  process.stdout.write(
    `removed ${packages.join(', ')}: ${String(removed.length)} paths; ` +
      `none of the ${String(checked)} programs and libraries that stay needs them\n`,
  );
}
