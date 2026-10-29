/**
 * Narrow type declaration for the parts of `sodium-native` (5.x) used by `src/platform/crypto`; the package ships no
 * types. Only `src/platform/crypto` may import it (dependency-cruiser rule).
 */
declare module 'sodium-native' {
  export interface SecureBuffer extends Buffer {
    /** True when the memory comes from `sodium_malloc` (guard pages, locked, wiped on free). */
    readonly secure: boolean;
  }

  interface Sodium {
    /** Writes ciphertext and tag into `c` (`m.length + ABYTES`); returns the number of bytes written. */
    crypto_aead_xchacha20poly1305_ietf_encrypt(
      c: Uint8Array,
      m: Uint8Array,
      ad: Uint8Array | null,
      nsec: null,
      npub: Uint8Array,
      k: Uint8Array,
    ): number;
    /** Writes the plaintext into `m` (`c.length - ABYTES`); throws when the tag does not verify. */
    crypto_aead_xchacha20poly1305_ietf_decrypt(
      m: Uint8Array,
      nsec: null,
      c: Uint8Array,
      ad: Uint8Array | null,
      npub: Uint8Array,
      k: Uint8Array,
    ): number;
    randombytes_buf(buffer: Uint8Array): void;
    sodium_malloc(size: number): SecureBuffer;
    sodium_memzero(buffer: Uint8Array): void;
    /** Size of the PHC string buffer, including the terminating NUL. */
    readonly crypto_pwhash_STRBYTES: number;
    crypto_pwhash_str(out: Uint8Array, passwd: Uint8Array, opslimit: number, memlimit: number): void;
    /** Argon2id13 on the libuv thread pool; resolves when `out` holds the NUL-terminated PHC string. */
    crypto_pwhash_str_async(out: Uint8Array, passwd: Uint8Array, opslimit: number, memlimit: number): Promise<void>;
    /** Resolves `false` for a wrong password or an unreadable hash; never rejects for those. */
    crypto_pwhash_str_verify_async(str: Uint8Array, passwd: Uint8Array): Promise<boolean>;
    crypto_pwhash_str_needs_rehash(str: Uint8Array, opslimit: number, memlimit: number): boolean;
  }

  const sodium: Sodium;
  export default sodium;
}
