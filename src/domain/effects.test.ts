import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  deleteAchievementEffects,
  deleteQuestEffects,
  pauseEffects,
  reconcile,
  type AchievementFacts,
  type EffectContext,
  type Outcome,
  type QuestFacts,
} from './effects.ts';

const DAY_MS = 86_400_000;
const CREATED = Date.parse('2026-10-01T09:00:00Z');
const NOW = Date.parse('2026-10-29T12:00:00Z');
const context: EffectContext = { nowMs: NOW, today: '2026-10-29', totalXp: 1_000 };

const quest = (id: string, overrides: Partial<QuestFacts> = {}): QuestFacts => ({
  id,
  isRequired: true,
  xp: 25,
  resetCount: 0,
  completed: false,
  credited: 0,
  ...overrides,
});
const achievement = (overrides: Partial<AchievementFacts> = {}): AchievementFacts => ({
  status: 'active',
  attempt: 1,
  createdAtMs: CREATED,
  deadline: null,
  rankBonusCredited: 0,
  lostGambles: 0,
  pendingGamble: null,
  wonGamble: null,
  ...overrides,
});
const sum = (outcome: Outcome) => outcome.events.reduce((total, event) => total + event.amount, 0);

/** Applies an outcome as the service persists it: credited XP per quest, rank bonus, status and gambles. */
function apply(facts: AchievementFacts, quests: readonly QuestFacts[], outcome: Outcome) {
  const credited = (questId: string) =>
    outcome.events.filter((event) => event.questId === questId).reduce((total, event) => total + event.amount, 0);
  const bonus = outcome.events
    .filter((event) => event.kind === 'rank_bonus' || event.kind === 'rank_bonus_revoked')
    .reduce((total, event) => total + event.amount, 0);
  const settled = outcome.gamble;
  return {
    facts: {
      ...facts,
      status: outcome.status,
      rankBonusCredited: facts.rankBonusCredited + bonus,
      lostGambles: facts.lostGambles + (settled?.outcome === 'lost' ? 1 : 0),
      pendingGamble: settled === null ? facts.pendingGamble : null,
      wonGamble:
        settled?.outcome === 'won'
          ? { id: settled.id, paid: settled.xpDelta }
          : settled === null
            ? facts.wonGamble
            : null,
    },
    quests: quests.map((q) => ({ ...q, credited: q.credited + credited(q.id) })),
    totalXp: outcome.totalXp,
  };
}

describe('effects of a check-in, an undo or a quest edit: reconcile [R-XP-01, R-ACH-04, R-ACH-05, R-CHK-06]', () => {
  it('credits a quest once when it completes, without unlocking while another required quest is open', () => {
    const outcome = reconcile(achievement(), [quest('a', { completed: true }), quest('b')], context);

    expect(outcome.events).toEqual([{ kind: 'quest_completed', amount: 25, questId: 'a', gambleId: null }]);
    expect(outcome).toMatchObject({ status: 'active', unlock: null, relocked: false, gamble: null, totalXp: 1_025 });
  });

  it('unlocks when every required quest is complete: score, rank, rank bonus [R-RANK-01…03]', () => {
    const outcome = reconcile(
      achievement(),
      [
        quest('a', { completed: true, credited: 25 }),
        quest('b', { completed: true, xp: 75 }),
        quest('bonus', { isRequired: false }),
      ],
      context,
    );

    expect(outcome.events).toEqual([
      { kind: 'quest_completed', amount: 75, questId: 'b', gambleId: null },
      { kind: 'rank_bonus', amount: 12_000, questId: null, gambleId: null },
    ]);
    expect(outcome).toMatchObject({
      status: 'completed',
      unlock: { score: 100, rank: 'diamond' },
      relocked: false,
      totalXp: 13_075,
    });
  });

  it('makes a flawless first attempt with every bonus quest done Champion', () => {
    const outcome = reconcile(
      achievement(),
      [quest('a', { completed: true }), quest('bonus', { isRequired: false, completed: true, xp: 10 })],
      context,
    );

    expect(outcome.unlock).toEqual({ score: 100, rank: 'champion' });
    expect(outcome.events).toContainEqual({ kind: 'rank_bonus', amount: 9_125, questId: null, gambleId: null });
  });

  it('pays no rank bonus for an achievement younger than 7 × 24 hours, but records score and rank (Q-31, A-34)', () => {
    const outcome = reconcile(
      achievement({ createdAtMs: NOW - 7 * DAY_MS + 1 }),
      [quest('a', { completed: true })],
      context,
    );

    expect(outcome.unlock).toEqual({ score: 100, rank: 'champion' });
    expect(outcome.events).toEqual([{ kind: 'quest_completed', amount: 25, questId: 'a', gambleId: null }]);
  });

  it('wins a pending gamble on an unlock before its target date, paying at most the required XP (Q-31)', () => {
    const facts = achievement({ pendingGamble: { id: 'g', stake: 150, targetDate: '2026-11-30' } });
    const outcome = reconcile(facts, [quest('a', { completed: true, xp: 50 })], context);

    expect(outcome.gamble).toEqual({ id: 'g', outcome: 'won', xpDelta: 50, lossReason: null });
    expect(outcome.events).toContainEqual({ kind: 'gamble_won', amount: 50, questId: null, gambleId: 'g' });
  });

  it('loses a pending gamble whose target date has passed before anything else, and counts it in the score (A-20)', () => {
    const facts = achievement({ pendingGamble: { id: 'g', stake: 150, targetDate: '2026-10-28' } });
    const outcome = reconcile(facts, [quest('a', { completed: true })], { ...context, totalXp: 1_000 });

    expect(outcome.gamble).toEqual({ id: 'g', outcome: 'lost', xpDelta: -100, lossReason: 'target_date_passed' });
    expect(outcome.events[0]).toEqual({ kind: 'gamble_lost', amount: -100, questId: null, gambleId: 'g' });
    expect(outcome.unlock).toEqual({ score: 90, rank: 'platinum' });
  });

  it('loses a pending gamble when a habit of the achievement reset (R-GMB-03)', () => {
    const facts = achievement({ pendingGamble: { id: 'g', stake: 150, targetDate: '2026-11-30' } });
    const outcome = reconcile(facts, [quest('a')], context, { habitReset: true });

    expect(outcome.gamble).toEqual({ id: 'g', outcome: 'lost', xpDelta: -100, lossReason: 'habit_reset' });
  });

  it('keeps a pending gamble while its target date is today or later', () => {
    const facts = achievement({ pendingGamble: { id: 'g', stake: 150, targetDate: '2026-10-29' } });

    expect(reconcile(facts, [quest('a')], context)).toMatchObject({ gamble: null, events: [] });
  });

  it('re-locks on an undo that makes a required quest incomplete: revokes quest XP and bonus, reverts the win', () => {
    const unlocked = achievement({
      status: 'completed',
      rankBonusCredited: 9_125,
      wonGamble: { id: 'g', paid: 25 },
    });
    const outcome = reconcile(unlocked, [quest('a', { completed: false, credited: 25 })], {
      ...context,
      totalXp: 10_175,
    });

    expect(outcome.events).toEqual([
      { kind: 'quest_uncompleted', amount: -25, questId: 'a', gambleId: null },
      { kind: 'rank_bonus_revoked', amount: -9_125, questId: null, gambleId: null },
      { kind: 'gamble_reverted', amount: -25, questId: null, gambleId: 'g' },
    ]);
    expect(outcome).toMatchObject({
      status: 'active',
      relocked: true,
      unlock: null,
      gamble: { id: 'g', outcome: 'reverted', xpDelta: -25, lossReason: null },
      totalXp: 1_000,
    });
  });

  it('follows a size change of a completed quest with the difference [R-QST-07]', () => {
    const outcome = reconcile(
      achievement(),
      [quest('a', { completed: true, xp: 50, credited: 25 }), quest('b')],
      context,
    );

    expect(outcome.events).toEqual([{ kind: 'quest_completed', amount: 25, questId: 'a', gambleId: null }]);
    expect(
      reconcile(achievement(), [quest('a', { completed: true, xp: 10, credited: 25 }), quest('b')], context).events,
    ).toEqual([{ kind: 'quest_uncompleted', amount: -15, questId: 'a', gambleId: null }]);
  });

  it('never unlocks an achievement without required quests, nor a paused one [A-17, R-CHK-05]', () => {
    expect(
      reconcile(achievement(), [quest('bonus', { isRequired: false, completed: true })], context).unlock,
    ).toBeNull();
    expect(
      reconcile(achievement({ status: 'paused' }), [quest('a', { completed: true, credited: 25 })], context),
    ).toMatchObject({
      status: 'paused',
      unlock: null,
      events: [],
    });
  });
});

describe('pausing, deleting and the XP floor [R-ACH-06, R-ACH-09, R-QST-08, Q-12, R-XP-04, A-38]', () => {
  it('pause: loses the pending gamble, then revokes every quest’s XP of the attempt', () => {
    const facts = achievement({ pendingGamble: { id: 'g', stake: 150, targetDate: '2026-11-30' } });
    const outcome = pauseEffects(facts, [quest('a', { completed: true, credited: 25 }), quest('b')], context);

    expect(outcome.events).toEqual([
      { kind: 'gamble_lost', amount: -100, questId: null, gambleId: 'g' },
      { kind: 'pause_revoked', amount: -25, questId: 'a', gambleId: null },
    ]);
    expect(outcome).toMatchObject({
      status: 'paused',
      unlock: null,
      relocked: false,
      gamble: { outcome: 'lost', lossReason: 'paused' },
      totalXp: 875,
    });
  });

  it('deleting a quest revokes its XP; deleting the last open required quest unlocks the achievement', () => {
    const outcome = deleteQuestEffects(
      achievement(),
      [quest('a', { completed: true, credited: 25 }), quest('b', { credited: 0 })],
      'b',
      context,
    );

    expect(outcome.unlock).toEqual({ score: 100, rank: 'champion' });
    expect(outcome.events).toEqual([{ kind: 'rank_bonus', amount: 9_125, questId: null, gambleId: null }]);
    expect(
      deleteQuestEffects(achievement(), [quest('b'), quest('a', { completed: true, credited: 25 })], 'a', context)
        .events,
    ).toEqual([{ kind: 'quest_deleted', amount: -25, questId: 'a', gambleId: null }]);
  });

  it('deleting a quest keeps a pending gamble whose target date is still ahead', () => {
    const facts = achievement({ pendingGamble: { id: 'g', stake: 150, targetDate: '2026-11-30' } });
    const outcome = deleteQuestEffects(facts, [quest('a', { credited: 0 }), quest('b')], 'b', context);

    expect(outcome).toMatchObject({ gamble: null, events: [], relocked: false, status: 'active' });
  });

  it('deleting a quest loses a pending gamble when a habit reset is found in the same change', () => {
    const facts = achievement({ pendingGamble: { id: 'g', stake: 150, targetDate: '2026-11-30' } });
    const outcome = deleteQuestEffects(facts, [quest('a'), quest('b')], 'b', context, { habitReset: true });

    expect(outcome.gamble).toMatchObject({ id: 'g', outcome: 'lost', lossReason: 'habit_reset' });
    expect(outcome.events).toEqual([{ kind: 'gamble_lost', amount: -100, questId: null, gambleId: 'g' }]);
  });

  it('deleting an achievement loses its pending gamble and revokes all its XP', () => {
    const facts = achievement({ pendingGamble: { id: 'g', stake: 50, targetDate: '2026-11-30' } });
    const outcome = deleteAchievementEffects(
      facts,
      [quest('a', { completed: true, credited: 25 }), quest('b')],
      context,
    );

    expect(outcome.events).toEqual([
      { kind: 'gamble_lost', amount: -50, questId: null, gambleId: 'g' },
      { kind: 'achievement_deleted', amount: -25, questId: 'a', gambleId: null },
    ]);
    expect(outcome.gamble).toMatchObject({ outcome: 'lost', lossReason: 'deleted' });
    expect(outcome).toMatchObject({ status: 'active', unlock: null, relocked: false });
  });

  it('adds a floor adjustment when revoking would take the total below 0 — only after a lost gamble took that XP', () => {
    const outcome = deleteAchievementEffects(achievement(), [quest('a', { completed: true, credited: 100 })], {
      ...context,
      totalXp: 60,
    });

    expect(outcome.events).toEqual([
      { kind: 'achievement_deleted', amount: -100, questId: 'a', gambleId: null },
      { kind: 'xp_floor', amount: 40, questId: null, gambleId: null },
    ]);
    expect(outcome.totalXp).toBe(0);
  });
});

describe('properties [R-XP-01, R-ACH-05, T-16]', () => {
  const quests = fc.array(
    fc.record({
      isRequired: fc.boolean(),
      xp: fc.integer({ min: 1, max: 150 }),
      resetCount: fc.nat(2),
      completed: fc.boolean(),
    }),
    { minLength: 1, maxLength: 8 },
  );
  const toFacts = (raw: { isRequired: boolean; xp: number; resetCount: number; completed: boolean }[]) =>
    raw.map((q, index) => quest(`q${String(index)}`, q));

  it('is idempotent: reconciling an applied outcome again changes nothing', () => {
    fc.assert(
      fc.property(quests, fc.nat(5_000), (raw, totalXp) => {
        const first = reconcile(achievement(), toFacts(raw), { ...context, totalXp });
        const applied = apply(achievement(), toFacts(raw), first);
        const second = reconcile(applied.facts, applied.quests, { ...context, totalXp: applied.totalXp });

        expect(second.events).toEqual([]);
        expect(second.status).toBe(applied.facts.status);
      }),
    );
  });

  it('an undo is the exact inverse: completing and un-completing the same quest leaves XP and status unchanged', () => {
    fc.assert(
      fc.property(quests, fc.nat(), fc.integer({ min: 1_000, max: 5_000 }), (raw, pick, totalXp) => {
        const start = apply(
          achievement(),
          toFacts(raw),
          reconcile(achievement(), toFacts(raw), { ...context, totalXp }),
        );
        const index = pick % raw.length;
        const done = start.quests.map((q, i) => (i === index ? { ...q, completed: true } : q));
        const afterCheckIn = apply(
          start.facts,
          done,
          reconcile(start.facts, done, { ...context, totalXp: start.totalXp }),
        );
        const undone = afterCheckIn.quests.map((q, i) =>
          i === index ? { ...q, completed: start.quests[i]?.completed ?? false } : q,
        );
        const afterUndo = apply(
          afterCheckIn.facts,
          undone,
          reconcile(afterCheckIn.facts, undone, { ...context, totalXp: afterCheckIn.totalXp }),
        );

        expect(afterUndo.totalXp).toBe(start.totalXp);
        expect(afterUndo.facts.status).toBe(start.facts.status);
        expect(afterUndo.quests.map((q) => q.credited)).toEqual(start.quests.map((q) => q.credited));
      }),
    );
  });

  it('N pause and resume loops leave nothing behind: each attempt’s XP is revoked by its pause (T-16)', () => {
    fc.assert(
      fc.property(quests, fc.integer({ min: 1, max: 5 }), (raw, loops) => {
        let state = { facts: achievement(), quests: toFacts(raw), totalXp: 0 };
        // Everything but one required quest, so that no loop unlocks the achievement (an unlock ends the game).
        const keptOpen = state.quests.findIndex((q) => q.isRequired);
        for (let loop = 0; loop < loops; loop += 1) {
          const earning = state.quests.map((q, i) => ({ ...q, completed: i !== keptOpen }));
          const earned = apply(
            state.facts,
            earning,
            reconcile(state.facts, earning, { ...context, totalXp: state.totalXp }),
          );
          const paused = apply(
            earned.facts,
            earned.quests,
            pauseEffects(earned.facts, earned.quests, { ...context, totalXp: earned.totalXp }),
          );
          state = {
            facts: { ...paused.facts, status: 'active', attempt: paused.facts.attempt + 1 },
            quests: paused.quests.map((q) => ({ ...q, completed: false })),
            totalXp: paused.totalXp,
          };
        }

        expect(state.totalXp).toBe(0);
        expect(state.quests.every((q) => q.credited === 0)).toBe(true);
      }),
    );
  });

  it('never leaves the total below 0 [R-XP-04]', () => {
    fc.assert(
      fc.property(quests, fc.nat(200), (raw, totalXp) => {
        const credited = toFacts(raw).map((q) => ({ ...q, credited: q.xp }));

        expect(
          deleteAchievementEffects(achievement(), credited, { ...context, totalXp }).totalXp,
        ).toBeGreaterThanOrEqual(0);
        expect(pauseEffects(achievement(), credited, { ...context, totalXp }).totalXp).toBeGreaterThanOrEqual(0);
        expect(sum(deleteAchievementEffects(achievement(), credited, { ...context, totalXp }))).toBe(
          Math.max(-totalXp, -credited.reduce((total, q) => total + q.credited, 0)),
        );
      }),
    );
  });
});
