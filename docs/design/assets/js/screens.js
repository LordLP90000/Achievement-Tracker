/* Questline screens (pass 1: Today, Achievement detail), built only from QL.ui components.
   Each render function takes a frame context { state, revealed, view, snack, sheet, overlay, ids }
   and returns { body, overlay }. Elements with data-anno="n" get numbered annotation pins. */
window.QL = window.QL || {};

(function (QL) {
  const { ui, data, fmt } = QL;
  const { icon, esc } = ui;

  /* What Today lists (annotation 3):
     • Today’s quests — habits whose current period still needs check-ins (and habits waiting for a restart);
     • Up next — per active achievement, the first open one-time or target quest: no date, whenever you’re ready;
     • Done today — everything checked in today. */
  const todaySections = (achievements, today = data.TODAY) => {
    const due = [];
    const upNext = [];
    const done = [];
    achievements
      .filter((a) => a.status === 'active')
      .forEach((a) => {
        const nextTask = a.quests.find((q) => !q.bonus && q.state === 'available' && q.type !== 'habit');
        a.quests.forEach((q) => {
          const doneToday = !!q.doneToday || (q.state === 'completed' && q.completedOn === today);
          if (doneToday) done.push({ a, q, done: true });
          else if (q.type === 'habit' && q.state === 'available') {
            const met = q.habit.period === 'week' && q.habit.doneThisPeriod >= q.habit.times;
            if (!met) due.push({ a, q, done: false });
          } else if (q.state === 'needs_restart') due.push({ a, q, done: false });
          else if (nextTask && q.id === nextTask.id) upNext.push({ a, q, done: false });
        });
      });
    return { due, upNext, done };
  };

  const todayItems = (achievements) => {
    const s = todaySections(achievements);
    return [...s.due, ...s.upNext, ...s.done];
  };

  const greeting = (left, nickname, part = 'evening', doneToday = 1) => {
    const hello = nickname ? `Good ${part}, ${esc(nickname)}.` : `Good ${part}.`;
    if (left === 0) return `${hello} ${doneToday ? 'Nothing left for today.' : 'Nothing due today.'}`;
    return `${hello} ${left} quest${left === 1 ? '' : 's'} left for today.`;
  };

  const overlays = (ctx) => {
    const parts = [];
    if (ctx.sheet) {
      const [aid, qid] = ctx.sheet.split('/');
      const a = data.byId(aid, ctx.state.achievements);
      const q = a.quests.find((x) => x.id === qid);
      parts.push(`<div class="scrim" data-action="close-sheet"></div>${ui.checkInSheet({ q, a, docked: true })}`);
    }
    if (ctx.menu) {
      parts.push(`<div class="scrim scrim--clear" data-action="close-overlay"></div><div class="popover" style="position:absolute;top:100px;right:12px;z-index:9">${ui.menu(
        [
          { icon: 'pencil', label: 'Edit details' },
          { icon: 'eye-off', label: 'Make private' },
          { icon: 'pause', label: 'Pause…', action: 'pause' },
          '-',
          { icon: 'trash-2', label: 'Delete…', danger: true },
        ],
        { label: 'Achievement actions' },
      )}</div>`);
    }
    if (ctx.dialog === 'pause') {
      const a = data.byId(ctx.achievementId || 'exams', ctx.state.achievements);
      parts.push(`<div class="scrim" data-action="close-overlay"></div>${ui.confirm({
        platform: ctx.platform,
        iconName: 'pause',
        title: `Pause “${esc(a.title)}”?`,
        message: `When you resume, all ${a.quests.length} quests start again at 0 % and the ${fmt.num(a.xpEarned)} XP from this attempt is removed. Check-ins and notes stay in your history.`,
        action: 'Pause and start over',
      })}`);
    }
    if (ctx.snack) parts.push(ui.snackbar({ ...ctx.snack, floating: true, extra: { 'data-action': 'undo-last' } }));
    return parts.join('');
  };

  /* ───────── Today ───────── */
  const streakList = (achievements, revealed) => {
    const habits = achievements
      .filter((a) => a.status === 'active')
      .flatMap((a) => a.quests.filter((q) => q.type === 'habit' && q.streak && q.streak.current > 0).map((q) => ({ a, q })));
    return habits
      .map(({ a, q }) => {
        const isHidden = a.isPrivate && !revealed;
        const best = q.streak.best > q.streak.current ? `<span class="t-footnote c-tertiary tnum">Best ${ui.streakText({ ...q.streak, current: q.streak.best })}</span>` : '';
        return `<li class="streak-row">
          <span class="streak-row__icon" aria-hidden="true">${icon('flame')}</span>
          <div class="streak-row__body">
            <p class="t-headline tnum"><span class="sr-only">Streak: </span>${ui.streakText(q.streak)}</p>
            <p class="t-footnote c-secondary">${isHidden ? `${icon('eye-off', 'icon--sm')} Private habit` : `${esc(q.title)} · ${esc(a.title)}`}</p>
          </div>
          ${best}
        </li>`;
      })
      .join('');
  };

  const todayHeader = (ctx, sub) =>
    `${ctx.platform === 'android' ? '' : ui.createButton('ios', { anno: 10 })}<header class="screen-header" data-anno="1">
      <p class="screen-header__overline t-overline">${fmt.weekdayDate(ctx.dateIso || data.TODAY)}</p>
      <h1 class="screen-header__title t-large-title">Today</h1>
      <p class="screen-header__sub t-callout">${sub}</p>
    </header>`;

  /* States without the normal content: first launch, loading, error. */
  const todayState = (ctx) => {
    const { user } = ctx.state;
    const name = user.nickname;
    if (ctx.variant === 'empty') {
      return `${todayHeader(ctx, `Welcome, ${esc(name)}. Let’s set your first goal.`)}
        <div class="screen__content">
          <div style="margin-top:20px">${ui.levelCard({ ...user, level: 1, xp: 0, levelFloor: 0, nextLevelAt: 100 })}</div>
          <div class="card" style="margin-top:16px" data-anno="2">${ui.emptyState({
            title: 'Your quest log is empty',
            body: 'Start with one big goal. Questline helps you break it into small quests you can tick off.',
            actions:
              ui.button({ label: 'Create an achievement', size: 'lg', block: true, iconName: 'plus', extra: { 'data-action': 'create' } }) +
              ui.button({ label: 'Browse templates', variant: 'secondary', size: 'lg', block: true }),
          })}</div>
        </div>`;
    }
    if (ctx.variant === 'loading') {
      const skelRing = '<li class="card ring-tile" aria-hidden="true"><div class="skel" style="width:72px;height:72px;border-radius:50%"></div><div class="skel" style="height:12px;width:70%"></div></li>';
      return `${todayHeader(ctx, `Good evening, ${esc(name)}.`)}
        <div class="screen__content" aria-busy="true">
          <p class="sr-only" role="status">Loading today’s quests</p>
          <div class="card level-card" style="margin-top:20px" aria-hidden="true" data-anno="2"><div class="skel" style="width:52px;height:56px;border-radius:14px"></div><div class="stack" style="--gap:10px"><div class="skel" style="height:16px;width:40%"></div><div class="skel" style="height:12px"></div><div class="skel" style="height:12px;width:55%"></div></div></div>
          <section class="section"><div class="section__header"><h2 class="t-title-3">Today’s quests</h2></div>
            <div class="stack" style="--gap:12px">${ui.skeletonCard()}${ui.skeletonCard()}${ui.skeletonCard()}</div></section>
          <section class="section"><div class="section__header"><h2 class="t-title-3">Achievements</h2></div>
            <ul class="ring-grid">${skelRing}${skelRing}${skelRing}</ul></section>
        </div>`;
    }
    if (ctx.variant === 'error') {
      return `${todayHeader(ctx, `Good evening, ${esc(name)}.`)}
        <div class="screen__content">
          <div style="margin-top:20px" data-anno="2">${ui.notice({
            tone: 'error',
            iconName: 'cloud-off',
            title: 'Today didn’t load',
            body: 'Questline can’t reach its server right now. Nothing is lost: check-ins you make are saved on this phone and sync later.',
            actions: ui.button({ label: 'Try again', variant: 'secondary', size: 'sm', iconName: 'refresh-cw' }),
          })}</div>
          <p class="t-footnote c-tertiary" style="margin-top:12px;text-align:center">Still not working? See status and help in Profile → Help.</p>
        </div>`;
    }
    return '';
  };

  const today = (ctx) => {
    const { user, achievements } = ctx.state;
    const revealed = !!ctx.revealed;
    const id = ctx.ids;
    const tabbar = (ctx.platform === 'android' ? ui.createButton('android', { anno: 10 }) : '') + ui.tabBar('today', { label: `Main, ${ctx.label}`, anno: 9 });
    if (['empty', 'loading', 'error'].includes(ctx.variant)) {
      return { body: `<div class="screen">${todayState(ctx)}${tabbar}</div>`, overlay: overlays(ctx) };
    }

    const { due, upNext, done } = todaySections(achievements, ctx.dateIso || data.TODAY);
    const hidden = (i) => i.a.isPrivate && !revealed;
    const all = [...due, ...upNext, ...done];
    const hiddenItems = all.filter(hidden);
    const anyPrivate = all.some((i) => i.a.isPrivate);
    const open = due.length;

    const card = (i, n) =>
      `<div${n ? ` data-anno="${n}"` : ''}>${ui.questCard(i.q, i.a, { mode: 'today', justDone: ctx.justDone === `${i.a.id}/${i.q.id}`, justCompleted: ctx.justCompleted === `${i.a.id}/${i.q.id}` })}</div>`;
    const visibleDue = due.filter((i) => !hidden(i));
    const visibleNext = upNext.filter((i) => !hidden(i));
    const visibleDone = done.filter((i) => !hidden(i));

    const nothingDue =
      open === 0
        ? ui.notice({
            tone: 'done',
            iconName: 'circle-check',
            title: done.length ? 'Nothing left for today' : 'Nothing due today',
            body: done.length ? 'Every habit is checked in. Enjoy the rest of your day.' : 'Your habits are on track for this week. Enjoy the day — or pick something from Up next.',
          })
        : '';

    const offline = ctx.variant === 'offline' ? `<div style="margin-top:16px" data-anno="2">${ui.banner({ iconName: 'wifi-off', text: '<strong>You’re offline.</strong> Check-ins are saved on this phone and sync when you’re back online.' })}</div>` : '';

    const body = `
      <div class="screen">
        ${todayHeader(ctx, greeting(open, user.nickname, ctx.greet, done.length))}
        <div class="screen__content">
          ${offline}
          <div style="margin-top:20px"${offline ? '' : ' data-anno="2"'}>${ui.levelCard(user, { gain: ctx.xpGain || 0 })}</div>

          <section class="section" data-anno="3">
            <div class="section__header">
              <h2 class="t-title-3" id="${id}-q">Today’s quests</h2>
              ${
                revealed && anyPrivate
                  ? ui.button({ label: 'Hide private', variant: 'text', size: 'sm', iconName: 'eye-off', extra: { 'data-action': 'hide-private' } })
                  : due.length + done.length
                    ? `<span class="t-footnote c-secondary tnum">${done.length} of ${due.length + done.length} done</span>`
                    : ''
              }
            </div>
            <div class="stack" style="--gap:12px">
              ${nothingDue}
              ${visibleDue.map((i, n) => card(i, n === 0 ? 4 : 0)).join('')}
              ${hiddenItems.length ? `<div data-anno="5">${ui.privateGroupCard({ count: hiddenItems.length, doneCount: hiddenItems.filter((i) => i.done).length })}</div>` : ''}
            </div>
            ${
              visibleNext.length
                ? `<div class="section__header" style="margin:24px 0 12px"><h3 class="t-overline c-tertiary">Up next</h3><span class="t-footnote c-tertiary">Whenever you’re ready</span></div>
                   <div class="stack" style="--gap:12px">${visibleNext.map((i) => card(i, 0)).join('')}</div>`
                : ''
            }
            ${
              visibleDone.length
                ? `<h3 class="t-overline c-tertiary" style="margin:24px 0 12px">Done today</h3>
                   <div class="stack" style="--gap:12px">${visibleDone.map((i, n) => card(i, n === 0 ? 6 : 0)).join('')}</div>`
                : ''
            }
          </section>

          <section class="section">
            <div class="section__header">
              <h2 class="t-title-3" id="${id}-a">Achievements</h2>
              <a href="#" class="btn btn--text btn--sm" data-action="tab" data-tab="achievements">See all</a>
            </div>
            <ul class="ring-grid" data-anno="7">${achievements
              .filter((a) => a.status === 'active')
              .map((a) => ui.ringTile(a, { revealedPrivate: revealed }))
              .join('')}</ul>
          </section>

          <section class="section">
            <div class="section__header"><h2 class="t-title-3" id="${id}-s">Streaks</h2></div>
            <ul class="card card--flush streak-list" data-anno="8">${streakList(achievements, revealed)}</ul>
          </section>
        </div>
        ${tabbar}
      </div>`;

    return { body, overlay: overlays(ctx) };
  };

  /* ───────── Achievement detail ───────── */
  const detail = (ctx) => {
    const { achievements } = ctx.state;
    const a = data.byId(ctx.achievementId || 'exams', achievements);
    const cat = data.CATEGORIES[a.category];
    const view = ctx.view || 'path';
    const id = ctx.ids;
    const completed = a.status === 'completed';
    const paused = a.status === 'paused';
    const tabbar = ui.tabBar('achievements', { label: `Main, ${ctx.label}` });
    const bio = (ctx.platform || 'ios') === 'android' ? 'fingerprint' : 'Face ID';

    // Private achievement while App lock is on: nothing is shown until the user unlocks.
    if (a.isPrivate && ctx.privateLocked && !ctx.revealed) {
      const body = `<div class="screen">
        ${ui.navBar({ back: 'Achievements', anno: 1 })}
        <div class="screen__content">
          <header class="detail-head">
            ${ui.tag('Private', 'outline', 'lock')}
            <h1 class="t-brand-title" style="margin-top:12px">Private achievement</h1>
            <p class="t-callout c-secondary" style="margin-top:8px">Its title, quests and numbers stay hidden until you unlock them.</p>
          </header>
          <div class="card" style="margin-top:24px" data-anno="2">${ui.emptyState({
            iconName: 'scan-face',
            title: 'Unlock to show',
            body: `App lock is on, so private content needs ${bio === 'Face ID' ? 'Face ID' : 'your fingerprint'} or your PIN. It hides again when you leave this screen.`,
            actions: ui.button({ label: `Show with ${bio}`, size: 'lg', block: true, iconName: bio === 'Face ID' ? 'scan-face' : 'fingerprint', extra: { 'data-action': 'reveal' } }) + ui.button({ label: 'Use PIN', variant: 'secondary', size: 'lg', block: true }),
          })}</div>
          <div class="stack" style="--gap:12px;margin-top:24px" aria-hidden="true">
            <div class="qcard qcard--private"><span class="redact" style="--w:60%"></span></div>
            <div class="qcard qcard--private"><span class="redact" style="--w:75%"></span></div>
          </div>
        </div>${tabbar}</div>`;
      return { body, overlay: overlays(ctx) };
    }

    const q = completed || paused ? null : a.next;
    const checkedToday = q && q.type === 'habit' && q.doneToday;

    const nextCard = q
      ? `<div class="card card--accent next-card" role="group" aria-labelledby="${id}-n" data-anno="4">
          <p class="t-overline c-accent">Next quest</p>
          <h2 class="t-title-3" id="${id}-n" style="margin-top:4px">${esc(q.title)}</h2>
          <p class="next-card__meta t-footnote c-secondary">${icon(data.TYPE_ICON[q.type], 'icon--sm')}<span>${data.TYPE_LABEL[q.type]}${q.type === 'habit' ? ` · ${ui.habitScheduleText(q)}` : ''}</span></p>
          ${
            q.type === 'habit'
              ? `<div class="next-card__stats">
                  <span class="t-subhead tnum" style="font-weight:600">Week ${q.habit.periodIndex} of ${q.habit.count}</span>
                  <span class="t-subhead tnum c-secondary">${ui.habitProgressText(q)}</span>
                  ${q.streak && q.streak.current > 0 ? ui.streak(q.streak) : '<span class="t-subhead c-secondary">Streak starts this week</span>'}
                </div>
                <div style="margin-top:12px">${ui.weekStrip(q.week, { label: `${q.title}, this week` })}</div>`
              : ''
          }
          <div style="margin-top:16px">${
            checkedToday
              ? ui.button({ label: 'Checked in today', variant: 'secondary', size: 'lg', block: true, iconName: 'circle-check', extra: { 'data-action': 'undo', 'data-quest': `${a.id}/${q.id}` } })
              : ui.button({ label: q.type === 'target' ? 'Log progress' : 'Check in', variant: 'primary', size: 'lg', block: true, iconName: q.type === 'target' ? 'plus' : 'check', extra: { 'data-action': 'check', 'data-quest': `${a.id}/${q.id}` } })
          }</div>
        </div>`
      : '';

    const pausedCard = paused
      ? `<div style="margin-top:16px" data-anno="4">${ui.notice({
          iconName: 'pause',
          tone: 'error',
          title: `Paused since ${fmt.date(a.pausedOn || '2026-11-01')}`,
          body: 'When you resume, this achievement starts fresh from 0 %. Your earlier check-ins and notes stay in the history.',
          actions: ui.button({ label: 'Resume', size: 'sm', iconName: 'play' }),
        })}</div>`
      : '';

    const gambleCard =
      ctx.gamble === 'pending'
        ? `<div class="card gamble-card" data-anno="${ctx.gambleAnno || 4}"><span class="notice__icon" aria-hidden="true">${icon('dices')}</span><div class="notice__body">
            <p class="t-headline">Gamble running · <span class="tnum">${fmt.num(ctx.stake || 165)} XP</span></p>
            <p class="t-subhead c-secondary">Unlock this by ${fmt.date(a.targetDate)} to win <span class="tnum">${fmt.num(ctx.stake || 165)} XP</span>. Until then the target date stays fixed and quests can’t be made easier.</p></div></div>`
        : ctx.gamble === 'offer'
          ? `<div class="card gamble-card" data-anno="${ctx.gambleAnno || 4}"><span class="notice__icon" aria-hidden="true">${icon('dices')}</span><div class="notice__body">
              <p class="t-headline">Feeling sure?</p>
              <p class="t-subhead c-secondary">Stake the XP above your level on unlocking this by ${fmt.date(a.targetDate)}. Double or nothing.</p>
              <div class="notice__actions">${ui.button({ label: 'See the gamble', variant: 'secondary', size: 'sm', iconName: 'dices' })}</div></div></div>`
          : '';

    const dateLine = completed
      ? ''
      : `<p class="detail-head__meta t-footnote">${icon(ctx.gamble === 'pending' ? 'lock' : 'calendar', 'icon--sm')}<span class="tnum">${a.targetDate ? `Target ${fmt.date(a.targetDate)} · ${fmt.daysLeft(a.targetDate)}` : 'No target date'}${ctx.gamble === 'pending' ? ' · fixed while the gamble runs' : ''}</span></p>`;

    const badgeLine = completed
      ? `<div class="detail-badge">${ui.badge({ rank: a.rank, iconName: cat.icon, size: 72, caption: false, title: a.title })}<div><p class="t-headline">${ui.RANKS[a.rank]} · unlocked ${fmt.date(a.completedOn)}</p><p class="t-footnote c-secondary">${ui.RANK_REASON[a.rank]}</p></div></div>`
      : '';

    const progressCard = completed
      ? `<div class="card progress-card" role="group" aria-label="Result" data-anno="3">
          ${ui.ring({ p: 1, size: 'lg', variant: 'done', center: `<span class="c-done">${icon('check', 'icon--lg')}</span><span class="t-caption c-secondary">unlocked</span>`, label: `${a.title}: unlocked` })}
          <ul class="progress-card__stats">
            <li>${icon('circle-check', 'icon--md c-done')}<span><span class="t-headline tnum">${a.requiredDone} of ${a.requiredCount}</span><span class="t-footnote c-secondary"> quests done</span></span></li>
            <li>${icon('sparkle', 'icon--md c-accent')}<span><span class="t-headline tnum">${fmt.num(a.xpTotal)} XP</span><span class="t-footnote c-secondary"> from quests</span></span></li>
            <li>${icon('gem', 'icon--md c-accent')}<span><span class="t-headline tnum">+${fmt.num(a.rankBonus || 0)} XP</span><span class="t-footnote c-secondary"> rank bonus</span></span></li>
          </ul>
        </div>`
      : `<div class="card progress-card" role="group" aria-label="Progress" data-anno="3">
          ${ui.ring({ p: paused ? 0 : a.progress, size: 'lg', variant: paused ? 'paused' : '', center: paused ? `${icon('pause', 'icon--lg')}<span class="t-caption c-secondary">paused</span>` : `<span class="t-stat">${fmt.pct(a.progress)}</span><span class="t-caption c-secondary">complete</span>`, label: paused ? `${a.title}: paused` : `${a.title}: ${fmt.pct(a.progress)} complete` })}
          <ul class="progress-card__stats">
            <li>${icon('circle-check', 'icon--md c-done')}<span><span class="t-headline tnum">${a.requiredDone} of ${a.requiredCount}</span><span class="t-footnote c-secondary"> quests done</span></span></li>
            <li>${icon('sparkle', 'icon--md c-accent')}<span><span class="t-headline tnum">${fmt.num(a.xpEarned)} of ${fmt.num(a.xpTotal)}</span><span class="t-footnote c-secondary"> XP earned</span></span></li>
            <li>${icon('star', 'icon--md c-bonus')}<span><span class="t-headline tnum">${a.bonusDone} of ${a.bonusCount}</span><span class="t-footnote c-secondary"> bonus quest${a.bonusCount === 1 ? '' : 's'}</span></span></li>
          </ul>
        </div>`;

    const actions = completed
      ? ui.iconButton({ iconName: 'share', label: 'Create a share card' }) + ui.iconButton({ iconName: 'ellipsis', label: 'More actions' })
      : ui.iconButton({ iconName: 'pencil', label: 'Edit achievement' }) +
        ui.iconButton({ iconName: 'ellipsis', label: 'More actions', extra: { 'data-action': 'menu', 'aria-haspopup': 'menu', 'aria-expanded': String(!!ctx.menu) } });

    const body = `
      <div class="screen">
        ${ui.navBar({ back: 'Achievements', anno: 1, actions })}
        <div class="screen__content">
          <header class="detail-head" data-anno="2">
            <div class="row" style="--gap:6px;flex-wrap:wrap">${ui.tag(cat.label, 'outline', cat.icon)}${a.isPrivate ? ui.tag('Private', 'outline', 'lock') : ''}${completed ? ui.tag('Read-only', 'outline', 'archive') : ''}</div>
            <h1 class="t-brand-title" style="margin-top:12px">${esc(a.title)}</h1>
            ${a.why ? `<p class="detail-head__why"><span class="sr-only">Why it matters: </span>${esc(a.why)}</p>` : ''}
            ${dateLine}
            ${badgeLine}
          </header>
          ${gambleCard}
          ${pausedCard}
          <div style="margin-top:${gambleCard || pausedCard ? 16 : 24}px">${progressCard}</div>

          ${nextCard ? `<div style="margin-top:16px">${nextCard}</div>` : ''}

          <section class="section">
            <div class="section__header" style="align-items:center">
              <h2 class="t-title-3" id="${id}-qs">Quests</h2>
              <div data-anno="5">${ui.segmented({
                label: 'Quest view',
                selected: view,
                action: 'view',
                options: [
                  ['path', 'Path'],
                  ['list', 'List'],
                ],
              })}</div>
            </div>
            <div data-anno="6">${view === 'path' ? ui.questPath(a) : ui.questList(a)}</div>
            ${completed ? '' : `<div style="margin-top:24px" data-anno="7">${ui.button({ label: 'Add quest', variant: 'secondary', block: true, iconName: 'plus' })}</div>`}
          </section>
        </div>
        ${tabbar}
      </div>`;

    return { body, overlay: overlays(ctx) };
  };

  /* ───────── Interactions (simulate the server's effects; the app never computes XP itself) ───────── */
  const snapshot = (ctx) => JSON.stringify({ user: ctx.state.user, achievements: ctx.state.achievements.map(({ next, ...rest }) => rest) });

  const restore = (ctx, snap) => {
    const s = JSON.parse(snap);
    ctx.state = { user: s.user, achievements: data.derive(s.achievements) };
  };

  const findQuest = (ctx, key) => {
    const [aid, qid] = key.split('/');
    const a = data.byId(aid, ctx.state.achievements);
    return { a, q: a.quests.find((x) => x.id === qid) };
  };

  const completeQuest = (ctx, q) => {
    q.state = 'completed';
    q.completedOn = data.TODAY;
    q.completedAt = data.NOW_TIME;
    ctx.state.user.xp += q.xp;
    ctx.xpGain = q.xp;
    ctx.snack = { text: `Quest complete · <strong>+${q.xp} XP</strong>`, iconName: 'sparkles' };
  };

  /* A done check-in on a one-time or habit quest (one tap, or “Check in” in the sheet). */
  const applyCheckIn = (ctx, key) => {
    const { q } = findQuest(ctx, key);
    ctx.undo = snapshot(ctx);
    ctx.justDone = key;
    ctx.xpGain = 0;
    if (q.type === 'habit') {
      q.doneToday = true;
      q.doneAt = data.NOW_TIME;
      q.habit.doneThisPeriod += 1;
      const t = q.week.indexOf('today');
      if (t >= 0) q.week[t] = 'today-done';
      if (q.habit.period === 'day' || q.habit.doneThisPeriod >= q.habit.times) {
        q.streak.current += 1;
        q.progress = Math.min(1, q.progress + 1 / q.habit.count);
      }
      ctx.snack = { text: `Checked in · ${esc(q.title)}`, iconName: 'circle-check' };
    } else {
      completeQuest(ctx, q);
      ctx.justCompleted = key;
    }
    data.derive(ctx.state.achievements);
  };

  /* One tap: target quests need a value, so they open the check-in sheet instead. */
  const checkIn = (ctx, key) => {
    const { q } = findQuest(ctx, key);
    if (q.type === 'target') {
      ctx.sheet = key;
      return;
    }
    applyCheckIn(ctx, key);
  };

  const undo = (ctx) => {
    if (!ctx.undo) return;
    restore(ctx, ctx.undo);
    ctx.undo = null;
    ctx.justDone = null;
    ctx.xpGain = 0;
    ctx.snack = { text: 'Check-in undone', iconName: 'undo-2', action: '' };
  };

  /* Undo of a check-in made earlier today (before this session): reverse its effects. */
  const undoQuest = (ctx, key) => {
    const { q } = findQuest(ctx, key);
    ctx.undo = snapshot(ctx);
    ctx.justDone = null;
    ctx.xpGain = 0;
    if (q.type === 'habit' && q.doneToday) {
      const metBefore = q.habit.period === 'day' || q.habit.doneThisPeriod >= q.habit.times;
      q.doneToday = false;
      q.habit.doneThisPeriod = Math.max(0, q.habit.doneThisPeriod - 1);
      const t = q.week.indexOf('today-done');
      if (t >= 0) q.week[t] = 'today';
      if (metBefore) {
        q.streak.current = Math.max(0, q.streak.current - 1);
        q.progress = Math.max(0, q.progress - 1 / q.habit.count);
      }
    } else if (q.state === 'completed') {
      q.state = 'available';
      delete q.completedOn;
      delete q.completedAt;
      ctx.state.user.xp -= q.xp;
    }
    data.derive(ctx.state.achievements);
    ctx.snack = { text: `Check-in undone · ${esc(q.title)}`, iconName: 'undo-2', action: 'Redo' };
  };

  const confirmSheet = (ctx, key) => {
    const { q } = findQuest(ctx, key);
    ctx.sheet = null;
    if (q.type !== 'target') {
      applyCheckIn(ctx, key);
      return;
    }
    ctx.undo = snapshot(ctx);
    ctx.xpGain = 0;
    const t = q.target;
    const step = t.step ?? 1;
    const factor = 10 ** (t.digits ?? 0);
    t.current = Math.round((t.current + (t.goal > t.start ? step : -step)) * factor) / factor;
    t.lastOn = data.TODAY;
    q.progress = Math.max(0, Math.min(1, (t.current - t.start) / (t.goal - t.start)));
    if (q.progress >= 1) {
      completeQuest(ctx, q);
      ctx.justCompleted = key;
    }
    else ctx.snack = { text: `Saved · ${esc(q.title)}`, iconName: 'circle-check' };
    data.derive(ctx.state.achievements);
  };

  QL.screens = { today, detail, todayItems, todaySections };
  QL.actions = { checkIn, undo, undoQuest, confirmSheet };

  /* ───────── Developer annotations (pins on the frames) ───────── */
  QL.annotations = {
    today: [
      ['Header', 'Date in the account’s time zone (GET /me), formatted with the device locale. The greeting uses the optional nickname and the time of day; without a nickname it is just “Good evening.”'],
      ['Level & XP bar', 'Level, total XP and the next threshold come from the API (R-XP-03); never computed in the app. Bar = (XP − level threshold) ÷ (next threshold − level threshold). On XP gain the fill animates and “+10 XP” floats up; with Reduce Motion both crossfade. Screen reader: “Level 3 progress, 465 XP, 435 XP to level 4”.'],
      ['Which quests appear', '<em>Today’s quests</em>: habits whose current period still needs check-ins (a weekly habit drops off once its week is met) and habits waiting for a restart. <em>Up next</em>: per active achievement, the first open one-time or target quest — no date, “whenever you’re ready”, so nothing undated feels overdue. <em>Done today</em>: everything checked in today. The greeting counts only Today’s quests; with none open, a calm “Nothing due today” card takes their place.'],
      ['One-tap check-in', '44 pt circle, 48 pt hit area. One-time and habit quests check in with one tap (optimistic UI, Idempotency-Key, POST /quests/{id}/check-ins); target quests show “+” and open the check-in sheet for the value. Long-press (and the screen-reader action “Check in with a note”) opens the sheet for any type; tapping the card body opens Quest detail. Success: the circle fills and the tick draws in 160 ms with a light haptic — nothing more, because check-ins happen many times a day (HIG motion.md). Only completing a quest adds a small burst and the success haptic. A snackbar offers Undo. Offline: queued, the card shows “Waiting to sync”.'],
      ['Private quests', 'Quests of private achievements collapse into one row: no title, no achievement name, a fixed-length placeholder (never a blur of the real text, which would leak its length). “Show” reveals them in place; with app lock on it asks for Face ID / fingerprint first. They hide again when the user leaves the screen or the app goes to the background.'],
      ['Done today', 'Completed one-time quests and today’s habit check-ins. Tapping the filled circle undoes the check-in at once (all its effects reversed by the API) and the snackbar offers Redo. Undo is possible only until midnight in the account’s time zone (R-CHK-03, Q-36); after that the circle is static.'],
      ['Achievement rings', 'Up to three active achievements, most recently checked-in first; “See all” opens the Achievements tab. The ring shows server progress (XP-weighted, R-ACH-03). Private ones show only “Private · Tap to show”. At 150 %+ text the grid becomes a list.'],
      ['Streaks', 'One row per running habit (R-STR-01): days for daily habits, weeks for weekly ones; “Best …” appears only when an earlier run was longer. A private habit keeps its count but not its name. Missing a day is never shown here as a loss.'],
      ['Tab bar', 'Four destinations, icon + label each. iOS: the system tab bar floating on Liquid Glass, filled SF Symbols (sun.max.fill, flag.fill, chart.bar.fill, person.crop.circle.fill), the selected tab tinted and on a glass platter. Android: Material 3 NavigationBar, outlined icons with the selected one filled in a pill indicator and a bold label. Labels keep their size at large text; long-press shows them large (iOS Large Content Viewer, Android tooltip).'],
      ['New achievement', 'Creating is an action, not a place, so it is not a tab (HIG tab-bars.md › Best practices). iOS: a prominent glass “+” at the trailing end of the top bar on Today and Achievements (label “New achievement”); Android: an extended FAB “New achievement” 16 dp above the navigation bar that shrinks to an icon while scrolling. Both open the wizard as a full-screen modal.'],
    ],
    detail: [
      ['Navigation', 'Back to Achievements (iOS: chevron + title, Android: arrow). Edit opens the edit form; “More” opens: Edit details, Make private, Pause…, Delete…. There is no Archive: completed achievements are the archive (R-ACH-07, decided 05.11.2026).'],
      ['Header', 'Category, title (Fraunces — one of the few brand moments; everything else is the system font), the optional “why it matters” (hidden when empty) and the target date with days left. A passed date reads “Target date was 29.01.2027” — neutral, never red.'],
      ['Progress', 'Ring and counts from the API: progress is XP-weighted over required quests (R-ACH-03); bonus quests are counted separately because they never block unlocking.'],
      ['Next quest', 'The first available required quest by position. The screen’s one primary action: Check in (habit, one-time) or Log progress (target → sheet). After a check-in today the button turns into “Checked in today”; tapping it offers undo.'],
      ['Path / List', 'Segmented control with text only (HIG: text or icons, never both); the choice is remembered on the device. Both views list the same quests in the same order for screen readers.'],
      ['Quest path', 'Vertical journey map: the line is solid gold up to the current quest and dashed beyond. Nodes: done (green, tick), current (gold, larger, static halo — no looping animation), available (gold ring), locked (dashed, lock, “Unlocks after …”), bonus (violet star on a side branch: optional, never blocks unlocking). Every node opens Quest detail; a locked one explains what unlocks it.'],
      ['Add quest', 'Opens the Add quest sheet. Not shown for completed (read-only) achievements; at 50 quests the button explains the limit (R-IN-01).'],
    ],
  };
})(window.QL);
