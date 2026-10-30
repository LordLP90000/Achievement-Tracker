import { randomBytes, randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, withUserContext, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';

const CHECK_VIOLATION = { code: '23514' };
const UNIQUE_VIOLATION = { code: '23505' };
const FOREIGN_KEY_VIOLATION = { code: '23503' };
const INSUFFICIENT_PRIVILEGE = { code: '42501' };

const T0 = new Date('2026-10-29T12:00:00.000Z');
const TODAY = '2026-10-29';

type Row = Record<string, string | number | boolean | Date | Buffer | null>;

const blob = () => randomBytes(48);
const rows = {
  user: (id: string): Row => ({
    id,
    email_enc: blob(),
    email_blind_index: randomBytes(32),
    password_hash: 'placeholder-hash',
    timezone: 'Europe/Zurich',
    locale: 'de-CH',
    age_confirmed: true,
    privacy_policy_version: '2026-10',
    password_changed_at: T0,
    created_at: T0,
    updated_at: T0,
  }),
  consent: (userId: string): Row => ({
    id: randomUUID(),
    user_id: userId,
    type: 'goal_content',
    version: '2026-10',
    granted_at: T0,
  }),
  achievement: (userId: string, overrides: Row = {}): Row => ({
    id: randomUUID(),
    user_id: userId,
    title_enc: blob(),
    status: 'active',
    dek_version: 1,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  }),
  quest: (userId: string, achievementId: string, overrides: Row = {}): Row => ({
    id: randomUUID(),
    user_id: userId,
    achievement_id: achievementId,
    position: 0,
    type: 'one_time',
    size: 'M',
    title_enc: blob(),
    dek_version: 1,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  }),
  habit: (userId: string, achievementId: string, overrides: Row = {}): Row =>
    rows.quest(userId, achievementId, {
      type: 'habit',
      habit_period: 'week',
      habit_times_per_period: 3,
      habit_period_count: 8,
      habit_start_date: TODAY,
      habit_week_start: 'monday',
      ...overrides,
    }),
  target: (userId: string, achievementId: string, overrides: Row = {}): Row =>
    rows.quest(userId, achievementId, {
      type: 'target',
      start_value_enc: blob(),
      target_value_enc: blob(),
      ...overrides,
    }),
  checkIn: (userId: string, questId: string): Row => ({
    id: randomUUID(),
    user_id: userId,
    quest_id: questId,
    local_date: TODAY,
    attempt: 1,
    counts_for_progress: true,
    dek_version: 1,
    created_at: T0,
  }),
  gamble: (userId: string, achievementId: string, overrides: Row = {}): Row => ({
    id: randomUUID(),
    user_id: userId,
    achievement_id: achievementId,
    attempt: 1,
    stake: 150,
    status: 'pending',
    placed_at: T0,
    ...overrides,
  }),
  xpEvent: (userId: string, overrides: Row = {}): Row => ({
    id: randomUUID(),
    user_id: userId,
    kind: 'quest_completed',
    amount: 25,
    local_date: TODAY,
    created_at: T0,
    ...overrides,
  }),
  badge: (userId: string, achievementId: string, overrides: Row = {}): Row => ({
    id: randomUUID(),
    user_id: userId,
    achievement_id: achievementId,
    kind: 'achievement_rank',
    rank: 'gold',
    awarded_at: T0,
    ...overrides,
  }),
};

const insert = (tx: TransactionSql, table: string, row: Row) => tx`insert into ${tx(table)} ${tx(row)}`;
const id = (row: Row) => String(row['id']);

interface Seeded {
  readonly userId: string;
  readonly achievementId: string;
  readonly habitId: string;
  readonly dependentId: string;
  readonly gambleId: string;
}

type Counts = Record<'achievements' | 'quests' | 'check_ins' | 'gambles' | 'xp_events' | 'badges', string>;

/** Constraints and policies of the goal-content tables (docs/data-model.md §3.3–3.4, §4): a second line behind the services. */
describe('goal-content tables', () => {
  let database: TestDatabase;
  let app: DatabaseClient;
  let worker: DatabaseClient;

  const asUser = <T>(userId: string, work: (tx: TransactionSql) => Promise<T>) => withUserContext(app, userId, work);
  const appInsert = (userId: string, table: string, row: Row) => asUser(userId, (tx) => insert(tx, table, row));

  /**
   * A consenting user with an achievement, a habit with a check-in, a quest that has the habit as prerequisite, a
   * pending gamble, an XP event linked to all three and a badge.
   */
  async function seed(): Promise<Seeded> {
    const userId = randomUUID();
    const achievement = rows.achievement(userId);
    const habit = rows.habit(userId, id(achievement));
    const dependent = rows.quest(userId, id(achievement), { position: 1, prerequisite_quest_id: id(habit) });
    const gamble = rows.gamble(userId, id(achievement));
    await asUser(userId, async (tx) => {
      await insert(tx, 'users', rows.user(userId));
      await insert(tx, 'consents', rows.consent(userId));
      await insert(tx, 'achievements', achievement);
      await insert(tx, 'quests', habit);
      await insert(tx, 'quests', dependent);
      await insert(tx, 'check_ins', rows.checkIn(userId, id(habit)));
      await insert(tx, 'gambles', gamble);
      await insert(
        tx,
        'xp_events',
        rows.xpEvent(userId, { quest_id: id(habit), achievement_id: id(achievement), gamble_id: id(gamble) }),
      );
      await insert(tx, 'badges', rows.badge(userId, id(achievement)));
    });
    return {
      userId,
      achievementId: id(achievement),
      habitId: id(habit),
      dependentId: id(dependent),
      gambleId: id(gamble),
    };
  }

  const counts = async (userId: string): Promise<Counts> => {
    const [row] = await asUser(
      userId,
      (tx) => tx<Counts[]>`
        select (select count(*) from achievements) as achievements, (select count(*) from quests) as quests,
               (select count(*) from check_ins) as check_ins, (select count(*) from gambles) as gambles,
               (select count(*) from xp_events) as xp_events, (select count(*) from badges) as badges`,
    );
    return { ...row } as Counts;
  };
  const SEEDED: Counts = { achievements: '1', quests: '2', check_ins: '1', gambles: '1', xp_events: '1', badges: '1' };

  const ledgerLinks = async (userId: string) => {
    const events = await asUser(
      userId,
      (tx) => tx<{ quest_id: string | null; achievement_id: string | null; gamble_id: string | null }[]>`
        select quest_id, achievement_id, gamble_id from xp_events`,
    );
    return events.map((event) => ({ ...event }));
  };

  const withdrawConsent = (userId: string) =>
    asUser(userId, (tx) => tx`update consents set withdrawn_at = ${T0} where type = 'goal_content'`);

  beforeAll(async () => {
    database = await createTestDatabase();
    app = createDatabaseClient({ url: database.urls.app, applicationName: 'questline-test' });
    worker = createDatabaseClient({ url: database.urls.worker, applicationName: 'questline-test' });
  });

  afterAll(async () => {
    await Promise.all([app.close(), worker.close()]);
    await database.drop();
  });

  it('removes all goal content with the account, and nothing of other accounts [R-PRIV-06]', async () => {
    const { userId } = await seed();
    const other = await seed();

    await worker.sql`delete from users where id = ${userId}`;

    expect(await counts(userId)).toEqual({
      achievements: '0',
      quests: '0',
      check_ins: '0',
      gambles: '0',
      xp_events: '0',
      badges: '0',
    });
    expect(await counts(other.userId)).toEqual(SEEDED);
  });

  it('removes quests, check-ins, gambles and badges with their achievement, and unlinks its XP events [R-ACH-09]', async () => {
    const { userId, achievementId } = await seed();

    await asUser(userId, (tx) => tx`delete from achievements where id = ${achievementId}`);

    expect(await counts(userId)).toEqual({
      achievements: '0',
      quests: '0',
      check_ins: '0',
      gambles: '0',
      xp_events: '1',
      badges: '0',
    });
    expect(await ledgerLinks(userId)).toEqual([{ quest_id: null, achievement_id: null, gamble_id: null }]);
  });

  it('removes the check-ins of a deleted quest, unlinks its XP events and clears it as prerequisite [R-QST-08]', async () => {
    const { userId, achievementId, habitId, dependentId, gambleId } = await seed();

    await asUser(userId, (tx) => tx`delete from quests where id = ${habitId}`);

    expect(await counts(userId)).toMatchObject({ quests: '1', check_ins: '0', xp_events: '1' });
    const [dependent] = await asUser(
      userId,
      (tx) => tx<{ prerequisite_quest_id: string | null }[]>`
        select prerequisite_quest_id from quests where id = ${dependentId}`,
    );
    expect(dependent?.prerequisite_quest_id).toBeNull();
    expect(await ledgerLinks(userId)).toEqual([{ quest_id: null, achievement_id: achievementId, gamble_id: gambleId }]);
  });

  it("refuses goal content that points at another user's achievement, quest or gamble [T-01, R-AUTHZ-02]", async () => {
    const owner = await seed();
    const intruder = await seed();
    const unbadged = rows.achievement(owner.userId);
    await appInsert(owner.userId, 'achievements', unbadged);
    const settled = { status: 'lost', loss_reason: 'paused', settled_at: T0 };

    for (const [table, row] of [
      ['quests', rows.quest(intruder.userId, owner.achievementId)],
      ['gambles', rows.gamble(intruder.userId, owner.achievementId, settled)],
      ['badges', rows.badge(intruder.userId, id(unbadged))],
      ['check_ins', rows.checkIn(intruder.userId, owner.habitId)],
      ['xp_events', rows.xpEvent(intruder.userId, { quest_id: owner.habitId })],
      ['xp_events', rows.xpEvent(intruder.userId, { achievement_id: owner.achievementId })],
    ] as const) {
      await expect(appInsert(intruder.userId, table, row)).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
    }
  });

  it('refuses a prerequisite from another achievement, and a quest that is its own prerequisite [R-QST-02]', async () => {
    const { userId, achievementId, habitId } = await seed();
    const another = rows.achievement(userId);
    await appInsert(userId, 'achievements', another);
    const self = randomUUID();

    await expect(
      appInsert(userId, 'quests', rows.quest(userId, id(another), { prerequisite_quest_id: habitId })),
    ).rejects.toMatchObject(FOREIGN_KEY_VIOLATION);
    await expect(
      appInsert(userId, 'quests', rows.quest(userId, achievementId, { id: self, prerequisite_quest_id: self })),
    ).rejects.toMatchObject(CHECK_VIOLATION);
  });

  it('keeps an achievement completed exactly when it has a completion time, a score of 0–100 and a rank [R-ACH-04, R-RANK-02]', async () => {
    const { userId } = await seed();
    const completed = { status: 'completed', completed_at: T0, execution_score: 87.5, rank: 'platinum' };

    await expect(appInsert(userId, 'achievements', rows.achievement(userId, completed))).resolves.toBeDefined();
    for (const achievement of [
      rows.achievement(userId, { status: 'completed' }),
      rows.achievement(userId, { ...completed, rank: null }),
      rows.achievement(userId, { ...completed, execution_score: null }),
      rows.achievement(userId, { ...completed, status: 'active' }),
      rows.achievement(userId, { ...completed, execution_score: 100.01 }),
      rows.achievement(userId, { ...completed, execution_score: -0.01 }),
      rows.achievement(userId, { ...completed, rank: 'mythic' }),
      rows.achievement(userId, { status: 'archived' }),
      rows.achievement(userId, { attempt: 0 }),
    ]) {
      await expect(appInsert(userId, 'achievements', achievement)).rejects.toMatchObject(CHECK_VIOLATION);
    }
  });

  it('keeps the type-specific columns of a quest consistent with its type [R-QST-03…05, Q-34]', async () => {
    const { userId, achievementId } = await seed();

    for (const quest of [
      rows.target(userId, achievementId, { unit_enc: blob() }),
      rows.habit(userId, achievementId, { habit_period: 'day', habit_week_start: null }),
      rows.habit(userId, achievementId, { reset_count: 2, needs_restart: true, habit_best_streak: 4 }),
    ]) {
      await expect(appInsert(userId, 'quests', quest)).resolves.toBeDefined();
    }
    for (const quest of [
      rows.habit(userId, achievementId, { habit_start_date: null }),
      rows.habit(userId, achievementId, { habit_week_start: null }),
      rows.habit(userId, achievementId, { habit_week_start: 'friday' }),
      rows.habit(userId, achievementId, { habit_period: 'day' }),
      rows.habit(userId, achievementId, { habit_period: 'month' }),
      rows.habit(userId, achievementId, { habit_times_per_period: 0 }),
      rows.habit(userId, achievementId, { habit_times_per_period: 51 }),
      rows.habit(userId, achievementId, { habit_period_count: 521 }),
      rows.habit(userId, achievementId, { habit_best_streak: -1 }),
      rows.habit(userId, achievementId, { reset_count: -1 }),
      rows.habit(userId, achievementId, { needs_restart: true, completed_at: T0 }),
      rows.habit(userId, achievementId, { start_value_enc: blob(), target_value_enc: blob() }),
      rows.target(userId, achievementId, { target_value_enc: null }),
      rows.target(userId, achievementId, { start_value_enc: null }),
      rows.target(userId, achievementId, {
        habit_period: 'day',
        habit_times_per_period: 1,
        habit_period_count: 1,
        habit_start_date: TODAY,
      }),
      rows.quest(userId, achievementId, { unit_enc: blob() }),
      rows.quest(userId, achievementId, { reset_count: 1 }),
      rows.quest(userId, achievementId, { needs_restart: true }),
      rows.quest(userId, achievementId, { habit_best_streak: 1 }),
      rows.quest(userId, achievementId, { type: 'chore' }),
      rows.quest(userId, achievementId, { size: 'XL' }),
      rows.quest(userId, achievementId, { position: -1 }),
    ]) {
      await expect(appInsert(userId, 'quests', quest)).rejects.toMatchObject(CHECK_VIOLATION);
    }
  });

  it('keeps a gamble’s status, settlement and loss reason consistent, with a positive stake [R-GMB-01…03]', async () => {
    const { userId, achievementId } = await seed();

    for (const gamble of [
      rows.gamble(userId, achievementId, { status: 'won', settled_at: T0 }),
      rows.gamble(userId, achievementId, { status: 'lost', settled_at: T0, loss_reason: 'habit_reset' }),
    ]) {
      await expect(appInsert(userId, 'gambles', gamble)).resolves.toBeDefined();
    }
    for (const gamble of [
      rows.gamble(userId, achievementId, { status: 'won' }),
      rows.gamble(userId, achievementId, { status: 'won', settled_at: new Date(T0.getTime() - 1) }),
      rows.gamble(userId, achievementId, { status: 'won', settled_at: T0, loss_reason: 'paused' }),
      rows.gamble(userId, achievementId, { status: 'lost', settled_at: T0 }),
      rows.gamble(userId, achievementId, { status: 'lost', settled_at: T0, loss_reason: 'bad_luck' }),
      rows.gamble(userId, achievementId, { status: 'won', settled_at: T0, stake: 0 }),
      rows.gamble(userId, achievementId, { status: 'cancelled', settled_at: T0 }),
      rows.gamble(userId, achievementId, { status: 'won', settled_at: T0, attempt: 0 }),
    ]) {
      await expect(appInsert(userId, 'gambles', gamble)).rejects.toMatchObject(CHECK_VIOLATION);
    }
  });

  it('allows one pending gamble per user, across all achievements [R-GMB-01, Q-31]', async () => {
    const { userId } = await seed();
    const another = rows.achievement(userId);
    await appInsert(userId, 'achievements', another);

    await expect(appInsert(userId, 'gambles', rows.gamble(userId, id(another)))).rejects.toMatchObject(
      UNIQUE_VIOLATION,
    );
  });

  it.each([
    ['quest_completed', 10],
    ['rank_bonus', 1],
    ['gamble_won', 1],
    ['xp_floor', 1],
    ['quest_uncompleted', -10],
    ['rank_bonus_revoked', -1],
    ['gamble_lost', -1],
    ['gamble_reverted', -1],
    ['pause_revoked', -1],
    ['quest_deleted', -1],
    ['achievement_deleted', -1],
  ] as const)(
    'records %s XP only with its sign, never as zero or with the other sign [R-XP-01]',
    async (kind, amount) => {
      const { userId } = await seed();

      await expect(appInsert(userId, 'xp_events', rows.xpEvent(userId, { kind, amount }))).resolves.toBeDefined();
      for (const wrong of [0, 0 - amount]) {
        await expect(
          appInsert(userId, 'xp_events', rows.xpEvent(userId, { kind, amount: wrong })),
        ).rejects.toMatchObject(CHECK_VIOLATION);
      }
    },
  );

  it('refuses unknown XP event kinds [R-XP-01]', async () => {
    const { userId } = await seed();

    await expect(
      appInsert(userId, 'xp_events', rows.xpEvent(userId, { kind: 'coupon_redeemed' })),
    ).rejects.toMatchObject(CHECK_VIOLATION);
  });

  it('awards one rank badge per achievement, with a known rank [R-RANK-03, A-06]', async () => {
    const { userId, achievementId } = await seed();
    const another = rows.achievement(userId);
    await appInsert(userId, 'achievements', another);

    await expect(appInsert(userId, 'badges', rows.badge(userId, achievementId))).rejects.toMatchObject(
      UNIQUE_VIOLATION,
    );
    for (const badge of [
      rows.badge(userId, id(another), { rank: 'mythic' }),
      rows.badge(userId, id(another), { kind: 'participation' }),
    ]) {
      await expect(appInsert(userId, 'badges', badge)).rejects.toMatchObject(CHECK_VIOLATION);
    }
    await expect(
      appInsert(userId, 'badges', rows.badge(userId, id(another), { rank: 'unranked' })),
    ).resolves.toBeDefined();
  });

  it('keeps the XP ledger append-only for the API until the goal-content consent is withdrawn [R-XP-01, Q-10]', async () => {
    const { userId } = await seed();

    const deleted = await asUser(userId, (tx) => tx`delete from xp_events`);
    expect(deleted.count).toBe(0);
    await expect(asUser(userId, (tx) => tx`update xp_events set amount = 1000`)).rejects.toMatchObject(
      INSUFFICIENT_PRIVILEGE,
    );

    await withdrawConsent(userId);
    await asUser(userId, (tx) => tx`delete from xp_events`);
    expect(await counts(userId)).toMatchObject({ xp_events: '0' });
  });

  it('keeps completed achievements undeletable for the API until the goal-content consent is withdrawn [R-ACH-07, Q-10]', async () => {
    const { userId } = await seed();
    const completed = rows.achievement(userId, {
      status: 'completed',
      completed_at: T0,
      execution_score: 100,
      rank: 'champion',
    });
    await appInsert(userId, 'achievements', completed);

    const deleted = await asUser(userId, (tx) => tx`delete from achievements where id = ${id(completed)}`);
    expect(deleted.count).toBe(0);

    await withdrawConsent(userId);
    await asUser(userId, (tx) => tx`delete from achievements`);
    expect(await counts(userId)).toMatchObject({ achievements: '0', quests: '0', gambles: '0', badges: '0' });
  });

  it("never shows or changes another user's goal content [R-AUTHZ-02, I-04]", async () => {
    const owner = await seed();
    const intruder = await seed();

    const changed = await asUser(intruder.userId, async (tx) => [
      await tx`update achievements set status = 'paused' where id = ${owner.achievementId}`,
      await tx`delete from quests where id = ${owner.habitId}`,
      await tx`delete from check_ins where quest_id = ${owner.habitId}`,
      await tx`update gambles set status = 'won', settled_at = ${T0} where achievement_id = ${owner.achievementId}`,
      await tx`delete from badges where achievement_id = ${owner.achievementId}`,
    ]);

    expect(changed.map((result) => result.count)).toEqual([0, 0, 0, 0, 0]);
    expect(await counts(owner.userId)).toEqual(SEEDED);
  });
});
