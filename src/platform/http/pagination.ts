import { z } from 'zod';
import { isUuidV4 } from './validation.ts';

/**
 * Cursor pagination of every list operation (R-IN-01, architecture §3): newest first, keyed by `(created_at, id)`,
 * so pages neither repeat nor skip rows when rows are added or removed between requests (unlike offsets).
 */

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

/** The `created_at` and `id` of the last row a client has seen. */
export interface PagePosition {
  readonly createdAt: Date;
  readonly id: string;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/** Only the canonical form `toISOString` writes, so a decoded cursor names exactly the instant it was made from. */
const instant = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});

const cursorContent = z.strictObject({ t: instant, i: z.string().refine(isUuidV4) });

/** Base64url of `{"t": instant, "i": id}`: opaque to clients, who only hand it back (contract `Cursor`). */
export function encodeCursor(position: PagePosition): string {
  return Buffer.from(JSON.stringify({ t: position.createdAt.toISOString(), i: position.id })).toString('base64url');
}

/** The position a cursor names, or null for anything this server could not have issued. Never throws. */
export function decodeCursor(cursor: string): PagePosition | null {
  let content: unknown;
  try {
    content = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = cursorContent.safeParse(content);
  return parsed.success ? { createdAt: new Date(parsed.data.t), id: parsed.data.i } : null;
}

const CURSOR = /^[\w-]{1,200}$/;
/** Plain decimal digits only: no sign, exponent, fraction, whitespace or leading zero. */
const LIMIT = /^[1-9]\d{0,2}$/;

/** Query parameters `cursor` and `limit` (contract `Cursor`, `Limit`), to spread into a list's query schema. */
export const pageParams = {
  cursor: z
    .string()
    .regex(CURSOR)
    .transform((value, context) => {
      const position = decodeCursor(value);
      if (position === null) context.addIssue({ code: 'custom', message: 'is not a valid cursor' });
      return position ?? z.NEVER;
    })
    .optional(),
  limit: z.string().regex(LIMIT).transform(Number).pipe(z.number().max(PAGE_SIZE_MAX)).default(PAGE_SIZE_DEFAULT),
};

/**
 * A page from rows read with `limit + 1`: the extra row only proves that a next page exists, and the cursor
 * continues after the last row returned.
 */
export function pageOf<T>(rows: readonly T[], limit: number, positionOf: (row: T) => PagePosition): Page<T> {
  if (rows.length <= limit) return { items: [...rows], nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: encodeCursor(positionOf(items[limit - 1] as T)) };
}
