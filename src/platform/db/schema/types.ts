import { customType, timestamp } from 'drizzle-orm/pg-core';

/** Binary values: ciphertext (`*_enc`), digests and blind indexes. postgres.js reads and writes them as Buffers. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** Instants are always `timestamptz`; the application sets them from the injected Clock (architecture §4.6). */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
