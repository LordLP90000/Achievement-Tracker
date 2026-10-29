import { createHash } from 'node:crypto';

/**
 * Probabilistic set membership for the offline breached-password check (ADR-0012). False positives are possible
 * (the user is asked for another password), false negatives are not. Hashing: SHA-256 split into two 32-bit
 * values, combined by double hashing (Kirsch–Mitzenmacher).
 */

const MAGIC = Buffer.from('QLBF', 'ascii');
const VERSION = 1;
// magic(4) version(1) hashes(1) reserved(2) bits(4) entries(4) source sha-256(32) min length(2) reserved(2)
const HEADER_BYTES = 52;

export class BloomFilterFormatError extends Error {
  override readonly name = 'BloomFilterFormatError';

  constructor() {
    super('invalid Bloom filter file');
  }
}

export interface BloomFilterMeta {
  /** Number of distinct values added. */
  readonly entries: number;
  /** Shortest value that was included (shorter ones are rejected by the length rule anyway). */
  readonly minLength: number;
  /** SHA-256 of the source list, to prove which list the filter was built from. */
  readonly source: Buffer;
}

export class BloomFilter {
  readonly bits: number;
  readonly hashes: number;
  readonly #array: Uint8Array;

  private constructor(bits: number, hashes: number, array: Uint8Array) {
    this.bits = bits;
    this.hashes = hashes;
    this.#array = array;
  }

  static create(expectedEntries: number, falsePositiveRate: number): BloomFilter {
    if (!Number.isInteger(expectedEntries) || expectedEntries < 1) {
      throw new RangeError('expectedEntries must be a positive integer');
    }
    if (!(falsePositiveRate > 0 && falsePositiveRate < 1)) {
      throw new RangeError('falsePositiveRate must be between 0 and 1');
    }
    const bits = Math.ceil((-expectedEntries * Math.log(falsePositiveRate)) / Math.LN2 ** 2);
    const hashes = Math.max(1, Math.round((bits / expectedEntries) * Math.LN2));
    return new BloomFilter(bits, hashes, new Uint8Array(Math.ceil(bits / 8)));
  }

  static deserialize(file: Buffer): { filter: BloomFilter; meta: BloomFilterMeta } {
    if (file.length < HEADER_BYTES || !file.subarray(0, 4).equals(MAGIC) || file[4] !== VERSION) {
      throw new BloomFilterFormatError();
    }
    const hashes = file.readUInt8(5);
    const bits = file.readUInt32BE(8);
    if (hashes < 1 || bits < 1 || file.length !== HEADER_BYTES + Math.ceil(bits / 8)) {
      throw new BloomFilterFormatError();
    }
    const meta = {
      entries: file.readUInt32BE(12),
      source: Buffer.from(file.subarray(16, 48)),
      minLength: file.readUInt16BE(48),
    };
    return { filter: new BloomFilter(bits, hashes, new Uint8Array(file.subarray(HEADER_BYTES))), meta };
  }

  add(value: string): void {
    for (const index of this.#indexes(value)) {
      this.#array[index >>> 3] = (this.#array[index >>> 3] ?? 0) | (1 << (index & 7));
    }
  }

  has(value: string): boolean {
    return this.#indexes(value).every((index) => ((this.#array[index >>> 3] ?? 0) & (1 << (index & 7))) !== 0);
  }

  serialize(meta: BloomFilterMeta): Buffer {
    const header = Buffer.alloc(HEADER_BYTES);
    MAGIC.copy(header, 0);
    header.writeUInt8(VERSION, 4);
    header.writeUInt8(this.hashes, 5);
    header.writeUInt32BE(this.bits, 8);
    header.writeUInt32BE(meta.entries, 12);
    meta.source.copy(header, 16, 0, 32);
    header.writeUInt16BE(meta.minLength, 48);
    return Buffer.concat([header, this.#array]);
  }

  #indexes(value: string): number[] {
    const digest = createHash('sha256').update(value, 'utf8').digest();
    const first = digest.readUInt32BE(0);
    const step = (digest.readUInt32BE(4) | 1) >>> 0;
    return Array.from({ length: this.hashes }, (_, round) => (first + round * step) % this.bits);
  }
}
