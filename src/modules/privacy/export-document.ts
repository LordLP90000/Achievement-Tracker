import { IDS_PER_QUERY } from '../../platform/db/batches.ts';

/**
 * The export document (R-PRIV-05), written in pieces. An account can hold any number of check-ins, gambles, events
 * and completed achievements (Q-40), and a document built in one piece cost memory and blocked every other request in
 * proportion (D-09). So it is read part by part and written as its parts arrive: neither the server nor the database
 * ever holds more than one part.
 */

/** One exported row: column names (without `_enc`) to JSON values. */
export type ExportedRecord = Readonly<Record<string, unknown>>;

/** The sections that are plain lists of the account's records, in the order the document lists them. */
export const LIST_SECTIONS = [
  'consents',
  'sessions',
  'passkeys',
  'recovery_codes',
  'xp_events',
  'badges',
  'audit_events',
] as const;
export type ListSection = (typeof LIST_SECTIONS)[number];

/** An achievement with its quests, at most 50 (R-IN-01); its gambles and their check-ins come in parts. */
export interface ExportedAchievement {
  readonly record: ExportedRecord;
  readonly quests: readonly ExportedRecord[];
}

/** Children of one parent — the gambles of an achievement, the check-ins of a quest — in their order. */
export interface Part {
  readonly parentId: string;
  readonly records: readonly ExportedRecord[];
  /** The parent has no more children after these. */
  readonly last: boolean;
}

/** Where a list was left: its order is by time, then ID. */
export interface Position {
  readonly at: Date;
  readonly id: string;
}

/** What the document is written from. Every call reads one bounded part; nothing is read before it is asked for. */
export interface ExportSource {
  account(): Promise<{ readonly account: ExportedRecord; readonly totp: ExportedRecord | null }>;
  pages(section: ListSection): AsyncIterable<readonly ExportedRecord[]>;
  achievements(): AsyncIterable<readonly ExportedAchievement[]>;
  /** For each of the achievements, in this order, its gambles in one or more parts. */
  gambles(achievementIds: readonly string[]): AsyncIterable<Part>;
  /** For each of the quests, in this order, its check-ins in one or more parts. */
  checkIns(questIds: readonly string[]): AsyncIterable<Part>;
}

export interface Child {
  readonly parentId: string;
  readonly record: ExportedRecord;
}

/** The two reads `partsByParent` needs of a child table. */
export interface ChildReads {
  /** The first `limit` children of these parents together, oldest first. */
  ofParents(parentIds: readonly string[], limit: number): Promise<readonly Child[]>;
  /** The parent's next `limit` children after `after`, oldest first, and where to go on; null after the last one. */
  ofParent(
    parentId: string,
    after: Position | null,
    limit: number,
  ): Promise<{ readonly records: readonly ExportedRecord[]; readonly next: Position | null }>;
}

/**
 * The children of each parent, in the parents' order, without ever reading more than `batch` + 1 rows: several
 * parents at once while their children fit into a batch together — as many as the last read suggests — and a parent
 * with more children than a batch by itself, page by page.
 */
export async function* partsByParent(
  reads: ChildReads,
  parentIds: readonly string[],
  batch: number,
): AsyncGenerator<Part> {
  let start = 0;
  let width = IDS_PER_QUERY;
  while (start < parentIds.length) {
    const parents = parentIds.slice(start, start + width);
    // One row more than a batch tells whether these parents have more.
    const children = await reads.ofParents(parents, batch + 1);
    if (children.length <= batch) {
      const byParent = Map.groupBy(children, (child) => child.parentId);
      for (const parentId of parents) {
        yield { parentId, records: (byParent.get(parentId) ?? []).map((child) => child.record), last: true };
      }
      start += parents.length;
      width =
        children.length === 0
          ? IDS_PER_QUERY
          : Math.min(IDS_PER_QUERY, Math.max(1, Math.floor((parents.length * batch) / children.length)));
    } else if (parents.length > 1) {
      width = Math.ceil(parents.length / 2);
    } else {
      // The one parent in the window has more children than a batch.
      for (const parentId of parents) yield* pagesOf(reads, parentId, batch);
      start += 1;
    }
  }
}

async function* pagesOf(reads: ChildReads, parentId: string, batch: number): AsyncGenerator<Part> {
  let after: Position | null = null;
  for (;;) {
    const page = await reads.ofParent(parentId, after, batch);
    yield { parentId, records: page.records, last: page.next === null };
    if (page.next === null) return;
    after = page.next;
  }
}

/** Characters after which a piece is handed out: enough for the network, little to hold. */
const PIECE_LENGTH = 16 * 1024;

/** The text written so far, handed out in pieces. */
function writer() {
  let text = '';
  function* rest(): Generator<string> {
    if (text.length === 0) return;
    const piece = text;
    text = '';
    yield piece;
  }
  return {
    add(more: string): void {
      text += more;
    },
    /** What was written, once it is worth handing out. */
    *ready(): Generator<string> {
      if (text.length >= PIECE_LENGTH) yield* rest();
    },
    rest,
  };
}
type Writer = ReturnType<typeof writer>;

/** Records one after another, with commas between them. */
function listing(out: Writer) {
  let empty = true;
  return function* add(records: readonly ExportedRecord[]): Generator<string> {
    for (const record of records) {
      out.add(empty ? JSON.stringify(record) : `,${JSON.stringify(record)}`);
      empty = false;
      yield* out.ready();
    }
  };
}

/** The record's JSON object, left open for more members. */
function opened(record: ExportedRecord): string {
  const text = JSON.stringify(record);
  return text === '{}' ? '{' : `${text.slice(0, -1)},`;
}

function idOf(record: ExportedRecord): string {
  const id = record['id'];
  if (typeof id !== 'string') throw new Error('an exported record has no ID');
  return id;
}

/** The children of `parentId`, which the next parts must hand out: parts follow their parents, or `otherwise`. */
async function* childrenOf(
  out: Writer,
  parts: AsyncIterator<Part>,
  parentId: string,
  otherwise: string,
): AsyncGenerator<string> {
  const add = listing(out);
  for (;;) {
    const next = await parts.next();
    if (next.done === true || next.value.parentId !== parentId) throw new Error(otherwise);
    yield* add(next.value.records);
    if (next.value.last) return;
  }
}

async function* achievementsOf(out: Writer, source: ExportSource): AsyncGenerator<string> {
  let first = true;
  for await (const page of source.achievements()) {
    const questIds = page.flatMap((achievement) => achievement.quests.map(idOf));
    const gambles = source.gambles(page.map((achievement) => idOf(achievement.record)))[Symbol.asyncIterator]();
    const checkIns = source.checkIns(questIds)[Symbol.asyncIterator]();
    try {
      for (const { record, quests } of page) {
        out.add(`${first ? '' : ','}${opened(record)}"gambles":[`);
        first = false;
        yield* childrenOf(out, gambles, idOf(record), 'the gambles do not follow their achievements');
        out.add('],"quests":[');
        for (const [index, quest] of quests.entries()) {
          out.add(`${index === 0 ? '' : ','}${opened(quest)}"check_ins":[`);
          yield* childrenOf(out, checkIns, idOf(quest), 'the check-ins do not follow their quests');
          out.add(']}');
        }
        out.add(']}');
        yield* out.ready();
      }
    } finally {
      // Also when the reader stopped: nothing more is read.
      await gambles.return?.();
      await checkIns.return?.();
    }
  }
}

async function* listOf(out: Writer, source: ExportSource, section: ListSection): AsyncGenerator<string> {
  out.add(`,"${section}":[`);
  const add = listing(out);
  for await (const page of source.pages(section)) yield* add(page);
  out.add(']');
}

/**
 * The contract's `ExportDocument` as JSON text, in pieces of about 16 KiB. It reads its source as it writes, so a
 * reader that takes its time, or stops, makes it read no faster and no further.
 */
export async function* exportText(source: ExportSource, generatedAt: Date): AsyncGenerator<string> {
  const out = writer();
  const { account, totp } = await source.account();
  out.add(`{"format":"questline-export","version":1,"generated_at":${JSON.stringify(generatedAt.toISOString())}`);
  out.add(`,"account":${JSON.stringify(account)}`);
  yield* listOf(out, source, 'consents');
  yield* listOf(out, source, 'sessions');
  yield* listOf(out, source, 'passkeys');
  out.add(`,"two_factor":{"totp":${JSON.stringify(totp)}`);
  yield* listOf(out, source, 'recovery_codes');
  out.add('},"achievements":[');
  yield* achievementsOf(out, source);
  out.add(']');
  yield* listOf(out, source, 'xp_events');
  yield* listOf(out, source, 'badges');
  yield* listOf(out, source, 'audit_events');
  out.add('}');
  yield* out.rest();
}
