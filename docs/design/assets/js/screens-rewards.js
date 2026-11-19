/* Pass 2 screens: celebrations, share card, stats, trophy room, gambles. Also the prototype’s story data. */
(function (QL) {
  const { ui, data, fmt } = QL;
  const { icon, esc, button, iconButton } = ui;
  const S = QL.screens;

  /* ───────── Story: “Run the Silvesterlauf”, created on 05.11.2026 and unlocked on race day, 13.12.2026 ─────────
     Required XP 10 + 25 + 25 + 50 = 110. Unlocked on the deadline, never paused, no habit reset, no gamble → score 100;
     the bonus quest stayed open, so Diamond rather than Champion (R-RANK-02): bonus round(110 × 120) = 13’200 XP,
     paid because the unlock comes 38 days after creation (A-34). Lena: 465 XP at creation, +10 shoes = 475; by race
     morning +25 runs +25 8 km +25 chapters +10 debt extract +25 flat visits = 585; +50 race = 635; +13’200 = 13’835
     → Level 6 (Level 6 starts at 8’100, Level 7 at 24’300). */
  const STORY = {
    createdOn: '2026-11-05',
    raceDay: '2026-12-13',
    xp: { created: 465, shoes: 475, raceMorning: 585, afterRace: 635, unlocked: 13835 },
    level: { from: 3, to: 6, toNext: 24300 - 13835 },
    bonus: 13200,
    days: 38,
  };

  const race = (phase = 'created') => {
    const a = {
      id: 'race',
      title: 'Run the Silvesterlauf',
      category: 'health',
      why: 'Run through the old town with my sister.',
      targetDate: STORY.raceDay,
      createdAt: STORY.createdOn,
      status: 'active',
      isPrivate: false,
      attempt: 1,
      quests: [
        { id: 'shoes', title: 'Buy running shoes', type: 'one_time', size: 'S', xp: 10, state: 'available' },
        {
          id: 'runs', title: 'Run 3× a week', type: 'habit', size: 'M', xp: 25, durationFactor: 1, state: 'available',
          habit: { times: 3, period: 'week', count: 4, start: STORY.createdOn, periodIndex: 1, doneThisPeriod: 0 },
          streak: { current: 0, best: 0, unit: 'week' }, progress: 0,
          week: ['off', 'off', 'off', 'today', 'upcoming', 'upcoming', 'upcoming'],
        },
        { id: 'eightk', title: 'Run 8 km without stopping', type: 'target', size: 'M', xp: 25, state: 'available', target: { start: 0, goal: 8, unit: 'km', current: 0, step: 0.5, digits: 1, lastOn: STORY.createdOn }, progress: 0 },
        { id: 'buddy', title: 'Find a running buddy', type: 'one_time', size: 'S', xp: 10, bonus: true, state: 'available' },
        { id: 'final', title: 'Run the Silvesterlauf', type: 'one_time', size: 'L', xp: 50, state: 'locked', after: 'eightk' },
      ],
    };
    const q = (id) => a.quests.find((x) => x.id === id);
    if (phase !== 'created') Object.assign(q('shoes'), { state: 'completed', completedOn: STORY.createdOn, completedAt: '18:44' });
    if (phase === 'raceday' || phase === 'unlocked') {
      Object.assign(q('runs'), { state: 'completed', completedOn: '2026-12-06', progress: 1, streak: { current: 4, best: 4, unit: 'week' }, habit: { ...q('runs').habit, periodIndex: 4, doneThisPeriod: 3 } });
      Object.assign(q('eightk'), { state: 'completed', completedOn: '2026-12-10', progress: 1, target: { ...q('eightk').target, current: 8, lastOn: '2026-12-10' } });
      Object.assign(q('final'), { state: 'available' });
    }
    if (phase === 'unlocked') {
      Object.assign(q('final'), { state: 'completed', completedOn: STORY.raceDay, completedAt: '13:20' });
      Object.assign(a, { status: 'completed', rank: 'diamond', completedOn: STORY.raceDay, rankBonus: STORY.bonus });
    }
    return a;
  };

  QL.story = { STORY, race };

  /* Frame state with the race achievement added to Lena’s achievements. */
  const withRace = (ctx, phase) => {
    if (!ctx.state.achievements.some((a) => a.id === 'race')) {
      ctx.state.achievements.push(race(phase));
      data.derive(ctx.state.achievements);
    }
    return data.byId('race', ctx.state.achievements);
  };

  /* ───────── Celebrations ───────── */
  S.celebrateQuest = (ctx) => {
    withRace(ctx, 'shoes');
    ctx.achievementId = 'race';
    const base = S.detail(ctx);
    const toast = `<div class="snackbar snackbar--floating snackbar--celebrate" role="status" aria-live="polite" data-anno="1">
        <span class="snackbar__burst" aria-hidden="true">${icon('sparkles')}</span>
        <p class="snackbar__text t-subhead"><strong>Quest complete · +10 XP</strong><br>Buy running shoes</p>
        <button type="button" class="snackbar__action">Undo</button>
      </div>`;
    return { body: base.body, overlay: toast };
  };

  S.unlockedScreen = (ctx) => {
    const a = withRace(ctx, 'raceday');
    ctx.achievementId = 'race';
    const base = S.detail(ctx);
    const done = { ...a, requiredCount: 4 };
    return { body: base.body, overlay: `<div data-anno="2">${ui.unlocked({ a: done, rank: 'diamond', questXp: 110, bonus: STORY.bonus, days: STORY.days, motion: !ctx.reduced })}</div>` };
  };

  S.levelUpScreen = (ctx) => {
    withRace(ctx, 'unlocked');
    ctx.achievementId = 'race';
    const base = S.detail(ctx);
    return { body: base.body, overlay: `<div data-anno="3">${ui.levelUp({ from: STORY.level.from, to: STORY.level.to, xp: STORY.xp.unlocked, toNext: STORY.level.toNext })}</div>` };
  };

  S.share = (ctx) => {
    const a = withRace(ctx, 'unlocked');
    const show = { title: true, badge: true, date: true, stats: false, why: false, name: false, ...(ctx.share || {}) };
    const done = { ...a, requiredCount: 4 };
    const rows = [
      ['title', 'Achievement title', ''],
      ['badge', 'Badge and rank', ''],
      ['date', 'Date', ''],
      ['stats', 'Quests and days', ''],
      ['why', 'Why it matters', 'Your personal line — off by default.'],
      ['name', 'My name', ''],
    ].map(([k, label, sub]) => ui.listRow({ kind: 'toggle', label, sub, on: show[k], action: `share-${k}` }));
    return {
      body: `<div class="screen">
        <div class="navbar">${iconButton({ iconName: 'x', label: 'Close', extra: { 'data-action': 'share-close' } })}<span class="navbar__title t-headline">Share card</span><span style="width:48px"></span></div>
        <div class="screen__content">
          <div style="margin-top:8px" data-anno="4">${ui.shareCard({ a: done, rank: 'diamond', show, days: STORY.days })}</div>
          <div style="margin-top:24px" data-anno="5">${ui.listGroup({ title: 'Show on the card', rows, footer: 'Private achievements start with the title hidden.' })}</div>
          <p class="t-footnote c-tertiary" style="margin-top:16px">${icon('smartphone', 'icon--sm')} The card is made on your phone. Nothing is uploaded — you choose where to send it.</p>
        </div>
        ${ui.footer(button({ label: 'Share…', size: 'lg', block: true, iconName: 'share', extra: { 'data-action': 'share-send' } }))}
      </div>`,
    };
  };

  /* ───────── Stats and trophy room ───────── */
  const statsTiles = () =>
    `<div class="tiles">
      <div class="tile"><span class="t-headline tnum">1</span><span class="t-footnote">achievement unlocked</span></div>
      <div class="tile"><span class="t-headline tnum">10</span><span class="t-footnote">quests done</span></div>
      <div class="tile"><span class="t-headline tnum">6 weeks</span><span class="t-footnote">best streak</span></div>
    </div>`;

  S.stats = (ctx) => {
    const { user, achievements } = ctx.state;
    const revealed = !!ctx.revealed;
    const name = (a, q) => (a.isPrivate && !revealed ? `${icon('eye-off', 'icon--sm')} Private habit` : `${esc(q.title)} · ${esc(a.title)}`);
    const streaks = [
      ['licence', 'parking', '6 weeks', 'Completed'],
      ['weight', 'steps', '12 days', 'Running'],
      ['exams', 'study', '3 weeks', 'Running'],
      ['weight', 'cook', '2 weeks', 'Running'],
    ].map(([aid, qid, len, status]) => {
      const a = data.byId(aid, achievements);
      const q = a.quests.find((x) => x.id === qid);
      return `<li class="streak-row"><span class="streak-row__icon" aria-hidden="true">${icon('flame')}</span><div class="streak-row__body"><p class="t-headline tnum">${len}</p><p class="t-footnote c-secondary">${name(a, q)}</p></div><span class="t-footnote c-tertiary">${status}</span></li>`;
    });
    const trophy = achievements
      .filter((a) => a.status !== 'paused')
      .map((a) => {
        const cat = data.CATEGORIES[a.category];
        if (a.status === 'completed') return `<li>${ui.badge({ rank: a.rank, iconName: cat.icon, size: 64, caption: false, title: a.title })}</li>`;
        return `<li>${ui.badge({ rank: 'unearned', iconName: a.isPrivate && !revealed ? 'lock' : cat.icon, size: 64, caption: false, title: a.isPrivate && !revealed ? 'Private achievement' : a.title })}</li>`;
      })
      .join('');
    return {
      body: `<div class="screen">
        ${ui.rootBar(ctx.platform)}<header class="screen-header"><h1 class="screen-header__title t-large-title">Stats</h1></header>
        <div class="screen__content">
          <div style="margin-top:20px">${ui.levelCard(user)}</div>
          <section class="section" data-anno="1">
            <div class="section__header" style="align-items:center"><h2 class="t-title-3">XP over time</h2>${ui.segmented({ label: 'Period', selected: 'year', options: [['weeks', '12 weeks'], ['year', '2026']] })}</div>
            <div class="card">
              <p class="t-subhead c-secondary"><span class="t-headline tnum" style="color:var(--text-primary)">465 XP</span> in 2026</p>
              <div style="margin-top:12px">${ui.barChart({ values: data.xpByMonth, title: 'XP by month in 2026', current: 10 })}</div>
              <div class="row" style="justify-content:space-between;margin-top:8px"><span class="t-footnote c-tertiary">June: Silver rank bonus for “Get my driving licence”</span>${button({ label: 'Table', variant: 'text', size: 'sm', iconName: 'list' })}</div>
            </div>
          </section>
          <section class="section" data-anno="2">${statsTiles()}</section>
          <section class="section" data-anno="3">
            <div class="section__header"><h2 class="t-title-3">Best streaks</h2></div>
            <ul class="card card--flush streak-list">${streaks.join('')}</ul>
          </section>
          <section class="section" data-anno="4">
            <div class="section__header"><h2 class="t-title-3">Trophy room</h2><a href="#" class="btn btn--text btn--sm" data-action="trophy">Open</a></div>
            <ul class="card badge-row">${trophy}</ul>
          </section>
          ${ctx.gambles ? `<section class="section"><div class="section__header"><h2 class="t-title-3">Gambles</h2></div><div class="card row" style="--gap:12px">${icon('dices', 'c-bonus')}<span class="t-subhead">0 won · 0 lost · none running</span></div></section>` : ''}
        </div>
        ${ui.tabBar('stats', { label: `Main, ${ctx.label}` })}
      </div>`,
    };
  };

  const RANK_TABLE = [
    ['unlocked', 'Unlocked', 'any score — every unlock earns a badge'],
    ['bronze', 'Bronze', '55 points or more'],
    ['silver', 'Silver', '65 or more'],
    ['gold', 'Gold', '75 or more'],
    ['platinum', 'Platinum', '85 or more'],
    ['emerald', 'Emerald', '92 or more'],
    ['diamond', 'Diamond', '100: on time, never restarted'],
    ['champion', 'Champion', '100, and every bonus quest too'],
  ];

  S.trophy = (ctx) => {
    const { achievements } = ctx.state;
    const revealed = !!ctx.revealed;
    const unlocked = achievements.filter((a) => a.status === 'completed');
    const open = achievements.filter((a) => a.status === 'active');
    return {
      body: `<div class="screen">
        ${ui.navBar({ back: 'Stats' })}
        <div class="screen__content">
          <h1 class="t-large-title" style="margin-top:4px">Trophy room</h1>
          <section class="section" data-anno="5">
            <div class="section__header"><h2 class="t-title-3">Unlocked <span class="c-tertiary tnum">(${unlocked.length})</span></h2></div>
            <ul class="acard-list">${unlocked.map((a) => ui.achievementCard(a)).join('')}</ul>
          </section>
          <section class="section">
            <div class="section__header"><h2 class="t-title-3">Still to earn <span class="c-tertiary tnum">(${open.length})</span></h2></div>
            <ul class="badge-grid card" style="padding:20px 8px">${open
              .map((a) => {
                const hidden = a.isPrivate && !revealed;
                return `<li style="text-align:center">${ui.badge({ rank: 'unearned', iconName: hidden ? 'lock' : data.CATEGORIES[a.category].icon, size: 64, caption: false, title: hidden ? 'Private achievement' : a.title })}<p class="t-footnote c-secondary" style="margin-top:6px">${hidden ? 'Private' : esc(a.title)}</p></li>`;
              })
              .join('')}</ul>
          </section>
          <section class="section" data-anno="6">
            <div class="section__header"><h2 class="t-title-3">How ranks work</h2></div>
            <p class="t-subhead c-secondary" style="margin-bottom:12px">When you unlock an achievement, its quests decide the rank: restarts and a late finish lower the score, nothing else. Better ranks pay a bigger XP bonus.</p>
            <ul class="lgroup__list">${RANK_TABLE.map(([r, n, d]) => `<li><div class="lrow">${ui.badge({ rank: r, iconName: 'trophy', size: 34, caption: false })}<span class="lrow__body"><span class="lrow__label t-callout" style="font-weight:600">${n}</span><span class="lrow__sub t-footnote">${d}</span></span></div></li>`).join('')}</ul>
          </section>
        </div>
        ${ui.tabBar('stats', { label: `Main, ${ctx.label}` })}
      </div>`,
    };
  };

  /* ───────── Gambles (opt-in) ───────── */
  const GAMBLE_RULES = [
    ['dices', 'XP only — no money, no purchases, no luck. You decide the outcome by finishing.'],
    ['layers', 'One gamble at a time, and it can’t be cancelled.'],
    ['lock', 'While it runs, the target date is fixed and quests can’t be made easier.'],
    ['shield-check', 'A loss never lowers your level.'],
    ['hourglass', 'No win for an achievement unlocked within 7 days of creating it.'],
  ];
  const rulesList = () => `<ul class="steps-list">${GAMBLE_RULES.map(([ic, t]) => `<li><span class="lrow__icon" aria-hidden="true">${icon(ic)}</span><span class="t-subhead">${t}</span></li>`).join('')}</ul>`;

  S.gambleSettings = (ctx) => {
    const sheet = ctx.confirm
      ? `<div class="scrim"></div><div class="sheet sheet--docked" role="dialog" aria-modal="true" aria-labelledby="${ctx.ids}-gs">
          <div class="sheet__grabber" aria-hidden="true"></div>
          <h2 class="t-title-3" id="${ctx.ids}-gs">Turn on XP gambles?</h2>
          <p class="t-callout c-secondary" style="margin:8px 0 16px">You can then stake the XP above your level on finishing an achievement by its target date: finish in time and it doubles, miss the date and it’s gone.</p>
          ${rulesList()}
          <div class="dialog__actions" data-anno="2">${button({ label: 'Turn on gambles', variant: 'secondary', size: 'lg', block: true })}${button({ label: 'Keep them off', variant: 'secondary', size: 'lg', block: true, extra: { 'data-autofocus': true } })}</div>
        </div>`
      : '';
    return {
      body: `<div class="screen">${ui.navBar({ back: 'Profile' })}<div class="screen__content">
        <h1 class="t-large-title" style="margin-top:4px">XP gambles</h1>
        <p class="t-callout c-secondary" style="margin-top:8px">Feeling sure about an achievement? Stake the XP above your current level on finishing it by its target date. Double or nothing.</p>
        <div style="margin-top:20px" data-anno="1">${ui.listGroup({ rows: [ui.listRow({ kind: 'toggle', iconName: 'dices', label: 'Allow gambles', sub: 'Off unless you turn it on.', on: false })] })}</div>
        <section class="section"><h2 class="t-title-3" style="margin-bottom:12px">The rules</h2>${rulesList()}</section>
      </div></div>`,
      overlay: sheet,
    };
  };

  S.gamblePlace = (ctx) => {
    ctx.achievementId = 'exams';
    const base = S.detail(ctx);
    const a = data.byId('exams', ctx.state.achievements);
    const sheet = `<div class="scrim"></div><div class="sheet sheet--docked" role="dialog" aria-modal="true" aria-labelledby="${ctx.ids}-gp">
      <div class="sheet__grabber" aria-hidden="true"></div>
      <div class="sheet__header"><h2 class="t-title-3" id="${ctx.ids}-gp">Gamble on “${esc(a.title)}”?</h2>${iconButton({ iconName: 'x', label: 'Close' })}</div>
      <div class="card card--muted row" style="--gap:12px" data-anno="3">${icon('dices', 'c-bonus')}<span class="t-subhead"><strong class="tnum">Stake: 165 XP</strong> — the XP above Level 3 (465 − 300)</span></div>
      <ul class="unlock__sum" style="margin-top:12px" data-anno="4">
        <li><span class="t-subhead">${icon('circle-check', 'icon--sm c-done')} Unlocked by ${fmt.date(a.targetDate)}</span><span class="t-headline tnum">+165 XP <span class="t-footnote c-secondary">→ 630</span></span></li>
        <li><span class="t-subhead">${icon('calendar', 'icon--sm')} Date passes first</span><span class="t-headline tnum">−165 XP <span class="t-footnote c-secondary">→ 300, still Level 3</span></span></li>
      </ul>
      <div style="margin-top:16px">${rulesList()}</div>
      <div class="dialog__actions" data-anno="5">${button({ label: 'Place gamble', variant: 'secondary', size: 'lg', block: true })}${button({ label: 'Not now', variant: 'secondary', size: 'lg', block: true })}</div>
    </div>`;
    return { body: base.body, overlay: sheet };
  };

  S.gambleLost = (ctx) => {
    const base = S.today({ ...ctx, dateIso: '2027-01-30', greet: 'morning' });
    const sheet = `<div class="scrim"></div><div class="sheet sheet--docked" role="dialog" aria-modal="true" aria-labelledby="${ctx.ids}-gl">
      <div class="sheet__grabber" aria-hidden="true"></div>
      <span class="notice__icon" style="margin-bottom:16px" aria-hidden="true">${icon('dices')}</span>
      <h2 class="t-title-3" id="${ctx.ids}-gl">Your gamble has ended</h2>
      <p class="t-callout c-secondary" style="margin-top:8px" data-anno="7">The target date of “Pass my final exams” passed yesterday before it was unlocked, so the 165 XP stake is gone. You’re still Level 3, and the achievement carries on exactly as it was.</p>
      <div class="dialog__actions">${button({ label: 'OK', variant: 'secondary', size: 'lg', block: true })}${button({ label: 'Open the achievement', variant: 'text', block: true })}</div>
    </div>`;
    return { body: base.body, overlay: sheet };
  };

  QL.annotations.celebrations = [
    ['Quest complete (small)', 'Inline and short: the check pops, a honey burst behind the sparkle, the node on the path fills, and a toast says “Quest complete · +10 XP” with Undo. Light haptic. Reduced motion: the toast fades in, nothing pops.'],
    ['Achievement unlocked (full screen)', 'After the last required quest: full-screen badge with the rank in words and why it was earned, quest XP and rank bonus listed separately (server values, R-CHK-06). Confetti in full motion; with Reduce Motion a soft fade and no particles. Continue is focused first; Share is optional.'],
    ['Level up (medium)', 'A centred card after the unlock when the level changed — here three levels at once, because the rank bonus is large. The emblem flips in; with Reduce Motion it fades.'],
    ['Share card', 'Built on the phone; nothing is uploaded. The preview updates as switches change.'],
    ['You choose what’s shown', 'Title, badge and date on by default; why-it-matters, numbers and name off. For a private achievement the title starts hidden (“A private achievement”) and needs an explicit switch.'],
  ];

  QL.annotations.stats = [
    ['XP over time', 'Bars per month from GET /stats (xp_by_day, summed on the phone); values labelled on the bars; “Table” switches to an accessible table. The June spike is explained in words.'],
    ['Totals', 'Three tiles that stack at large text.'],
    ['Best streaks', 'Longest streak per habit, including finished ones; private habits keep their number but not their name.'],
    ['Trophy room preview', 'Earned badges in colour, badges still to earn as dashed outlines; private ones show a lock.'],
    ['Unlocked', 'The archive with badge, rank and date; each opens the read-only achievement.'],
    ['How ranks work', 'Transparent and calm: the thresholds (R-RANK-02) in plain words, no “unranked” label, no pressure.'],
  ];

  QL.annotations.gambles = [
    ['Opt-in', 'Off by default (answer 4). Turning it on shows the rules and asks once, with two equal buttons; “Keep them off” has initial focus.'],
    ['Equal choices', 'No highlighted “yes”: gambles are a risk, so both buttons share one style.'],
    ['Stake', 'Computed by the server (R-GMB-01): the XP above the current level’s threshold, shown with the arithmetic.'],
    ['Both outcomes', 'Win and loss side by side with the resulting XP; the win is capped at the achievement’s XP and a loss never lowers the level (Q-31).'],
    ['Place or not', 'Both actions look the same. Placing shows a running-gamble card on the achievement and fixes its target date.'],
    ['Running', 'The card on the achievement says what is at stake and what is fixed while it runs (A-26, Q-47).'],
    ['Ended', 'A loss is reported once, factually, with no red and no “you lost”; the achievement carries on unchanged.'],
  ];
})(window.QL);
