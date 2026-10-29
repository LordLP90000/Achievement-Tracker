import { fieldAssociatedData, open, seal, type FieldContext } from './aead.ts';

/** Text fields encrypted with the user's data key; the AD binds them to user, record and column (ADR-0006). */

export function encryptText(dataKey: Uint8Array, context: FieldContext, value: string): Buffer {
  return seal(dataKey, Buffer.from(value, 'utf8'), fieldAssociatedData(context));
}

export function decryptText(dataKey: Uint8Array, context: FieldContext, blob: Uint8Array): string {
  return open(dataKey, blob, fieldAssociatedData(context)).toString('utf8');
}
