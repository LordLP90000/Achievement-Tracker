import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../src/domain/dates.ts';
import { levelForXp, xpToNextLevel } from '../../src/domain/xp.ts';
import { encryptText } from '../../src/platform/crypto/field-cipher.ts';
import { IDS_PER_QUERY } from '../../src/platform/db/batches.ts';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import {
  bearer,
  createAchievement,
  goalUser,
  insertAchievements,
  loggedInAgain,
  type GoalUser,
} from '../helpers/goals.ts';

const START = '2026-10-29T12:00:00Z';
const TODAY = '2026-10-29'; // in Europe/Zurich, a Thursday
const NO_RANKS = { unranked: 0, bronze: 0, silver: 0, gold: 0, platinum: 0, emerald: 0, diamond: 0, champion: 0 };

interface Resource {
  readonly id: string;
  readonly rank?: unknown;
  readonly completed_at?: unknown;
  readonly streak?: unknown;
  readonly [field: string]: unknown;
}

interface Streak {
  readonly quest_id: string;
  readonly quest_title: string;
  readonly period: string;
  readonly best: number;
  readonly current: number;
}

interface Stats {
  readonly xp_total: number;
  readonly level: number;
  readonly xp_to_next_level: number;
  readonly xp_by_day: readonly { readonly date: string; readonly xp: number }[];
  readonly achievements: Readonly<Record<string, unknown>>;
  readonly badges: readonly Resource[];
  readonly best_streaks: readonly Streak[];
  readonly gambles: { readonly won: number; readonly lost: number };
}

/** Stats (contract tag `stats`): XP over time, level, achievements by status and rank, badges, streaks, gambles. */
describe('stats [R-STA-01, R-STR-01, A-13, A-21, A-40, A-43]', () => {
  let ctx: AccountsApp;

  const stats = (user: GoalUser, query = '') =>
    contractInject(ctx.app, { method: 'GET', url: `/v1/me/stats${query}`, headers: bearer(user.token) });
  const statsOf = async (user: GoalUser, query = '') => {
    const response = await stats(user, query);
    if (response.statusCode !== 200) throw new Error(`stats failed: ${String(response.statusCode)}`);
    return response.json<Stats>();
  };
  const achievementOf = async (user: GoalUser, body: Record<string, unknown> = {}) =>
    (await createAchievement(ctx, user.token, { title: 'Goal', ...body })).json<Resource>();
  const createQuest = async (user: GoalUser, achievementId: string, body: Record<string, unknown> = {}) => {
    const response = await ctx.post(
      `/v1/achievements/${achievementId}/quests`,
      { title: 'Quest', type: 'one_time', size: 'M', ...body },
      { ...bearer(user.token), 'idempotency-key': randomUUID() },
    );
    if (response.statusCode !== 201) throw new Error(`quest not created: ${String(response.statusCode)}`);
    return response.json<Resource>();
  };
  const habit = (title: string, options: { readonly startDate?: string; readonly required?: boolean } = {}) => ({
    title,
    type: 'habit',
    is_required: options.required ?? true,
    habit: {
      period: 'day',
      times_per_period: 1,
      period_count: 10,
      ...(options.startDate === undefined ? {} : { start_date: options.startDate }),
    },
  });
  const checkIn = async (user: GoalUser, questId: string, localDate = TODAY) => {
    const response = await ctx.post(
      `/v1/quests/${questId}/check-ins`,
      { local_date: localDate },
      { ...bearer(user.token), 'idempotency-key': randomUUID() },
    );
    if (response.statusCode !== 201) throw new Error(`check-in refused: ${String(response.statusCode)}`);
  };
  const get = async (user: GoalUser, url: string) =>
    (await contractInject(ctx.app, { method: 'GET', url, headers: bearer(user.token) })).json<Resource>();
  const pause = async (user: GoalUser, achievementId: string) => {
    const { version } = await get(user, `/v1/achievements/${achievementId}`);
    const response = await contractInject(ctx.app, {
      method: 'PATCH',
      url: `/v1/achievements/${achievementId}`,
      headers: { ...bearer(user.token), 'content-type': 'application/json', 'if-match': `"${String(version)}"` },
      payload: JSON.stringify({ status: 'paused' }),
    });
    if (response.statusCode !== 200) throw new Error(`pause refused: ${String(response.statusCode)}`);
  };
  const place = async (user: GoalUser, achievementId: string) => {
    const response = await ctx.post(
      `/v1/achievements/${achievementId}/gambles`,
      {},
      { ...bearer(user.token), 'idempotency-key': randomUUID() },
    );
    if (response.statusCode !== 201) throw new Error(`gamble refused: ${String(response.statusCode)}`);
  };
  /** An achievement unlocked by its only quest's check-in, as the API shows it afterwards. */
  const completedAchievement = async (user: GoalUser, title: string) => {
    const achievement = await achievementOf(user, { title });
    await checkIn(user, (await createQuest(user, achievement.id)).id);
    return get(user, `/v1/achievements/${achievement.id}`);
  };
  /** Moves the clock on; the access token has expired by then, so the user logs in again. */
  const afterDays = (user: GoalUser, days: number) => {
    ctx.clock.advance({ days });
    return loggedInAgain(ctx, user);
  };
  const giveXp = (userId: string, amount: number, localDate = TODAY) =>
    ctx.admin.sql`
      insert into xp_events (id, user_id, kind, amount, local_date, created_at)
      values (${randomUUID()}, ${userId}, ${amount > 0 ? 'quest_completed' : 'gamble_lost'}, ${amount},
              ${localDate}, ${ctx.clock.now()})`;
  /** Seals text with the user's data key, bound to record and column, as the API does (R-ACH-02, R-QST-06). */
  const sealerOf = async (user: GoalUser) => {
    const [key] = await ctx.admin.sql<{ wrapped_dek: Buffer; kek_id: string; kek_version: number }[]>`
      select wrapped_dek, kek_id, kek_version from user_keys where user_id = ${user.userId}`;
    if (key === undefined) throw new Error('the user has no data key');
    const wrapped = { blob: key.wrapped_dek, kekId: key.kek_id, kekVersion: key.kek_version };
    return <T>(work: (seal: (recordId: string, field: string, value: string) => Buffer) => T): Promise<T> =>
      ctx.dataKeys.withKey(user.userId, wrapped, (dataKey) =>
        Promise.resolve(
          work((recordId, field, value) => encryptText(dataKey, { userId: user.userId, recordId, field }, value)),
        ),
      );
  };
  /** Completed achievements titled `Old goal 1…count`, with their rank badges awarded a minute apart before now. */
  const insertBadges = async (user: GoalUser, count: number) => {
    const now = ctx.clock.now().getTime();
    const rows = await (
      await sealerOf(user)
    )((seal) =>
      Array.from({ length: count }, (_, index) => {
        const id = randomUUID();
        return {
          id,
          titleEnc: seal(id, 'title_enc', `Old goal ${String(index + 1)}`),
          awardedAt: new Date(now - (index + 1) * 60_000),
        };
      }),
    );
    for (const row of rows) {
      await ctx.admin.sql`
        insert into achievements
          (id, user_id, title_enc, status, dek_version, created_at, updated_at, completed_at, execution_score, rank)
        values (${row.id}, ${user.userId}, ${row.titleEnc}, 'completed', 1, ${row.awardedAt}, ${row.awardedAt},
                ${row.awardedAt}, 80, 'gold')`;
      await ctx.admin.sql`
        insert into badges (id, user_id, achievement_id, kind, rank, awarded_at)
        values (${randomUUID()}, ${user.userId}, ${row.id}, 'achievement_rank', 'gold', ${row.awardedAt})`;
    }
  };
  /**
   * An archive of `count` achievements, created a second apart, each completed today by its daily habit `Habit n` of
   * one period, as the API leaves them; only the newest one's habit ran two periods, yesterday and today.
   */
  const insertArchive = async (user: GoalUser, count: number) => {
    const now = ctx.clock.now();
    const yesterday = addDays(TODAY, -1);
    const rows = await (
      await sealerOf(user)
    )((seal) =>
      Array.from({ length: count }, (_, index) => {
        const newest = index === count - 1;
        const createdAt = new Date(now.getTime() - (count - index) * 1000);
        const achievementId = randomUUID();
        const questId = randomUUID();
        const common = { user_id: user.userId, dek_version: 1, created_at: createdAt };
        return {
          achievement: {
            ...common,
            id: achievementId,
            title_enc: seal(achievementId, 'title_enc', `Goal ${String(index + 1)}`),
            status: 'completed',
            updated_at: now,
            completed_at: now,
            execution_score: 80,
            rank: 'gold',
          },
          quest: {
            ...common,
            id: questId,
            achievement_id: achievementId,
            position: 0,
            type: 'habit',
            size: 'M',
            title_enc: seal(questId, 'title_enc', `Habit ${String(index + 1)}`),
            habit_period: 'day',
            habit_times_per_period: 1,
            habit_period_count: newest ? 2 : 1,
            habit_start_date: newest ? yesterday : TODAY,
            completed_at: now,
            updated_at: now,
          },
          checkIns: (newest ? [yesterday, TODAY] : [TODAY]).map((localDate) => ({
            ...common,
            id: randomUUID(),
            quest_id: questId,
            local_date: localDate,
            attempt: 1,
            counts_for_progress: true,
          })),
        };
      }),
    );
    const { sql } = ctx.admin;
    await sql`insert into achievements ${sql(rows.map((row) => row.achievement))}`;
    await sql`insert into quests ${sql(rows.map((row) => row.quest))}`;
    await sql`insert into check_ins ${sql(rows.flatMap((row) => row.checkIns))}`;
    return rows.map((row) => row.quest.id);
  };

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.clock.set(START);
  });

  it('answers a new account’s stats: 31 days without XP up to today, level 1, nothing counted [R-STA-01, A-43]', async () => {
    const user = await goalUser(ctx);

    const response = await stats(user);

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      xp_total: 0,
      level: 1,
      xp_to_next_level: xpToNextLevel(0),
      xp_by_day: Array.from({ length: 31 }, (_, offset) => ({ date: addDays(TODAY, offset - 30), xp: 0 })),
      achievements: { active: 0, paused: 0, completed: 0, completed_by_rank: NO_RANKS },
      badges: [],
      best_streaks: [],
      gambles: { won: 0, lost: 0 },
    });
  });

  it('sums the ledger per local day from `from` to `to`, days without XP at 0; the total counts every day [R-STA-01, A-13]', async () => {
    const user = await goalUser(ctx);
    const other = await goalUser(ctx);
    await giveXp(user.userId, 500, '2026-09-30');
    await giveXp(user.userId, 120, '2026-10-01');
    await giveXp(user.userId, 30, '2026-10-01');
    await giveXp(user.userId, -20, '2026-10-03');
    await giveXp(user.userId, 7, '2026-10-05');
    await giveXp(other.userId, 999, '2026-10-02');

    const result = await statsOf(user, '?from=2026-10-01&to=2026-10-04');

    expect(result).toMatchObject({ xp_total: 637, level: levelForXp(637), xp_to_next_level: xpToNextLevel(637) });
    expect(result.level).toBe(3);
    expect(result.xp_by_day).toEqual([
      { date: '2026-10-01', xp: 150 },
      { date: '2026-10-02', xp: 0 },
      { date: '2026-10-03', xp: -20 },
      { date: '2026-10-04', xp: 0 },
    ]);
  });

  it('ends the series today unless `to` is given and starts it 30 days before `to` unless `from` is; 366 days at most [A-43]', async () => {
    const user = await goalUser(ctx);
    const days = async (query: string) => (await statsOf(user, query)).xp_by_day.map((day) => day.date);
    const series = (from: string, length: number) => Array.from({ length }, (_, offset) => addDays(from, offset));

    expect(await days('?to=2026-06-15')).toEqual(series('2026-05-16', 31));
    expect(await days('?from=2026-10-20')).toEqual(series('2026-10-20', 10));
    expect(await days(`?from=${TODAY}&to=${TODAY}`)).toEqual([TODAY]);
    expect(await days('?from=2026-10-30&to=2026-11-01')).toEqual(series('2026-10-30', 3));
    expect(await days('?from=2025-10-29&to=2026-10-29')).toEqual(series('2025-10-29', 366));
    expect(await days('?to=1970-01-10')).toEqual(series('1969-12-11', 31));
  });

  it('refuses a range that is reversed, longer than 366 days, before 1970 or not made of dates with 400 [R-IN-01, A-43]', async () => {
    const user = await goalUser(ctx);
    const refusals = [
      ['?from=2026-10-29&to=2026-10-28', '/from'],
      ['?from=2026-10-30', '/from'],
      ['?from=2025-10-28&to=2026-10-29', '/from'],
      ['?from=1969-12-31&to=1970-01-01', '/from'],
      ['?to=1969-12-31', '/to'],
      ['?to=0000-01-15', '/to'],
      ['?to=2026-02-30', '/to'],
      ['?from=2026-10-01T00:00:00Z', '/from'],
      ['?from=yesterday', '/from'],
    ] as const;

    for (const [query, pointer] of refusals) {
      const response = await stats(user, query);
      expect(response.statusCode, query).toBe(400);
      expect(response.json(), query).toMatchObject({
        type: 'urn:questline:problem:validation',
        errors: [expect.objectContaining({ pointer })],
      });
    }
  });

  it('counts the achievements by status and the completed ones by rank [R-STA-01, R-RANK-01]', async () => {
    const user = await goalUser(ctx);
    await achievementOf(user);
    await achievementOf(user);
    await pause(user, (await achievementOf(user)).id);
    const completed = await completedAchievement(user, 'Done');
    await insertAchievements(ctx, user.userId, 3, 'completed');
    await insertAchievements(ctx, (await goalUser(ctx)).userId, 2, 'completed');
    const byRank: Record<string, number> = { ...NO_RANKS, gold: 3 };
    const rank = String(completed.rank);
    byRank[rank] = (byRank[rank] ?? Number.NaN) + 1;

    const result = await statsOf(user);

    expect(result.achievements).toEqual({ active: 2, paused: 1, completed: 4, completed_by_rank: byRank });
  });

  it('lists the rank badges newest first with their achievement’s title, at most 200 [R-STA-01, R-RANK-03]', async () => {
    const user = await goalUser(ctx);
    await insertBadges(user, 199);
    const first = await completedAchievement(user, 'Run a marathon');
    ctx.clock.advance({ minutes: 1 });
    const second = await completedAchievement(user, 'Learn Italian');

    const { badges } = await statsOf(user);

    const badgeOf = (achievement: Resource, title: string) => ({
      id: expect.any(String) as unknown,
      kind: 'achievement_rank',
      rank: achievement.rank,
      achievement_id: achievement.id,
      achievement_title: title,
      awarded_at: achievement.completed_at,
    });
    expect(badges).toHaveLength(200);
    expect(badges.slice(0, 3)).toEqual([
      badgeOf(second, 'Learn Italian'),
      badgeOf(first, 'Run a marathon'),
      {
        id: expect.any(String) as unknown,
        kind: 'achievement_rank',
        rank: 'gold',
        achievement_id: expect.any(String) as unknown,
        achievement_title: 'Old goal 1',
        awarded_at: new Date(Date.parse(START) - 60_000).toISOString(),
      },
    ]);
    expect(badges.at(-1)).toMatchObject({ achievement_title: 'Old goal 198' });
  });

  it('lists the habits’ streaks, best first, then the longer current one, as GET /quests shows them [R-STR-01, R-STA-01, A-43]', async () => {
    let user = await goalUser(ctx);
    const achievement = await achievementOf(user);
    const steady = await createQuest(user, achievement.id, habit('Meditate'));
    const fading = await createQuest(user, achievement.id, habit('Stretch'));
    const broken = await createQuest(user, achievement.id, habit('Read'));
    await createQuest(user, achievement.id, habit('Not begun', { startDate: '2026-11-02' }));
    const once = await createQuest(user, achievement.id, { title: 'Once' });
    for (const quest of [steady, fading, broken, once]) await checkIn(user, quest.id);
    user = await afterDays(user, 1);
    for (const quest of [steady, fading]) await checkIn(user, quest.id, '2026-10-30');
    user = await afterDays(user, 1);
    await checkIn(user, steady.id, '2026-10-31');

    const { best_streaks: streaks } = await statsOf(user);

    expect(streaks).toEqual([
      { quest_id: steady.id, quest_title: 'Meditate', period: 'day', best: 3, current: 3 },
      { quest_id: fading.id, quest_title: 'Stretch', period: 'day', best: 2, current: 2 },
      { quest_id: broken.id, quest_title: 'Read', period: 'day', best: 1, current: 0 },
    ]);
    for (const streak of streaks) {
      expect((await get(user, `/v1/quests/${streak.quest_id}`)).streak).toEqual({
        period: 'day',
        best: streak.best,
        current: streak.current,
      });
    }
  });

  it('lists at most 20 streaks, equal ones in the order of their quest IDs [R-STA-01]', async () => {
    const user = await goalUser(ctx);
    const achievement = await achievementOf(user);
    const questIds: string[] = [];
    for (let index = 1; index <= 21; index += 1) {
      const quest = await createQuest(user, achievement.id, habit(`Habit ${String(index)}`));
      await checkIn(user, quest.id);
      questIds.push(quest.id);
    }

    const { best_streaks: streaks } = await statsOf(user);

    expect(streaks.map((streak) => streak.quest_id)).toEqual(questIds.toSorted().slice(0, 20));
    expect(streaks.every((streak) => streak.best === 1 && streak.current === 1)).toBe(true);
  });

  it('evaluates an archive of more than a thousand achievements in batches, the last one included [R-STA-01, Q-40]', async () => {
    const user = await goalUser(ctx);
    const count = IDS_PER_QUERY + 1;
    const questIds = await insertArchive(user, count);

    const result = await statsOf(user);

    expect(result.achievements).toMatchObject({ active: 0, paused: 0, completed: count });
    expect(result.best_streaks).toHaveLength(20);
    expect(result.best_streaks[0]).toEqual({
      quest_id: questIds.at(-1),
      quest_title: `Habit ${String(count)}`,
      period: 'day',
      best: 2,
      current: 2,
    });
    expect(result.best_streaks.slice(1).map((streak) => streak.quest_id)).toEqual(
      questIds.slice(0, -1).toSorted().slice(0, 19),
    );
    expect(result.best_streaks.slice(1).every((streak) => streak.best === 1 && streak.current === 1)).toBe(true);
  });

  it('evaluates the habits as of now: a period missed since the last request ends the run, which the read stores [A-21, R-QST-04]', async () => {
    let user = await goalUser(ctx);
    const achievement = await achievementOf(user);
    const quest = await createQuest(user, achievement.id, habit('Run'));
    await checkIn(user, quest.id);
    user = await afterDays(user, 1);
    await checkIn(user, quest.id, '2026-10-30');
    user = await afterDays(user, 2);

    const { best_streaks: streaks } = await statsOf(user);

    expect(streaks).toEqual([{ quest_id: quest.id, quest_title: 'Run', period: 'day', best: 2, current: 0 }]);
    expect(
      await ctx.admin.sql`select needs_restart, reset_count, habit_best_streak from quests where id = ${quest.id}`,
    ).toEqual([{ needs_restart: true, reset_count: 1, habit_best_streak: 2 }]);
  });

  it('shows a paused achievement’s habits as reset and a completed one’s as on its unlock day, storing nothing [R-ACH-06, A-40]', async () => {
    let user = await goalUser(ctx);
    const paused = await achievementOf(user, { title: 'Paused' });
    const resting = await createQuest(user, paused.id, habit('Swim'));
    const archived = await achievementOf(user, { title: 'Archived' });
    const bonus = await createQuest(user, archived.id, habit('Stretch', { required: false }));
    const finish = await createQuest(user, archived.id, { title: 'Finish' });
    for (const quest of [resting, bonus]) await checkIn(user, quest.id);
    user = await afterDays(user, 1);
    for (const quest of [resting, bonus, finish]) await checkIn(user, quest.id, '2026-10-30');
    await pause(user, paused.id);
    user = await afterDays(user, 4);
    const quests = () =>
      ctx.admin.sql`select id, needs_restart, reset_count, habit_best_streak, habit_start_date, version
                    from quests where achievement_id in (${paused.id}, ${archived.id}) order by id`;
    const before = await quests();

    const result = await statsOf(user);

    expect(result.achievements).toMatchObject({ active: 0, paused: 1, completed: 1 });
    expect(result.best_streaks).toEqual([
      { quest_id: bonus.id, quest_title: 'Stretch', period: 'day', best: 2, current: 2 },
      { quest_id: resting.id, quest_title: 'Swim', period: 'day', best: 2, current: 0 },
    ]);
    expect(await quests()).toEqual(before);
  });

  it('counts the won and lost gambles of every achievement, after settling a passed target date [R-STA-01, R-GMB-03, A-21]', async () => {
    let user = await goalUser(ctx);
    await giveXp(user.userId, 250);
    for (const title of ['Won', 'Won again']) {
      const won = await achievementOf(user, { title, target_date: '2026-11-30' });
      const quest = await createQuest(user, won.id);
      await place(user, won.id);
      await checkIn(user, quest.id);
    }
    // A young achievement's win pays nothing (A-34): XP above the level's threshold for the last stake.
    await giveXp(user.userId, 50);
    const lost = await achievementOf(user, { title: 'Lost', target_date: '2026-10-30' });
    await createQuest(user, lost.id);
    await place(user, lost.id);
    user = await afterDays(user, 2);

    const result = await statsOf(user);

    expect(result.gambles).toEqual({ won: 2, lost: 1 });
    expect(await ctx.admin.sql`select status from gambles where user_id = ${user.userId} order by status`).toEqual([
      { status: 'lost' },
      { status: 'won' },
      { status: 'won' },
    ]);
    expect(
      await ctx.admin.sql`
        select sum(amount)::int as total, count(*) filter (where kind = 'gamble_lost')::int as losses
        from xp_events where user_id = ${user.userId}`,
    ).toEqual([{ total: result.xp_total, losses: 1 }]);
  });

  it('counts only the user’s own XP, achievements, badges, streaks and gambles [R-AUTHZ-01, T-01]', async () => {
    const other = await goalUser(ctx);
    await giveXp(other.userId, 250);
    const theirs = await achievementOf(other, { target_date: '2026-11-30' });
    const theirQuest = await createQuest(other, theirs.id);
    await checkIn(other, (await createQuest(other, theirs.id, habit('Theirs', { required: false }))).id);
    await place(other, theirs.id);
    await checkIn(other, theirQuest.id);
    await pause(other, (await achievementOf(other)).id);
    const user = await goalUser(ctx);

    const result = await statsOf(user);

    expect(result).toMatchObject({
      xp_total: 0,
      achievements: { active: 0, paused: 0, completed: 0, completed_by_rank: NO_RANKS },
      badges: [],
      best_streaks: [],
      gambles: { won: 0, lost: 0 },
    });
    expect(result.xp_by_day.filter((day) => day.xp !== 0)).toEqual([]);
    const otherStats = await statsOf(other);
    expect(otherStats).toMatchObject({ achievements: { paused: 1, completed: 1 }, gambles: { won: 1, lost: 0 } });
    expect([otherStats.badges.length, otherStats.best_streaks.length]).toEqual([1, 1]);
  });
});
