/* Questline UI components as HTML-string renderers. Used by the design-system page, the screen boards
   and the prototype, so every screen is built from the same components. Accessibility is part of
   each component: roles, labels and values for screen readers, 48 pt hit areas, state shown by
   icon + text, never by colour alone. */
window.QL = window.QL || {};

(function (QL) {
  const { data, fmt } = QL;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let uid = 0;
  const nextId = (prefix = 'ql') => `${prefix}-${(uid += 1)}`;

  const icon = (name, cls = '') =>
    `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${QL.ICONS[name] || ''}</svg>`;

  const attrs = (obj = {}) =>
    Object.entries(obj)
      .filter(([, v]) => v !== undefined && v !== null && v !== false)
      .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`))
      .join('');

  const tag = (label, variant = '', iconName = '') =>
    `<span class="tag ${variant ? `tag--${variant}` : ''}">${iconName ? icon(iconName) : ''}${esc(label)}</span>`;

  const xpTag = (xp) => tag(`${fmt.num(xp)} XP`, 'xp', 'sparkle');

  const button = ({ label, variant = 'primary', size = '', iconName = '', iconEnd = '', block = false, state = '', extra = {} }) =>
    `<button type="button" class="btn btn--${variant} ${size ? `btn--${size}` : ''} ${block ? 'btn--block' : ''} ${state}"${attrs({
      disabled: state.includes('is-disabled') ? true : undefined,
      'aria-busy': state.includes('is-loading') ? 'true' : undefined,
      ...extra,
    })}>${iconName ? icon(iconName) : ''}<span>${esc(label)}</span>${iconEnd ? icon(iconEnd) : ''}</button>`;

  const iconButton = ({ iconName, label, variant = '', extra = {} }) =>
    `<button type="button" class="icon-btn ${variant ? `icon-btn--${variant}` : ''}"${attrs({ 'aria-label': label, ...extra })}>${icon(iconName)}</button>`;

  /* One-tap check-in, a toggle: the name stays “Check in: …”, the pressed state says whether it is done today.
     state: open | done | log (target quests open the check-in sheet). */
  const checkButton = ({ title, state = 'open', justDone = false, justCompleted = false, extra = {} }) => {
    const label = state === 'log' ? `Log progress: ${title}` : `Check in: ${title}`;
    const cls = { open: '', done: 'check--done', log: 'check--log' }[state];
    // A plain check-in only ticks; the small burst is reserved for completing a quest (HIG motion.md).
    const motion = justCompleted ? 'check--just-done check--just-completed' : justDone ? 'check--just-done' : '';
    return `<button type="button" class="check ${cls} ${motion}"${attrs({
      'aria-label': label,
      'aria-pressed': state === 'log' ? undefined : String(state === 'done'),
      ...extra,
    })}>${icon(state === 'log' ? 'plus' : 'check')}</button>`;
  };

  const ringGeometry = { sm: [44, 6], md: [72, 7], lg: [128, 10] };

  /* Progress ring. p in 0..1. The label is the screen-reader text for the whole ring. */
  const ring = ({ p = 0, size = 'md', center = '', label = '', variant = '' }) => {
    const [px, stroke] = ringGeometry[size];
    const r = (px - stroke) / 2;
    const c = 2 * Math.PI * r;
    const offset = c * (1 - Math.max(0, Math.min(1, p)));
    const showFill = variant !== 'private' && variant !== 'paused';
    const a11y = label ? ` role="img"${attrs({ 'aria-label': label })}` : ' aria-hidden="true"';
    return `<div class="ring ring--${size} ${variant ? `ring--${variant}` : ''}"${a11y}>
      <svg viewBox="0 0 ${px} ${px}" aria-hidden="true">
        <circle class="ring__track" cx="${px / 2}" cy="${px / 2}" r="${r}" stroke-width="${stroke}"></circle>
        ${showFill && p > 0 ? `<circle class="ring__fill" cx="${px / 2}" cy="${px / 2}" r="${r}" stroke-width="${stroke}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"></circle>` : ''}
      </svg>
      <span class="ring__center" aria-hidden="true">${center}</span>
    </div>`;
  };

  const bar = ({ p = 0, cls = '', label = '', min, max, now, valueText }) =>
    `<div class="bar ${cls}"${
      label
        ? attrs({ role: 'progressbar', 'aria-label': label, 'aria-valuemin': min ?? 0, 'aria-valuemax': max ?? 100, 'aria-valuenow': now ?? Math.round(p * 100), 'aria-valuetext': valueText })
        : ' aria-hidden="true"'
    }><div class="bar__fill" style="--p:${Math.max(0, Math.min(1, p)).toFixed(4)}"></div></div>`;

  /* Hexagon used by the level emblem, badges and the goal marker. viewBox 0 0 100 108. */
  const HEX = (r, cx = 50, cy = 54) =>
    [-90, -30, 30, 90, 150, 210]
      .map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return `${(cx + r * Math.cos(rad)).toFixed(2)},${(cy + r * Math.sin(rad)).toFixed(2)}`;
      })
      .join(' ');

  const levelEmblem = (level) =>
    `<div class="level-emblem" aria-hidden="true">
      <svg viewBox="0 0 100 108"><polygon class="level-emblem__shape" points="${HEX(47)}"></polygon><polygon class="level-emblem__inner" points="${HEX(38)}"></polygon></svg>
      <span class="level-emblem__num">${esc(level)}</span>
    </div>`;

  const levelCard = (user, { gain = 0, ids = nextId('lvl') } = {}) => {
    const inLevel = user.xp - user.levelFloor;
    const span = user.nextLevelAt - user.levelFloor;
    const toNext = user.nextLevelAt - user.xp;
    return `<div class="card level-card" role="group" aria-labelledby="${ids}-h">
      ${levelEmblem(user.level)}
      <div>
        <div class="level-card__row">
          <h2 class="t-headline" id="${ids}-h">Level ${esc(user.level)}</h2>
          <span class="t-subhead tnum c-secondary" style="position:relative">${fmt.num(user.xp)} XP${gain ? `<span class="xp-gain t-subhead" aria-hidden="true">+${gain} XP</span>` : ''}</span>
        </div>
        <div style="margin-top:8px">${bar({
          p: inLevel / span,
          cls: 'bar--xp',
          label: `Level ${user.level} progress`,
          min: user.levelFloor,
          max: user.nextLevelAt,
          now: user.xp,
          valueText: `${fmt.num(user.xp)} XP, ${fmt.num(toNext)} XP to level ${user.level + 1}`,
        })}</div>
        <p class="t-footnote level-card__hint">${fmt.num(toNext)} XP to Level ${esc(user.level + 1)}</p>
      </div>
    </div>`;
  };

  const DAY_SHORT = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAY_STATE_TEXT = {
    done: 'checked in',
    none: 'no check-in',
    missed: 'no check-in',
    today: 'today, not checked in yet',
    'today-done': 'today, checked in',
    upcoming: 'upcoming',
    off: 'before this habit started',
  };

  /* Week strip for habits. A past day without a check-in is neutral (hollow), never red. */
  const weekStrip = (week, { label = 'This week' } = {}) =>
    `<ol class="week" aria-label="${esc(label)}">${week
      .map(
        (state, i) => `<li class="week__day week__day--${state}">
          <span class="week__label t-caption" aria-hidden="true">${DAY_SHORT[i]}</span>
          <span class="week__dot" aria-hidden="true">${state === 'done' || state === 'today-done' ? icon('check') : ''}</span>
          <span class="sr-only">${DAY_LONG[i]}: ${DAY_STATE_TEXT[state]}</span>
        </li>`,
      )
      .join('')}</ol>`;

  const streakText = (s) => {
    const unit = s.unit === 'week' ? 'week' : 'day';
    return `${fmt.num(s.current)} ${unit}${s.current === 1 ? '' : 's'}`;
  };

  const streak = (s, { size = '' } = {}) =>
    `<span class="streak ${size ? `streak--${size}` : ''}">${icon('flame', 'icon--sm')}<span><span class="sr-only">Streak: </span>${streakText(s)}</span></span>`;

  /* "3 of 5 this week" / "Day 12 of 30" / "7 of 12 chapters" */
  const habitProgressText = (q) =>
    q.habit.period === 'week'
      ? `${q.habit.doneThisPeriod} of ${q.habit.times} this week`
      : q.habit.times > 1
        ? `${q.habit.doneThisPeriod} of ${q.habit.times} today`
        : `Day ${q.habit.periodIndex} of ${q.habit.count}`;

  const habitScheduleText = (q) =>
    q.habit.period === 'week'
      ? `${q.habit.times}× a week for ${q.habit.count} weeks`
      : q.habit.times > 1
        ? `${q.habit.times}× a day for ${q.habit.count} days`
        : `Every day for ${q.habit.count} days`;

  const targetValue = (q, v) => {
    const t = q.target;
    const n = fmt.num(v, t.digits ?? 0);
    return t.unit === 'CHF' ? `CHF ${n}` : `${n} ${t.unit}`;
  };

  const trendText = (t) => (t.trend === 'down' ? 'Trending down' : 'Trending up');

  const targetProgressText = (q, { hideNumbers = false } = {}) => {
    const t = q.target;
    if (hideNumbers) return trendText(t);
    if (t.unit === 'CHF') return `CHF ${fmt.num(t.current)} of ${fmt.num(t.goal)}`;
    if (t.start === 0) return `${fmt.num(t.current, t.digits ?? 0)} of ${fmt.num(t.goal)} ${t.unit}`;
    return `${targetValue(q, t.current)} · goal ${targetValue(q, t.goal)}`;
  };

  /* Meta line of a quest card: type, the type-specific progress and the streak. */
  const questMeta = (q, { hideNumbers = false, showXp = false } = {}) => {
    const parts = [`<span>${icon(data.TYPE_ICON[q.type])}${data.TYPE_LABEL[q.type]}</span>`];
    if (q.type === 'habit') {
      parts.push(`<span class="tnum">${habitProgressText(q)}</span>`);
      if (q.streak && q.streak.current > 0) parts.push(streak(q.streak));
    } else if (q.type === 'target' && q.state !== 'locked') {
      parts.push(
        hideNumbers
          ? `<span>${icon(q.target.trend === 'down' ? 'trending-down' : 'trending-up')}${trendText(q.target)}</span><span>${icon('eye-off')}Numbers hidden</span>`
          : `<span class="tnum">${targetProgressText(q)}</span>`,
      );
    }
    if (showXp || q.type === 'one_time') parts.push(`<span class="tnum">${fmt.num(q.xp)} XP</span>`);
    return parts.join('');
  };

  /* Quest card for Today and the list view. */
  const questCard = (q, a, { mode = 'today', revealedPrivate = true, justDone = false, justCompleted = false, ids = nextId('qc') } = {}) => {
    const cat = data.CATEGORIES[a.category];
    const hideNumbers = !!a.hideNumbers;
    const doneToday = q.doneToday || (q.state === 'completed' && q.completedOn === data.TODAY);
    let variant = 'available';
    if (q.state === 'locked') variant = 'locked';
    else if (q.state === 'needs_restart') variant = 'restart';
    else if (q.state === 'completed') variant = doneToday ? 'done-today' : 'completed';
    else if (doneToday) variant = 'done-today';
    else if (a.status === 'paused') variant = 'paused';
    if (q.bonus && variant === 'available') variant = 'bonus';

    const leadIcon =
      variant === 'locked'
        ? 'lock'
        : variant === 'done-today' || variant === 'completed'
          ? 'check'
          : variant === 'restart'
            ? 'rotate-ccw'
            : variant === 'paused'
              ? 'pause'
              : q.bonus
                ? 'star'
                : data.TYPE_ICON[q.type];

    let meta = questMeta(q, { hideNumbers });
    if (variant === 'done-today') {
      const when = q.type === 'habit' ? `Done today, ${q.doneAt}` : `Done at ${q.completedAt}`;
      meta = `<span class="c-done">${icon('circle-check')}${when}</span>${q.type === 'one_time' ? `<span class="tnum">+${fmt.num(q.xp)} XP</span>` : ''}${q.type === 'habit' ? streak(q.streak) : ''}`;
    } else if (variant === 'completed') {
      meta = `<span class="c-done">${icon('circle-check')}Done ${fmt.date(q.completedOn)}</span><span class="tnum">${fmt.num(q.xp)} XP</span>`;
    } else if (variant === 'locked') {
      const pre = a.quests.find((x) => x.id === q.after);
      meta = `<span>${icon('lock')}Unlocks after “${esc(pre ? pre.title : 'the previous quest')}”</span>`;
    } else if (variant === 'restart') {
      meta = `<span>${icon('info')}Run ended on ${fmt.dayMonth(q.endedOn || '2026-11-02')} Your history is kept.</span>`;
    } else if (variant === 'paused') {
      meta = `<span>${icon('pause')}Achievement paused</span>`;
    }
    if (q.syncing) meta += `<span>${icon('cloud-upload')}Waiting to sync</span>`;

    const bonusTag = q.bonus ? tag('Bonus', 'bonus', 'star') : '';

    let action = '';
    if (mode !== 'path') {
      if (variant === 'available' || variant === 'bonus') action = checkButton({ title: q.title, state: q.type === 'target' ? 'log' : 'open', extra: { 'data-action': 'check', 'data-quest': `${a.id}/${q.id}` } });
      else if (variant === 'done-today') action = checkButton({ title: q.title, state: 'done', justDone, justCompleted, extra: { 'data-action': 'undo', 'data-quest': `${a.id}/${q.id}` } });
      else if (variant === 'restart') action = button({ label: 'Restart', variant: 'secondary', size: 'sm' });
      else if (mode === 'list') action = `<span class="c-tertiary" aria-hidden="true">${icon('chevron-right')}</span>`;
    }

    const context =
      mode === 'today'
        ? `<p class="qcard__context t-footnote">${icon(cat.icon)}<span>${esc(a.title)}</span></p>`
        : '';

    return `<article class="qcard qcard--${variant}" aria-labelledby="${ids}-t">
      <div class="qcard__lead" aria-hidden="true">${icon(leadIcon)}</div>
      <div class="qcard__body">
        ${context}
        <h3 class="qcard__title t-headline" id="${ids}-t">${esc(q.title)}</h3>
        ${bonusTag ? `<div style="margin-top:4px">${bonusTag}</div>` : ''}
        <p class="qcard__meta t-footnote">${meta}</p>
      </div>
      <div class="qcard__action">${action}</div>
    </article>`;
  };

  /* Today: quests of private achievements collapse into one row until the user reveals them. */
  const privateGroupCard = ({ count, doneCount, ids = nextId('pg') }) =>
    `<article class="qcard qcard--private" aria-labelledby="${ids}-t">
      <div class="qcard__lead" aria-hidden="true">${icon('eye-off')}</div>
      <div class="qcard__body">
        <p class="qcard__context t-footnote">${icon('lock')}<span>Private achievement</span></p>
        <h3 class="qcard__title t-headline" id="${ids}-t">${count} private quests</h3>
        <p class="qcard__meta t-footnote"><span class="tnum">${doneCount} done today</span><span aria-hidden="true"><span class="redact" style="--w:5.5em"></span></span></p>
      </div>
      <div class="qcard__action">${button({ label: 'Show', variant: 'secondary', size: 'sm', iconName: 'eye', extra: { 'data-action': 'reveal', 'aria-label': 'Show private quests' } })}</div>
    </article>`;

  const ringTile = (a, { revealedPrivate = true } = {}) => {
    const cat = data.CATEGORIES[a.category];
    if (a.isPrivate && !revealedPrivate) {
      return `<li><button type="button" class="card ring-tile" data-action="reveal">
        ${ring({ p: 0, variant: 'private', center: icon('eye-off') })}
        <span><span class="ring-tile__title t-subhead" style="font-weight:700;display:block">Private<span class="sr-only"> achievement, hidden.</span></span>
        <span class="ring-tile__meta t-footnote">Tap to show</span></span>
      </button></li>`;
    }
    const pct = fmt.pct(a.progress);
    return `<li><a class="card ring-tile" href="#" data-action="open-achievement" data-achievement="${a.id}" style="color:inherit;text-decoration:none">
      ${ring({ p: a.progress, center: icon(cat.icon), label: `${a.title}: ${pct} complete, ${fmt.daysLeft(a.targetDate)}` })}
      <span><span class="ring-tile__title t-subhead" style="font-weight:700;display:block">${esc(a.title)}</span>
      <span class="ring-tile__meta t-footnote tnum" aria-hidden="true">${pct}${a.isPrivate ? ` · ${icon('lock', 'icon--sm')}` : ''}</span></span>
    </a></li>`;
  };

  /* ───────── Badge (rank of an unlocked achievement) ───────── */
  const RANKS = {
    unlocked: 'Unlocked',
    bronze: 'Bronze',
    silver: 'Silver',
    gold: 'Gold',
    platinum: 'Platinum',
    emerald: 'Emerald',
    diamond: 'Diamond',
    champion: 'Champion',
  };

  const badge = ({ rank = 'gold', iconName = 'trophy', size = 88, caption = true, title = '' }) => {
    const id = nextId('bdg');
    const name = RANKS[rank] || 'Not earned yet';
    const unearned = rank === 'unearned';
    const label = unearned ? `Badge not earned yet${title ? `: ${title}` : ''}` : `${name} badge${title ? `: ${title}` : ''}`;
    const crown =
      rank === 'champion'
        ? `<g transform="translate(36 -2)"><path d="M14 2 l3.6 7.4 8.1 1.2 -5.9 5.7 1.4 8 -7.2 -3.8 -7.2 3.8 1.4 -8 -5.9 -5.7 8.1 -1.2z" fill="var(--rank-champion-from)" stroke="var(--rank-champion-to)" stroke-width="1.5" stroke-linejoin="round"/></g>`
        : '';
    return `<div class="badge ${unearned ? 'badge--unearned' : ''}" role="img" aria-label="${esc(label)}" style="--badge:${size}px">
      <div class="badge__art" aria-hidden="true">
        <svg viewBox="0 -4 100 116">
          ${unearned ? '' : `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--rank-${rank}-from)"/><stop offset="1" stop-color="var(--rank-${rank}-to)"/></linearGradient></defs>`}
          <polygon class="badge__outer" points="${HEX(46)}" ${unearned ? '' : `fill="url(#${id})" stroke="url(#${id})" stroke-width="8" stroke-linejoin="round"`}></polygon>
          ${unearned ? '' : `<polygon class="badge__inner" points="${HEX(35)}" stroke="var(--bg-surface)" stroke-width="6" stroke-linejoin="round"></polygon><polygon class="badge__line" points="${HEX(29)}" stroke="var(--rank-${rank}-to)" stroke-linejoin="round"></polygon>`}
          ${crown}
        </svg>
        <span class="badge__glyph" style="--badge-ink: var(--rank-${rank}-to)">${icon(iconName)}</span>
      </div>
      ${caption ? `<div class="badge__caption">${unearned ? tag('Not earned yet', 'locked', 'lock') : tag(name, rank === 'champion' ? 'bonus' : 'outline', rank === 'champion' ? 'crown' : '')}</div>` : ''}
    </div>`;
  };

  /* ───────── Quest path ───────── */
  const nodeFor = (q, a) => {
    // Nothing is “current” while an achievement is paused: no check-in counts until it is resumed.
    const isCurrent = a.status === 'active' && a.next && a.next.id === q.id;
    if (q.bonus) {
      if (q.state === 'completed') return ['bonus-done', 'check', 'Bonus quest, done'];
      if (q.state === 'locked') return ['locked', 'lock', 'Bonus quest, locked'];
      return ['bonus', 'star', 'Bonus quest, optional'];
    }
    if (q.state === 'completed') return ['done', 'check', 'Done'];
    if (q.state === 'locked') return ['locked', 'lock', 'Locked'];
    if (q.state === 'needs_restart') return ['restart', 'rotate-ccw', 'Needs a restart'];
    if (isCurrent) return ['current', data.TYPE_ICON[q.type], 'Current quest'];
    return ['available', data.TYPE_ICON[q.type], 'Available'];
  };

  const pathCard = (q, a, kind) => {
    const pre = q.after ? a.quests.find((x) => x.id === q.after) : null;
    const hideNumbers = !!a.hideNumbers;
    let state = '';
    if (kind === 'done' || kind === 'bonus-done') {
      const when = q.completedOn === data.TODAY ? `Done today, ${q.completedAt}` : `Done ${fmt.date(q.completedOn)}`;
      state = tag(when, 'done', 'check');
    } else if (kind === 'locked') {
      state = `<span class="t-footnote c-secondary" style="display:inline-flex;gap:4px;align-items:center">${icon('lock', 'icon--sm')}Unlocks after “${esc(pre ? pre.title : '')}”</span>`;
    } else if (kind === 'current' || kind === 'available') {
      const lead = kind === 'current' ? tag('Current', 'active', 'map-pin') : '';
      let progress = '';
      if (q.type === 'habit') {
        progress = `<div class="qpath__progress">${bar({ p: q.progress, cls: 'bar--sm', label: `${q.title} progress`, valueText: `Week ${q.habit.periodIndex} of ${q.habit.count}, ${fmt.pct(q.progress)}` })}<span class="t-footnote tnum c-secondary">Week ${q.habit.periodIndex} of ${q.habit.count}</span></div>`;
      } else if (q.type === 'target') {
        progress = `<div class="qpath__progress">${bar({ p: q.progress, cls: 'bar--sm', label: `${q.title} progress`, valueText: hideNumbers ? fmt.pct(q.progress) : targetProgressText(q) })}<span class="t-footnote tnum c-secondary">${hideNumbers ? fmt.pct(q.progress) : targetProgressText(q)}</span></div>`;
      }
      state = lead ? `${lead}` : '';
      return `<div class="qpath__card">
        <h3 class="qpath__title t-headline">${esc(q.title)}</h3>
        <p class="qpath__meta t-footnote"><span>${icon(data.TYPE_ICON[q.type])}${data.TYPE_LABEL[q.type]}</span>${q.type === 'habit' ? `<span>${habitScheduleText(q)}</span>` : ''}</p>
        <div class="qpath__state">${state}${xpTag(q.xp)}</div>
        ${progress}
      </div>`;
    } else if (kind === 'bonus') {
      state = `<span class="t-footnote c-secondary">Optional · never blocks unlocking</span>`;
    }
    return `<div class="qpath__card">
      <h3 class="qpath__title t-headline">${esc(q.title)}</h3>
      <p class="qpath__meta t-footnote"><span>${icon(data.TYPE_ICON[q.type])}${data.TYPE_LABEL[q.type]}</span>${q.bonus ? `<span class="c-bonus" style="font-weight:700">${icon('star')}Bonus</span>` : ''}</p>
      <div class="qpath__state">${state}${xpTag(q.xp)}</div>
    </div>`;
  };

  const questPath = (a) => {
    const walked = (q) => q && (q.state === 'completed' || (a.next && a.next.id === q.id));
    const main = a.quests.filter((q) => !q.bonus);
    const items = [];
    const firstMain = main[0];
    items.push(`<li class="qpath__item is-first ${walked(firstMain) ? 'seg-bottom-done' : ''}">
      <div class="qpath__node-slot"><span class="pnode pnode--start" aria-hidden="true"></span></div>
      <div class="qpath__card qpath__card--plain t-footnote c-secondary" style="display:flex;gap:6px;align-items:center">${icon('flag', 'icon--sm')}Started ${fmt.date(a.createdAt)}</div>
    </li>`);

    a.quests.forEach((q) => {
      const [kind, iconName, srState] = nodeFor(q, a);
      const mainIndex = main.indexOf(q);
      if (q.bonus) {
        const nextMain = main.find((m) => a.quests.indexOf(m) > a.quests.indexOf(q));
        const seg = walked(nextMain) ? 'seg-top-done seg-bottom-done' : '';
        items.push(`<li class="qpath__item qpath__item--side qpath__item--${kind} ${seg}">
          <span class="qpath__branch" aria-hidden="true"></span>
          <div aria-hidden="true"></div>
          <div class="qpath__side">
            <div class="qpath__node-slot"><span class="pnode pnode--${kind}" aria-hidden="true">${icon(iconName)}</span></div>
            <a class="qpath__link" href="#" data-action="open-quest" style="color:inherit;text-decoration:none"><span class="sr-only">${srState}: </span>${pathCard(q, a, kind)}</a>
          </div>
        </li>`);
        return;
      }
      const next = main[mainIndex + 1];
      const segTop = walked(q) ? 'seg-top-done' : '';
      const segBottom = walked(next) ? 'seg-bottom-done' : '';
      items.push(`<li class="qpath__item qpath__item--${kind} ${segTop} ${segBottom}" ${kind === 'current' ? 'aria-current="step"' : ''}>
        <div class="qpath__node-slot"><span class="pnode pnode--${kind}" aria-hidden="true">${icon(iconName)}</span></div>
        <a class="qpath__link" href="#" data-action="open-quest" style="color:inherit;text-decoration:none"><span class="sr-only">${srState}: </span>${pathCard(q, a, kind)}</a>
      </li>`);
    });

    const unlocked = a.status === 'completed';
    items.push(`<li class="qpath__item is-last ${unlocked ? 'seg-top-done' : ''}">
      <div class="qpath__node-slot"><span class="pnode pnode--goal${unlocked ? ' pnode--goal-done' : ''}" aria-hidden="true"><svg class="goal-shape" viewBox="0 0 100 108"><path d="M${HEX(46).split(' ').join(' L')} Z"/></svg>${icon('trophy', 'icon--md')}</span></div>
      <div class="qpath__card qpath__card--plain">
        ${
          unlocked
            ? `<h3 class="t-headline">Unlocked ${fmt.date(a.completedOn)}</h3><p class="t-footnote c-secondary" style="margin-top:2px">${RANKS[a.rank] || 'Unlocked'} badge earned.</p>`
            : `<h3 class="t-headline">Unlock “${esc(a.title)}”</h3><p class="t-footnote c-secondary" style="margin-top:2px">Finish all ${a.requiredCount} quests to earn its badge.</p>`
        }
      </div>
    </li>`);

    return `<ol class="qpath" aria-label="Quest path">${items.join('')}</ol>`;
  };

  const questList = (a) => {
    const groups = [
      ['In progress', a.quests.filter((q) => !q.bonus && (q.state === 'available' || q.state === 'needs_restart'))],
      ['Bonus', a.quests.filter((q) => q.bonus)],
      ['Locked', a.quests.filter((q) => !q.bonus && q.state === 'locked')],
      ['Done', a.quests.filter((q) => !q.bonus && q.state === 'completed')],
    ].filter(([, qs]) => qs.length);
    return groups
      .map(
        ([title, qs]) => `<section class="stack" style="--gap:8px;margin-top:20px" aria-label="${title}">
          <h3 class="t-overline c-tertiary">${title} <span class="tnum">(${qs.length})</span></h3>
          ${qs.map((q) => questCard(q, a, { mode: 'list' })).join('')}
        </section>`,
      )
      .join('');
  };

  /* ───────── Navigation chrome ───────── */
  const statusBar = (platform = 'ios', time = data.NOW_TIME) =>
    `<div class="statusbar" aria-hidden="true">
      <span>${time}</span>
      <span class="statusbar__island"></span>
      <span class="statusbar__icons">
        <svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
        <svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 11.5 5.6 9.1a3.4 3.4 0 0 1 4.8 0zM3.5 7a6.4 6.4 0 0 1 9 0l1.5-1.5a8.5 8.5 0 0 0-12 0zM.7 4.2a10.4 10.4 0 0 1 14.6 0L16 3.5A11.4 11.4 0 0 0 0 3.5z"/></svg>
        ${
          platform === 'android'
            ? '<svg width="10" height="16" viewBox="0 0 10 16"><rect x="2.5" y="0" width="5" height="2" rx=".5"/><rect x="0" y="1.5" width="10" height="14.5" rx="2"/></svg>'
            : '<svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" opacity=".4"/><rect x="2.5" y="2.5" width="17" height="8" rx="2"/><rect x="25" y="4.5" width="1.6" height="4" rx=".8" opacity=".4"/></svg>'
        }
      </span>
    </div>`;

  /* Tab icons are drawn so their shapes can fill: iOS shows filled symbols (SF Symbols .fill in the app), Android
     fills only the selected one (Material). Paths from Lucide (ISC). */
  const TAB_ICONS = {
    today: '<circle class="f" cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    achievements: '<path class="f" d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/>',
    stats: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><rect class="f" x="15" y="5" width="4" height="12" rx="1"/><rect class="f" x="7" y="8" width="4" height="9" rx="1"/>',
    profile: '<circle class="f" cx="12" cy="8" r="5"/><path class="f" d="M20 21a8 8 0 0 0-16 0"/>',
  };

  /* Four destinations only. Creating is an action, so it isn't a tab (HIG tab-bars.md): iOS puts “+” in the top
     bar of Today and Achievements, Android a “New achievement” floating action button. */
  const TABS = [
    ['today', 'Today'],
    ['achievements', 'Achievements'],
    ['stats', 'Stats'],
    ['profile', 'Profile'],
  ];

  const tabBar = (active, { label = 'Main', labels = {}, anno = '' } = {}) =>
    `<nav class="tabbar glass" aria-label="${esc(label)}"${anno ? ` data-anno="${anno}"` : ''}>${TABS.map(
      ([id, text]) =>
        `<a href="#" class="tab" data-action="tab" data-tab="${id}"${attrs({ 'aria-current': id === active ? 'page' : undefined })}><span class="tab__icon"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${TAB_ICONS[id]}</svg></span><span class="tab__label">${esc(labels[id] || text)}</span></a>`,
    ).join('')}</nav>`;

  /* iOS 26: bar items sit on Liquid Glass capsules and the bar itself has no background (a scroll-edge effect
     separates it from content). Android: a plain Material top app bar. */
  const navBar = ({ back = 'Back', actions = '', title = '', anno = '' }) =>
    `<div class="navbar"${anno ? ` data-anno="${anno}"` : ''}>
      <a href="#" class="navbar__back glass" data-action="back">${icon('chevron-left')}<span class="navbar__back-label t-callout">${esc(back)}</span><span class="sr-only">Back to ${esc(back)}</span></a>
      ${title ? `<span class="navbar__title t-headline">${esc(title)}</span>` : ''}
      <span class="navbar__actions${actions ? ' glass' : ''}">${actions}</span>
    </div>`;

  /* iOS root screens keep the bar row above the large title even when it is empty, so titles line up across tabs.
     Android root screens start with the title. */
  const rootBar = (platform = 'ios', actions = '') =>
    platform === 'android' ? '' : `<div class="navbar navbar--root">${actions ? `<span class="navbar__actions">${actions}</span>` : ''}</div>`;

  /* “New achievement”: iOS — a prominent glass “+” in the top bar of a root screen; Android — an extended FAB. */
  const createButton = (platform = 'ios', { anno = '', label = 'New achievement' } = {}) =>
    platform === 'android'
      ? `<div class="fab-wrap"><button type="button" class="fab" data-action="create"${anno ? ` data-anno="${anno}"` : ''}>${icon('plus')}<span>${esc(label)}</span></button></div>`
      : rootBar('ios', `<button type="button" class="glass-btn glass-btn--prominent" data-action="create" aria-label="${esc(label)}"${anno ? ` data-anno="${anno}"` : ''}>${icon('plus')}</button>`);

  /* Apple-style title case for the few iOS system strings that need it (alert and notification buttons):
     every word capitalised except short articles, conjunctions and prepositions. */
  const SMALL_WORDS = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'so', 'yet', 'as', 'at', 'by', 'in', 'of', 'off', 'on', 'per', 'to', 'up', 'via', 'with', 'from', 'into', 'onto', 'over']);
  const titleCase = (text) =>
    text
      .split(' ')
      .map((w, i, all) => (i > 0 && i < all.length - 1 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' ');

  /* Confirmation for an action the person chose (pause, withdraw, delete). iOS: an action sheet — the
     destructive choice on top in the destructive style, Cancel apart at the bottom (HIG action-sheets.md).
     Android: a Material 3 dialog with text buttons, Cancel first. Cancel gets initial focus on both. */
  const confirm = ({ platform = 'ios', title, message, action, destructive = true, iconName = '', anno = '', ids = nextId('cf') }) =>
    platform === 'android'
      ? `<div class="mdialog" role="alertdialog" aria-modal="true" aria-labelledby="${ids}-t" aria-describedby="${ids}-d"${anno ? ` data-anno="${anno}"` : ''}>
          ${iconName ? `<span class="mdialog__icon" aria-hidden="true">${icon(iconName)}</span>` : ''}
          <h2 class="mdialog__title" id="${ids}-t">${title}</h2>
          <p class="mdialog__msg" id="${ids}-d">${message}</p>
          <div class="mdialog__actions">
            <button type="button" class="mbtn" data-action="close-overlay" data-autofocus>Cancel</button>
            <button type="button" class="mbtn ${destructive ? 'mbtn--danger' : ''}" data-action="close-overlay">${esc(action)}</button>
          </div>
        </div>`
      : `<div class="asheet" role="alertdialog" aria-modal="true" aria-labelledby="${ids}-t" aria-describedby="${ids}-d"${anno ? ` data-anno="${anno}"` : ''}>
          <div class="asheet__group">
            <div class="asheet__head"><h2 class="asheet__title" id="${ids}-t">${title}</h2><p class="asheet__msg" id="${ids}-d">${message}</p></div>
            <button type="button" class="asheet__btn ${destructive ? 'asheet__btn--destructive' : ''}" data-action="close-overlay">${esc(titleCase(action))}</button>
          </div>
          <button type="button" class="asheet__btn asheet__cancel" data-action="close-overlay" data-autofocus>Cancel</button>
        </div>`;

  /* ───────── Feedback ───────── */
  const snackbar = ({ text, action = 'Undo', iconName = 'circle-check', floating = false, extra = {} }) =>
    `<div class="snackbar ${floating ? 'snackbar--floating' : ''}" role="status" aria-live="polite">
      ${iconName ? icon(iconName) : ''}<p class="snackbar__text t-subhead">${text}</p>
      ${action ? `<button type="button" class="snackbar__action"${attrs(extra)}>${esc(action)}</button>` : ''}
    </div>`;

  const banner = ({ iconName = 'wifi-off', text }) =>
    `<div class="banner" role="status">${icon(iconName)}<p class="banner__text t-subhead">${text}</p></div>`;

  const dialog = ({ title, body = '', list = [], actions = '', iconName = '', danger = false, centered = false, ids = nextId('dlg') }) =>
    `<div class="dialog ${centered ? 'dialog--centered' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="${ids}-t" aria-describedby="${ids}-d">
      ${iconName ? `<div class="dialog__icon ${danger ? 'dialog__icon--danger' : ''}" aria-hidden="true">${icon(iconName)}</div>` : ''}
      <h2 class="t-title-3" id="${ids}-t">${title}</h2>
      <div id="${ids}-d">
        ${body ? `<p class="dialog__body t-callout">${body}</p>` : ''}
        ${list.length ? `<ul class="dialog__list t-subhead">${list.map(([ic, text]) => `<li>${icon(ic, 'icon--sm')}<span>${text}</span></li>`).join('')}</ul>` : ''}
      </div>
      <div class="dialog__actions">${actions}</div>
    </div>`;

  const menu = (items, { label = 'More actions' } = {}) =>
    `<div class="menu" role="menu" aria-label="${esc(label)}">${items
      .map((it) =>
        it === '-'
          ? '<div class="menu__sep" role="separator"></div>'
          : `<button type="button" role="menuitem" class="menu__item ${it.danger ? 'menu__item--danger' : ''}"${attrs({ 'data-action': it.action })}>${icon(it.icon)}<span>${esc(it.label)}</span>${it.note ? `<span class="menu__note">${it.note}</span>` : ''}</button>`,
      )
      .join('')}</div>`;

  /* ───────── Form controls ───────── */
  const field = ({ label, value = '', placeholder = '', helper = '', error = '', suffix = '', optional = false, area = false, focus = false, disabled = false, iconName = '', readonly = false, ids = nextId('fld') }) => {
    const describedBy = helper || error ? `${ids}-h` : undefined;
    const control = readonly
      ? `<span class="field__value ${value ? '' : 'field__value--placeholder'}" id="${ids}">${esc(value || placeholder)}</span>`
      : area
        ? `<textarea id="${ids}" rows="3" placeholder="${esc(placeholder)}"${attrs({ 'aria-describedby': describedBy, disabled })}>${esc(value)}</textarea>`
        : `<input id="${ids}" value="${esc(value)}" placeholder="${esc(placeholder)}"${attrs({ 'aria-describedby': describedBy, 'aria-invalid': error ? 'true' : undefined, disabled, inputmode: suffix ? 'decimal' : undefined })}>`;
    return `<div class="field ${error ? 'field--error' : ''} ${disabled ? 'field--disabled' : ''}">
      <label class="field__label" for="${ids}">${esc(label)}${optional ? ' <span class="field__optional">(optional)</span>' : ''}</label>
      <div class="field__control ${area ? 'field__control--area' : ''} ${focus ? 'is-focus' : ''}">${control}${suffix ? `<span class="field__suffix">${esc(suffix)}</span>` : ''}${iconName ? `<span class="c-secondary" aria-hidden="true">${icon(iconName)}</span>` : ''}</div>
      ${error ? `<p class="field__helper t-footnote" id="${ids}-h">${icon('circle-alert', 'icon--sm')}<span>${esc(error)}</span></p>` : helper ? `<p class="field__helper t-footnote" id="${ids}-h">${esc(helper)}</p>` : ''}
    </div>`;
  };

  const switchRow = ({ label, hint = '', on = false, ids = nextId('sw') }) =>
    `<div class="toggle-row">
      <div class="toggle-row__text"><p class="t-callout" id="${ids}-l" style="font-weight:600">${esc(label)}</p>${hint ? `<p class="toggle-row__hint t-footnote" id="${ids}-h">${hint}</p>` : ''}</div>
      <button type="button" class="switch" role="switch" aria-checked="${on}" aria-labelledby="${ids}-l"${hint ? ` aria-describedby="${ids}-h"` : ''}><span class="switch__thumb">${on ? icon('check') : ''}</span></button>
    </div>`;

  const checkboxRow = ({ html, checked = false, ids = nextId('cb') }) =>
    `<div class="checkbox-row">
      <button type="button" class="checkbox" role="checkbox" aria-checked="${checked}" aria-labelledby="${ids}-l">${icon('check')}</button>
      <p class="t-callout" id="${ids}-l">${html}</p>
    </div>`;

  const segmented = ({ options, selected, label, block = false, action = '' }) =>
    `<div class="seg ${block ? 'seg--block' : ''}" role="group" aria-label="${esc(label)}">${options
      .map(
        ([value, text, iconName, sub]) =>
          `<button type="button" class="seg__btn" aria-pressed="${value === selected}"${attrs({ 'data-action': action || undefined, 'data-value': value })}>${iconName ? icon(iconName) : ''}<span>${esc(text)}</span>${sub ? `<span class="t-caption c-secondary tnum">${esc(sub)}</span>` : ''}</button>`,
      )
      .join('')}</div>`;

  /* Value entry for target quests: a decimal field (numeric keyboard) flanked by − / + steppers. */
  const stepper = ({ value, unit, label = 'Value', step = '1', ids = nextId('stp') }) =>
    `<div class="stepper" role="group" aria-labelledby="${ids}-l">
      <span class="sr-only" id="${ids}-l">${esc(label)}</span>
      ${iconButton({ iconName: 'minus', label: `Decrease by ${step}`, variant: 'tonal' })}
      <label class="stepper__value"><input class="stepper__number" value="${esc(value)}" inputmode="decimal" aria-label="${esc(label)}" style="width:${String(value).length + 0.6}ch"><span class="stepper__unit" aria-hidden="true">${esc(unit)}</span></label>
      ${iconButton({ iconName: 'plus', label: `Increase by ${step}`, variant: 'tonal' })}
    </div>`;

  const skeletonCard = () =>
    `<div class="qcard" aria-hidden="true">
      <div class="skel" style="width:40px;height:40px;border-radius:12px"></div>
      <div class="stack" style="--gap:8px"><div class="skel" style="height:12px;width:45%"></div><div class="skel" style="height:16px;width:80%"></div><div class="skel" style="height:12px;width:60%"></div></div>
      <div class="skel" style="width:44px;height:44px;border-radius:50%"></div>
    </div>`;

  /* Check-in sheet: done / value / note. Only check-ins dated today count (R-CHK-04). */
  const checkInSheet = ({ q, a, value = '', earlierDate = false, docked = false, ids = nextId('ci') }) => {
    let body = '';
    let cta = 'Check in';
    if (q.type === 'one_time') {
      cta = 'Mark as done';
      body = `<p class="t-callout c-secondary">Finishing this quest earns <strong class="c-accent tnum">${fmt.num(q.xp)} XP</strong>.</p>`;
    } else if (q.type === 'habit') {
      body = `<div class="row" style="justify-content:space-between;flex-wrap:wrap"><p class="t-subhead tnum" style="font-weight:600">${habitProgressText(q)}</p>${streak(q.streak)}</div>
        <div style="margin-top:12px">${weekStrip(q.week)}</div>`;
    } else {
      const t = q.target;
      const step = t.step ?? 1;
      const proposed = value || fmt.num(t.current + (t.goal > t.start ? step : -step), t.digits ?? 0);
      cta = 'Save check-in';
      body = `${stepper({ value: proposed, unit: t.unit, label: `New value in ${t.unit}`, step: fmt.num(step, t.digits ?? 0) })}
        <p class="t-footnote c-secondary tnum" style="margin-top:12px;text-align:center">Last check-in ${targetValue(q, t.current)} on ${fmt.dayMonth(t.lastOn || data.TODAY)} · Goal ${targetValue(q, t.goal)}</p>`;
    }
    return `<div class="sheet ${docked ? 'sheet--docked' : ''}" role="dialog" aria-modal="true" aria-labelledby="${ids}-t">
      <div class="sheet__grabber" aria-hidden="true"></div>
      <div class="sheet__header"><h2 class="t-title-3" id="${ids}-t">Check in</h2>${iconButton({ iconName: 'x', label: 'Close', extra: { 'data-action': 'close-sheet' } })}</div>
      <div class="sheet__quest">
        <span class="qcard__lead" aria-hidden="true">${icon(data.TYPE_ICON[q.type])}</span>
        <div><p class="t-headline">${esc(q.title)}</p><p class="t-footnote c-secondary">${esc(a.title)}</p></div>
      </div>
      <div style="margin-top:20px">${body}</div>
      <div class="stack" style="--gap:16px;margin-top:20px">
        ${field({ label: 'Note', optional: true, area: true, placeholder: q.type === 'target' ? 'Anything worth remembering?' : 'How did it go?' })}
        <div class="field">
          <span class="field__label" id="${ids}-dl">Date</span>
          <button type="button" class="field__control" aria-labelledby="${ids}-dl ${ids}-dv" style="text-align:left">
            <span class="field__value tnum" id="${ids}-dv">${earlierDate ? 'Tuesday, 03.11.2026' : 'Today, 05.11.2026'}</span>${icon('calendar', 'c-secondary')}
          </button>
          ${earlierDate ? `<p class="field__helper t-footnote">${icon('info', 'icon--sm')} Earlier days are saved to your history. Only check-ins made for today count toward progress and XP.</p>` : ''}
        </div>
      </div>
      <div class="sheet__footer">${button({ label: cta, variant: 'primary', size: 'lg', block: true, iconName: 'check', extra: { 'data-action': 'confirm-check-in', 'data-quest': `${a.id}/${q.id}` } })}</div>
    </div>`;
  };

  QL.ui = {
    checkInSheet,
    esc,
    nextId,
    icon,
    attrs,
    tag,
    xpTag,
    button,
    iconButton,
    checkButton,
    ring,
    bar,
    HEX,
    levelEmblem,
    levelCard,
    weekStrip,
    streak,
    streakText,
    habitProgressText,
    habitScheduleText,
    targetProgressText,
    targetValue,
    questMeta,
    questCard,
    privateGroupCard,
    ringTile,
    RANKS,
    badge,
    questPath,
    questList,
    statusBar,
    tabBar,
    navBar,
    createButton,
    rootBar,
    titleCase,
    confirm,
    snackbar,
    banner,
    dialog,
    menu,
    field,
    switchRow,
    checkboxRow,
    segmented,
    stepper,
    skeletonCard,
  };
})(window.QL);
