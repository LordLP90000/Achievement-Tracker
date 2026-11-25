import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { inReadOnlyTransaction, type Database } from '../../platform/db/database.ts';
import { withUserDataKey } from '../accounts/data-key.ts';
import { partsByParent, type ExportSource, type Part } from './export-document.ts';
import { exportReads, type ChildSection, type ExportReads, type Page } from './export-repository.ts';

/** How much one read of the export takes. */
export interface ExportReadSizes {
  /** Records of a list, gambles or check-ins. */
  readonly rows: number;
  /** Achievements; each brings its quests, at most 50 (R-IN-01). */
  readonly achievements: number;
}

export const EXPORT_READ_SIZES: ExportReadSizes = { rows: 1000, achievements: 20 };

export interface ExportSourceDependencies {
  readonly db: Database;
  readonly dataKeys: DataKeys;
}

/**
 * What the export document of `userId` is written from (D-09). Each read is a unit of work of its own: a short
 * read-only transaction bound to the user (RLS), with the data key for its duration (ADR-0006). Between two reads
 * nothing is held — no connection, no lock, no key — so a slow or stalled download costs the database nothing.
 * The price: the parts are not read at one instant. What the user changes while the document is being written may
 * show in one section and not in another; every record it lists existed when it was read.
 */
export function exportSource(
  deps: ExportSourceDependencies,
  userId: string,
  sizes: ExportReadSizes = EXPORT_READ_SIZES,
): ExportSource {
  const read = <T>(work: (reads: ExportReads) => Promise<T>): Promise<T> =>
    inReadOnlyTransaction(deps.db, (tx) =>
      withUserDataKey(tx, deps.dataKeys, userId, (dataKey) => work(exportReads(tx, userId, dataKey))),
    );

  async function* pages<T>(page: (reads: ExportReads, after: Page<T>['next']) => Promise<Page<T>>) {
    let after: Page<T>['next'] = null;
    for (;;) {
      const { records, next }: Page<T> = await read((reads) => page(reads, after));
      yield records;
      if (next === null) return;
      after = next;
    }
  }

  const parts = (section: ChildSection, parentIds: readonly string[]): AsyncIterable<Part> =>
    partsByParent(
      {
        ofParents: (ids, limit) => read((reads) => reads.childrenOfParents(section, ids, limit)),
        ofParent: (id, after, limit) => read((reads) => reads.childrenOfParent(section, id, after, limit)),
      },
      parentIds,
      sizes.rows,
    );

  return {
    account: () => read((reads) => reads.account()),
    pages: (section) => pages((reads, after) => reads.list(section, after, sizes.rows)),
    achievements: () => pages((reads, after) => reads.achievements(after, sizes.achievements)),
    gambles: (achievementIds) => parts('gambles', achievementIds),
    checkIns: (questIds) => parts('check_ins', questIds),
  };
}
