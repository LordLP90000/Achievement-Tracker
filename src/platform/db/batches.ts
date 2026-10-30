/**
 * PostgreSQL binds at most 65 535 parameters per statement, so a list of IDs that grows with a user's data — the
 * archive has no limit (Q-40) — is sent in batches well below that.
 */
export const IDS_PER_QUERY = 1000;

/** The items in order, in consecutive batches of at most `size`; none for no items. */
export function inBatches<T>(items: readonly T[], size: number = IDS_PER_QUERY): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('a batch holds at least one item');
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) batches.push(items.slice(start, start + size));
  return batches;
}
