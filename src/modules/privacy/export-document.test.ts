import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  exportText,
  LIST_SECTIONS,
  partsByParent,
  type Child,
  type ChildReads,
  type ExportSource,
  type ExportedAchievement,
  type ExportedRecord,
  type ListSection,
  type Part,
} from './export-document.ts';

const GENERATED_AT = new Date('2026-11-25T08:00:00.000Z');

interface Account {
  readonly account: ExportedRecord;
  readonly totp: ExportedRecord | null;
  readonly lists: Readonly<Record<ListSection, readonly ExportedRecord[]>>;
  readonly achievements: readonly ExportedAchievement[];
  /** By achievement ID, in their order. */
  readonly gambles: ReadonlyMap<string, readonly ExportedRecord[]>;
  /** By quest ID, in their order. */
  readonly checkIns: ReadonlyMap<string, readonly ExportedRecord[]>;
}

/** How a source cuts what it hands out: the document must not depend on it. */
interface Cuts {
  readonly page: number;
  readonly achievements: number;
  readonly part: number;
}

const inPages = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

/** A source over an account held in memory; it counts its reads. */
function sourceOf(data: Account, cuts: Cuts): ExportSource & { reads(): number } {
  let reads = 0;
  async function* pagesOf<T>(items: readonly T[], size: number): AsyncGenerator<readonly T[]> {
    // An empty list still takes one read to find out.
    for (const page of items.length === 0 ? [[]] : inPages(items, size)) {
      reads += 1;
      yield await Promise.resolve(page);
    }
  }
  async function* partsOf(
    children: ReadonlyMap<string, readonly ExportedRecord[]>,
    parentIds: readonly string[],
  ): AsyncGenerator<Part> {
    for (const parentId of parentIds) {
      const parts = inPages(children.get(parentId) ?? [], cuts.part);
      // A parent whose children fill its parts exactly is closed by an empty one, as a full last page is.
      const closed = parts.length === 0 || parts.at(-1)?.length === cuts.part ? [...parts, []] : parts;
      for (const [index, records] of closed.entries()) {
        reads += 1;
        yield await Promise.resolve({ parentId, records, last: index === closed.length - 1 });
      }
    }
  }
  return {
    reads: () => reads,
    account: () => {
      reads += 1;
      return Promise.resolve({ account: data.account, totp: data.totp });
    },
    pages: (section) => pagesOf(data.lists[section], cuts.page),
    achievements: () => pagesOf(data.achievements, cuts.achievements),
    gambles: (achievementIds) => partsOf(data.gambles, achievementIds),
    checkIns: (questIds) => partsOf(data.checkIns, questIds),
  };
}

/** The document as one in-memory read would build it: the contract's `ExportDocument`. */
const documentOf = (data: Account) => ({
  format: 'questline-export',
  version: 1,
  generated_at: GENERATED_AT.toISOString(),
  account: data.account,
  consents: data.lists.consents,
  sessions: data.lists.sessions,
  passkeys: data.lists.passkeys,
  two_factor: { totp: data.totp, recovery_codes: data.lists.recovery_codes },
  achievements: data.achievements.map((achievement) => ({
    ...achievement.record,
    gambles: data.gambles.get(String(achievement.record['id'])) ?? [],
    quests: achievement.quests.map((quest) => ({ ...quest, check_ins: data.checkIns.get(String(quest['id'])) ?? [] })),
  })),
  xp_events: data.lists.xp_events,
  badges: data.lists.badges,
  audit_events: data.lists.audit_events,
});

async function written(source: ExportSource): Promise<string[]> {
  const pieces: string[] = [];
  for await (const piece of exportText(source, GENERATED_AT)) pieces.push(piece);
  return pieces;
}

const emptyLists = () =>
  Object.fromEntries(LIST_SECTIONS.map((section) => [section, []])) as unknown as Record<ListSection, ExportedRecord[]>;

const EMPTY: Account = {
  account: { id: 'user-1', email: 'lena@example.test', nickname: null },
  totp: null,
  lists: emptyLists(),
  achievements: [],
  gambles: new Map(),
  checkIns: new Map(),
};

const SMALL: Account = {
  account: { id: 'user-1', email: 'lena@example.test', nickname: 'Lena "the brave" \u2028 Müller' },
  totp: { enabled_at: '2026-11-01T10:00:00.000Z', created_at: '2026-11-01T09:59:00.000Z' },
  lists: {
    ...emptyLists(),
    consents: [{ id: 'consent-1', type: 'goal_content' }],
    sessions: [{ id: 'session-1' }, { id: 'session-2' }, { id: 'session-3' }],
    recovery_codes: [{ id: 'code-1' }, { id: 'code-2' }],
    xp_events: [
      { id: 'xp-1', amount: 10 },
      { id: 'xp-2', amount: -10 },
    ],
    audit_events: [{ id: 'audit-1', metadata: { type: 'goal_content' } }],
  },
  achievements: [
    { record: { id: 'a-1', title: 'Run a marathon' }, quests: [] },
    {
      record: { id: 'a-2', title: 'Read more' },
      quests: [
        { id: 'q-1', title: 'A page a day' },
        { id: 'q-2', title: 'Join the library' },
        { id: 'q-3', title: 'No check-ins' },
      ],
    },
    { record: { id: 'a-3', title: 'Sleep' }, quests: [{ id: 'q-4', title: 'Lights out' }] },
  ],
  gambles: new Map([
    ['a-1', [{ id: 'g-1' }, { id: 'g-2' }, { id: 'g-3' }]],
    ['a-3', [{ id: 'g-4' }]],
  ]),
  checkIns: new Map([
    [
      'q-1',
      [
        { id: 'c-1', note: 'ch. 1' },
        { id: 'c-2', note: null },
        { id: 'c-3', note: 'ch. 3' },
      ],
    ],
    ['q-2', [{ id: 'c-4', note: 'done' }]],
    [
      'q-4',
      [
        { id: 'c-5', note: 'in bed at ten' },
        { id: 'c-6', note: null },
      ],
    ],
  ]),
};

describe('exportText: the export document, written in pieces [R-PRIV-05, D-09]', () => {
  it('writes the contract’s document: sections in order, gambles and quests in their achievement, check-ins in their quest', async () => {
    const text = (await written(sourceOf(SMALL, { page: 100, achievements: 100, part: 100 }))).join('');

    expect(JSON.parse(text)).toEqual(documentOf(SMALL));
    expect(text).toBe(JSON.stringify(documentOf(SMALL)));
  });

  it('writes an account without anything as empty lists, and no TOTP as null', async () => {
    const text = (await written(sourceOf(EMPTY, { page: 100, achievements: 100, part: 100 }))).join('');

    expect(text).toBe(JSON.stringify(documentOf(EMPTY)));
    expect(JSON.parse(text)).toMatchObject({ achievements: [], audit_events: [], two_factor: { totp: null } });
  });

  it.each<Cuts>([
    { page: 1, achievements: 1, part: 1 },
    { page: 2, achievements: 2, part: 2 },
    { page: 3, achievements: 1, part: 3 },
    { page: 1, achievements: 3, part: 2 },
  ])('writes the same text however its source cuts the reads: %o', async (cuts) => {
    expect((await written(sourceOf(SMALL, cuts))).join('')).toBe(JSON.stringify(documentOf(SMALL)));
  });

  it('writes the same text as one read would, for any account and any cut of the reads', async () => {
    const record = (prefix: string) =>
      fc.record({ id: fc.uuid().map((id) => `${prefix}-${id}`), text: fc.option(fc.string(), { nil: null }) });
    const account = fc
      .record({
        totp: fc.option(fc.record({ enabled_at: fc.constant('2026-11-01T10:00:00.000Z') }), { nil: null }),
        sessions: fc.array(record('s'), { maxLength: 7 }),
        auditEvents: fc.array(record('e'), { maxLength: 7 }),
        achievements: fc.array(
          fc.record({
            record: record('a'),
            gambles: fc.array(record('g'), { maxLength: 5 }),
            quests: fc.array(fc.record({ quest: record('q'), checkIns: fc.array(record('c'), { maxLength: 7 }) }), {
              maxLength: 4,
            }),
          }),
          { maxLength: 5 },
        ),
      })
      .map(({ totp, sessions, auditEvents, achievements }): Account => ({
        account: { id: 'user-1' },
        totp,
        lists: { ...emptyLists(), sessions, audit_events: auditEvents },
        achievements: achievements.map(({ record: own, quests }) => ({
          record: own,
          quests: quests.map(({ quest }) => quest),
        })),
        gambles: new Map(achievements.map(({ record: own, gambles }) => [own.id, gambles] as const)),
        checkIns: new Map(
          achievements.flatMap(({ quests }) => quests.map(({ quest, checkIns }) => [quest.id, checkIns] as const)),
        ),
      }));
    const cut = fc.integer({ min: 1, max: 5 });

    await fc.assert(
      fc.asyncProperty(account, cut, cut, cut, async (data, page, achievements, part) => {
        const text = (await written(sourceOf(data, { page, achievements, part }))).join('');
        expect(text).toBe(JSON.stringify(documentOf(data)));
      }),
    );
  });

  it('reads on demand: a reader that stops makes it read no further', async () => {
    const note = 'x'.repeat(200);
    const checkIns = Array.from({ length: 2000 }, (_, index) => ({ id: `c-${String(index)}`, note }));
    const data: Account = {
      ...EMPTY,
      achievements: [{ record: { id: 'a-1' }, quests: [{ id: 'q-1' }] }],
      checkIns: new Map([['q-1', checkIns]]),
    };
    const whole = sourceOf(data, { page: 10, achievements: 1, part: 10 });
    await written(whole);
    const source = sourceOf(data, { page: 10, achievements: 1, part: 10 });
    const pieces = exportText(source, GENERATED_AT);

    const first = await pieces.next();
    const readsForTheFirstPiece = source.reads();
    await pieces.return(undefined);

    expect(first.done).toBe(false);
    expect(readsForTheFirstPiece).toBeLessThan(whole.reads() / 4);
    expect(source.reads()).toBe(readsForTheFirstPiece);
  });

  it('hands out pieces of a useful size: neither one per record nor the whole document', async () => {
    const note = 'x'.repeat(200);
    const data: Account = {
      ...EMPTY,
      lists: {
        ...emptyLists(),
        audit_events: Array.from({ length: 3000 }, (_, index) => ({ id: `e-${String(index)}`, note })),
      },
    };

    const pieces = await written(sourceOf(data, { page: 1000, achievements: 1, part: 10 }));

    expect(pieces.join('')).toBe(JSON.stringify(documentOf(data)));
    expect(pieces.length).toBeGreaterThan(10);
    expect(pieces.length).toBeLessThan(300);
    expect(Math.max(...pieces.map((piece) => piece.length))).toBeLessThan(64 * 1024);
  });

  it.each([
    ['check-ins', 'checkIns', 'the check-ins do not follow their quests'],
    ['gambles', 'gambles', 'the gambles do not follow their achievements'],
  ] as const)('refuses to write %s that come in another order than their parents', async (_name, method, message) => {
    const source = sourceOf(SMALL, { page: 100, achievements: 100, part: 100 });
    const misled: ExportSource = {
      ...source,
      [method]: (ids: readonly string[]) => source[method]([...ids].reverse()),
    };

    await expect(written(misled)).rejects.toThrow(message);
  });

  it('refuses to write children that end before their parents do', async () => {
    const source = sourceOf(SMALL, { page: 100, achievements: 100, part: 100 });
    const cutShort: ExportSource = { ...source, checkIns: (ids) => source.checkIns(ids.slice(0, 1)) };

    await expect(written(cutShort)).rejects.toThrow('the check-ins do not follow their quests');
  });
});

describe('partsByParent: the children of many parents in bounded reads [D-09]', () => {
  interface Stored {
    readonly id: string;
    readonly parent: string;
    readonly at: string;
  }
  const inOrder = (a: Stored, b: Stored) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
  const recordOf = (row: Stored): ExportedRecord => ({ id: row.id, created_at: row.at });

  /** Children held in memory, read as the repository reads them; it notes what each read asked for and got. */
  function stored(rows: readonly Stored[]): ChildReads & { readonly got: number[]; readonly asked: number[] } {
    const got: number[] = [];
    const asked: number[] = [];
    const sorted = [...rows].sort(inOrder);
    return {
      got,
      asked,
      ofParents: (parentIds, limit) => {
        const children: Child[] = sorted
          .filter((row) => parentIds.includes(row.parent))
          .slice(0, limit)
          .map((row) => ({ parentId: row.parent, record: recordOf(row) }));
        asked.push(limit);
        got.push(children.length);
        return Promise.resolve(children);
      },
      ofParent: (parentId, after, limit) => {
        const own = sorted.filter((row) => row.parent === parentId);
        const start = after === null ? 0 : own.findIndex((row) => row.id === after.id) + 1;
        const page = own.slice(start, start + limit);
        const last = page.at(-1);
        asked.push(limit);
        got.push(page.length);
        return Promise.resolve({
          records: page.map(recordOf),
          next: page.length < limit || last === undefined ? null : { at: new Date(last.at), id: last.id },
        });
      },
    };
  }
  /** `count` children of the parent; three share each minute, so the order needs their IDs as well. */
  const childrenOf = (parent: string, count: number, minute = 0): Stored[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `${parent}-c${String(index).padStart(5, '0')}`,
      parent,
      at: new Date(Date.UTC(2026, 10, 25, 8, minute + Math.floor(index / 3))).toISOString(),
    }));
  async function parts(reads: ChildReads, parentIds: readonly string[], batch: number): Promise<Part[]> {
    const all: Part[] = [];
    for await (const part of partsByParent(reads, parentIds, batch)) all.push(part);
    return all;
  }
  /** Every parent in order, in one or more parts with the last one marked; its children complete and in order. */
  function expectAligned(all: readonly Part[], parentIds: readonly string[], rows: readonly Stored[]): void {
    expect(all.filter((part) => part.last).map((part) => part.parentId)).toEqual(parentIds);
    expect([...new Set(all.map((part) => part.parentId))]).toEqual(parentIds);
    for (const parentId of parentIds) {
      const own = all.filter((part) => part.parentId === parentId);
      expect(own.slice(0, -1).every((part) => !part.last)).toBe(true);
      expect(own.flatMap((part) => part.records)).toEqual(
        rows
          .filter((row) => row.parent === parentId)
          .sort(inOrder)
          .map(recordOf),
      );
    }
  }

  it('gives every parent its children in order, whatever the batch, and never asks for more than one row beyond it', async () => {
    const counts = fc.array(fc.integer({ min: 0, max: 12 }), { maxLength: 12 });

    await fc.assert(
      fc.asyncProperty(counts, fc.integer({ min: 1, max: 6 }), async (perParent, batch) => {
        const parentIds = perParent.map((_, index) => `p${String(index)}`);
        const rows = perParent.flatMap((count, index) => childrenOf(`p${String(index)}`, count, index % 3));
        const reads = stored(rows);

        const all = await parts(reads, parentIds, batch);

        expectAligned(all, parentIds, rows);
        expect(Math.max(0, ...reads.asked)).toBeLessThanOrEqual(batch + 1);
        expect(Math.max(0, ...all.map((part) => part.records.length))).toBeLessThanOrEqual(batch);
      }),
    );
  });

  it('reads parents without children a thousand at a time', async () => {
    const parentIds = Array.from({ length: 2500 }, (_, index) => `p${String(index)}`);
    const reads = stored([]);

    const all = await parts(reads, parentIds, 1000);

    expectAligned(all, parentIds, []);
    expect(reads.got).toEqual([0, 0, 0]);
  });

  it('reads nothing for no parents', async () => {
    const reads = stored([]);

    expect(await parts(reads, [], 1000)).toEqual([]);
    expect(reads.got).toEqual([]);
  });

  it('pages through a parent that holds more children than a batch', async () => {
    const rows = [...childrenOf('small', 2), ...childrenOf('big', 25), ...childrenOf('after', 1)];

    const all = await parts(stored(rows), ['small', 'big', 'after'], 10);

    expectAligned(all, ['small', 'big', 'after'], rows);
    expect(all.filter((part) => part.parentId === 'big').map((part) => [part.records.length, part.last])).toEqual([
      [10, false],
      [10, false],
      [5, true],
    ]);
  });

  it('closes a parent whose children fill its pages exactly with an empty last part', async () => {
    const rows = childrenOf('big', 20);

    const all = await parts(stored(rows), ['big'], 10);

    expectAligned(all, ['big'], rows);
    expect(all.map((part) => [part.records.length, part.last])).toEqual([
      [10, false],
      [10, false],
      [0, true],
    ]);
  });

  it('narrows its window to what a batch holds, and widens it at once where there are no children', async () => {
    const dense = Array.from({ length: 64 }, (_, index) => `dense${String(index)}`);
    const sparse = Array.from({ length: 64 }, (_, index) => `sparse${String(index)}`);
    const rows = dense.flatMap((parentId, index) => childrenOf(parentId, 4, index));
    const reads = stored(rows);

    const all = await parts(reads, [...dense, ...sparse], 10);

    expectAligned(all, [...dense, ...sparse], rows);
    // 256 children in batches of 10 take at least 26 reads; finding the window costs a few more.
    expect(reads.got.length).toBeGreaterThanOrEqual(26);
    expect(reads.got.length).toBeLessThan(60);
    // The 64 parents without children are not read two at a time: the window opens fully after the first empty read.
    expect(reads.got.slice(-3)).toEqual([8, 0, 0]);
  });
});
