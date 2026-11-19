/* Questline components added in pass 2 (settings lists, achievement cards, wizard, charts, calendar, empty and
   error states, celebrations, share card, system surfaces). Same rules as ui.js: semantic tokens, 48 pt targets,
   state by icon + word, names / roles / values for screen readers. */
window.QL = window.QL || {};

(function (QL) {
  const { data, fmt } = QL;
  const ui = QL.ui;
  const { esc, icon, attrs, nextId, tag, button, iconButton, ring, badge, HEX } = ui;

  /* ───────── Grouped lists (settings, profile, privacy) ───────── */
  const listRow = ({ iconName = '', label, sub = '', value = '', kind = 'link', on = false, danger = false, action = '', tone = '', ids = nextId('lr') }) => {
    const lead = iconName ? `<span class="lrow__icon ${tone ? `lrow__icon--${tone}` : ''}" aria-hidden="true">${icon(iconName)}</span>` : '';
    const text = `<span class="lrow__body"><span class="lrow__label t-callout" id="${ids}-l">${esc(label)}</span>${sub ? `<span class="lrow__sub t-footnote" id="${ids}-s">${sub}</span>` : ''}</span>`;
    if (kind === 'toggle') {
      return `<li><div class="lrow">${lead}${text}<button type="button" class="switch" role="switch" aria-checked="${on}" aria-labelledby="${ids}-l"${sub ? ` aria-describedby="${ids}-s"` : ''}${attrs({ 'data-action': action || undefined })}><span class="switch__thumb">${on ? icon('check') : ''}</span></button></div></li>`;
    }
    if (kind === 'static') return `<li><div class="lrow">${lead}${text}${value ? `<span class="lrow__value t-subhead">${value}</span>` : ''}</div></li>`;
    const tagName = kind === 'button' ? 'button type="button"' : 'a href="#"';
    const close = kind === 'button' ? 'button' : 'a';
    return `<li><${tagName} class="lrow lrow--action ${danger ? 'lrow--danger' : ''}"${attrs({ 'data-action': action || undefined })}>${lead}${text}${value ? `<span class="lrow__value t-subhead">${value}</span>` : ''}${kind === 'link' ? `<span class="lrow__chev" aria-hidden="true">${icon('chevron-right')}</span>` : ''}</${close}></li>`;
  };

  const listGroup = ({ title = '', rows = [], footer = '', ids = nextId('lg') }) =>
    `<div class="lgroup"${title ? ` role="group" aria-labelledby="${ids}-t"` : ''}>
      ${title ? `<h2 class="lgroup__title t-overline" id="${ids}-t">${esc(title)}</h2>` : ''}
      <ul class="lgroup__list">${rows.join('')}</ul>
      ${footer ? `<p class="lgroup__footer t-footnote">${footer}</p>` : ''}
    </div>`;

  const avatar = (initial, { size = 64 } = {}) =>
    `<span class="avatar" style="--av:${size}px" aria-hidden="true">${esc(initial)}</span>`;

  /* Radio rows live in a list marked role="radiogroup"; the list items are presentational so the radios belong
     directly to the group. */
  const radioRow = ({ label, hint = '', checked = false, name = 'r', preview = '', ids = nextId('rr') }) =>
    `<li role="none"><button type="button" class="rrow" role="radio" aria-checked="${checked}" aria-labelledby="${ids}-l"${hint ? ` aria-describedby="${ids}-h"` : ''} data-group="${esc(name)}">
      ${preview}
      <span class="rrow__body"><span class="t-callout" id="${ids}-l" style="font-weight:600">${esc(label)}</span>${hint ? `<span class="t-footnote c-secondary" id="${ids}-h">${hint}</span>` : ''}</span>
      <span class="rrow__dot" aria-hidden="true"></span>
    </button></li>`;

  /* ───────── Achievements list card ─────────
     The card is one link whose name is its visible text (plus short screen-reader words), so speech users can say
     what they see. */
  /* Row actions: iOS swipe actions (filled symbols; shortcuts for actions that also live in the detail menu) and
     the Android long-press menu with the same choices. */
  const SWIPE_ACTIONS = {
    active: [['pause', 'Pause', 'paused'], ['trash-2', 'Delete', 'danger']],
    paused: [['play', 'Resume', 'resume'], ['trash-2', 'Delete', 'danger']],
    completed: [['share', 'Share', 'resume']],
  };
  const PRESS_MENU = {
    active: [{ icon: 'pencil', label: 'Edit details' }, { icon: 'eye-off', label: 'Make private' }, { icon: 'pause', label: 'Pause…' }, '-', { icon: 'trash-2', label: 'Delete…', danger: true }],
    paused: [{ icon: 'play', label: 'Resume' }, { icon: 'eye-off', label: 'Make private' }, '-', { icon: 'trash-2', label: 'Delete…', danger: true }],
    completed: [{ icon: 'share', label: 'Create a share card' }, { icon: 'eye-off', label: 'Make private' }],
  };

  const achievementCard = (a, { revealed = true, action = 'open-achievement', swiped = false, pressed = false, anno = '' } = {}) => {
    const cat = data.CATEGORIES[a.category] || data.CATEGORIES.custom;
    const annoAttr = anno ? ` data-anno="${anno}"` : '';
    const card = (inner, cls = '') => `<a class="card acard ${cls}" href="#"${attrs({ 'data-action': action, 'data-achievement': a.id })}>${inner}</a>`;
    const link = (inner) => {
      if (swiped) {
        const acts = SWIPE_ACTIONS[a.status] || [];
        return `<li class="swipe" style="--swipe-w:${acts.length * 88 + 8}px"${annoAttr}><div class="swipe__actions">${acts
          .map(([ic, label, tone]) => `<button type="button" class="swipe__btn swipe__btn--${tone}">${icon(ic)}<span>${label}<span class="sr-only"> ${esc(a.title)}</span></span></button>`)
          .join('')}</div>${card(inner, 'acard--swiped')}</li>`;
      }
      if (pressed) {
        return `<li class="acard-wrap"${annoAttr}>${card(inner, 'acard--pressed')}<div class="popover popover--anchored">${ui.menu(PRESS_MENU[a.status] || [], { label: `Actions for ${a.title}` })}</div></li>`;
      }
      return `<li>${card(inner)}</li>`;
    };
    if (a.isPrivate && !revealed) {
      return `<li><button type="button" class="card acard" data-action="reveal">
        ${ring({ p: 0, variant: 'private', center: icon('eye-off') })}
        <span class="acard__body"><span class="acard__title t-headline">Private achievement<span class="sr-only">, hidden.</span></span><span class="acard__meta t-footnote">${icon('lock', 'icon--sm')}Tap to show</span><span class="redact" style="--w:8em;margin-top:6px" aria-hidden="true"></span></span>
      </button></li>`;
    }
    if (a.status === 'completed') {
      return link(
        `${badge({ rank: a.rank, iconName: cat.icon, size: 56, caption: false })}
        <span class="acard__body"><span class="acard__title t-headline">${esc(a.title)}</span>
        <span class="acard__meta t-footnote">${ui.tag(ui.RANKS[a.rank] || 'Unlocked', 'outline')}<span class="tnum">Unlocked ${fmt.date(a.completedOn)}</span></span></span>
        <span class="acard__chev" aria-hidden="true">${icon('chevron-right')}</span>`,
      );
    }
    const paused = a.status === 'paused';
    const next = a.next ? `<span class="acard__next t-footnote">Next: ${esc(a.next.title)}</span>` : '';
    return link(
      `${ring({ p: paused ? 0 : a.progress, variant: paused ? 'paused' : '', center: icon(paused ? 'pause' : cat.icon) })}
      <span class="acard__body"><span class="acard__title t-headline">${esc(a.title)}</span>
      <span class="acard__meta t-footnote">${paused ? `${icon('pause', 'icon--sm')}Paused · starts fresh when resumed` : `<span class="tnum">${fmt.pct(a.progress)}<span class="sr-only"> complete,</span></span><span class="dot-sep"></span>${a.targetDate ? `<span class="tnum">${fmt.daysLeft(a.targetDate)}</span>` : 'No target date'}`}${a.isPrivate ? `<span class="dot-sep"></span>${icon('lock', 'icon--sm')}Private` : ''}</span>
      ${paused ? '' : next}</span>
      <span class="acard__chev" aria-hidden="true">${icon('chevron-right')}</span>`,
    );
  };

  /* ───────── Widgets (WidgetKit on iOS, Glance on Android) ─────────
     Sizes for a 390 × 844 pt phone (HIG widgets.md › Specifications): small 158 × 158, medium 338 × 158; Lock Screen
     circular 72 × 72, rectangular 160 × 72. Standard 16 pt margins, text 11 pt or larger. */
  const widgetStreak = (streakText) => (streakText ? `<p class="widget__foot">${icon('flame', 'icon--sm')}<span>${streakText}</span></p>` : '');

  const widgetSmall = ({ left, total, level, levelP, streakText }) =>
    `<div class="widget widget--small" role="group" aria-label="Questline widget, small">
      <div class="widget__head">${ring({ p: levelP, size: 'sm', center: `<span class="widget__lvl">${level}</span>`, label: `Level ${level}` })}<span class="widget__label">Today</span></div>
      <p class="widget__big"><span class="widget__num">${left}</span><span class="widget__unit">${left === 1 ? 'quest' : 'quests'} left<span class="sr-only"> of ${total} today</span></span></p>
      ${widgetStreak(streakText)}
    </div>`;

  const widgetRow = (r) => {
    if (r.kind === 'private') {
      return `<li class="wrow"><span class="wrow__lead" aria-hidden="true">${icon('lock', 'icon--sm')}</span><span class="wrow__body"><span class="wrow__title">${r.title}</span><span class="wrow__meta">${r.meta}</span></span></li>`;
    }
    const control =
      r.kind === 'log'
        ? `<a href="#" class="wrow__check wrow__check--log" aria-label="Log progress: ${esc(r.title)}">${icon('plus')}</a>`
        : `<button type="button" class="wrow__check" aria-label="Check in: ${esc(r.title)}" aria-pressed="false">${icon('check')}</button>`;
    return `<li class="wrow"><span class="wrow__body"><span class="wrow__title">${esc(r.title)}</span><span class="wrow__meta">${esc(r.meta)}</span></span>${control}</li>`;
  };

  const widgetMedium = ({ left, total, level, levelP, rows = [], locked = false }) =>
    `<div class="widget widget--medium" role="group" aria-label="Questline widget, medium">
      <div class="widget__side">
        <div class="widget__head">${ring({ p: levelP, size: 'sm', center: `<span class="widget__lvl">${level}</span>`, label: `Level ${level}` })}<span class="widget__label">Today</span></div>
        <p class="widget__big"><span class="widget__num">${left}</span><span class="widget__unit">of ${total} left</span></p>
      </div>
      ${
        locked
          ? `<div class="widget__locked">${icon('lock')}<p>Quest names are hidden while App lock is on.</p></div>`
          : `<ul class="widget__list">${rows.map(widgetRow).join('')}</ul>`
      }
    </div>`;

  /* Lock Screen accessory widgets: vibrant and monochrome; never names, because anyone can see the Lock Screen. */
  const lockWidgets = ({ left, done, total, streakText }) =>
    `<div class="lw-row">
      <div class="lw lw--circular" role="img" aria-label="${left} of ${total} quests left today">
        ${ring({ p: total ? done / total : 0, size: 'md', center: `<span class="lw__num">${left}</span><span class="lw__cap">left</span>` })}
      </div>
      <div class="lw lw--rect">
        <p class="lw__title">${left} ${left === 1 ? 'quest' : 'quests'} left today</p>
        <p class="lw__meta">${icon('flame', 'icon--sm')}${streakText}</p>
        <span class="lw__bar" role="img" aria-label="${done} of ${total} done"><span style="width:${total ? Math.round((done / total) * 100) : 0}%"></span></span>
      </div>
    </div>`;

  /* ───────── Wizard chrome ───────── */
  const wizardTop = ({ step, total = 4, skip = false, ids = nextId('wz') }) =>
    `<div class="wiz-top">
      ${step === 1 ? iconButton({ iconName: 'x', label: 'Close', extra: { 'data-action': 'wiz-close' } }) : iconButton({ iconName: 'chevron-left', label: 'Back', extra: { 'data-action': 'wiz-back' } })}
      <span class="wiz-top__step t-subhead" id="${ids}-s">Step ${step} of ${total}</span>
      ${skip ? button({ label: 'Skip', variant: 'text', size: 'sm', extra: { 'data-action': 'wiz-skip' } }) : '<span class="wiz-top__spacer"></span>'}
    </div>
    <div class="wiz-progress" role="progressbar" aria-labelledby="${ids}-s" aria-valuemin="1" aria-valuemax="${total}" aria-valuenow="${step}">
      ${Array.from({ length: total }, (_, i) => `<span class="${i < step ? 'is-done' : ''}"></span>`).join('')}
    </div>`;

  const footer = (html) => `<div class="screen-footer">${html}</div>`;

  const templateCard = (t, { selected = false } = {}) => {
    const cat = data.CATEGORIES[t.category];
    const count = t.quests.length || { exam: 5, move: 6, fund: 4, job: 5 }[t.id] || 4;
    return `<li><button type="button" class="tcard" aria-pressed="${selected}" data-action="wiz-template" data-value="${t.id}">
      <span class="tcard__icon" aria-hidden="true">${icon(cat.icon)}</span>
      <span class="tcard__body"><span class="t-headline">${esc(t.title)}</span><span class="t-footnote c-secondary">${esc(t.blurb)} · ${count} quests</span></span>
      <span class="tcard__check" aria-hidden="true">${selected ? icon('circle-check') : ''}</span>
    </button></li>`;
  };

  const questXp = (q) => {
    if (q.type !== 'habit') return data.SIZE_XP[q.size];
    const days = q.habit.count * (q.habit.period === 'week' ? 7 : 1);
    const factor = days >= 113 ? 3 : days >= 57 ? 2 : days >= 29 ? 1.5 : 1;
    return Math.round(data.SIZE_XP[q.size] * factor);
  };

  const questSummary = (q) => {
    if (q.type === 'habit') return `${q.habit.times}× a ${q.habit.period} for ${q.habit.count} ${q.habit.period}s`;
    if (q.type === 'target') return `${fmt.num(q.target.start)} → ${fmt.num(q.target.goal)} ${q.target.unit}`;
    return '';
  };

  const suggestionRow = (q, { ids = nextId('sg'), after = '' } = {}) =>
    `<li class="sgrow ${q.on ? '' : 'sgrow--off'}">
      <button type="button" class="checkbox" role="checkbox" aria-checked="${!!q.on}" aria-labelledby="${ids}-t" aria-describedby="${ids}-m" data-action="wiz-toggle" data-value="${q.id}">${icon('check')}</button>
      <span class="sgrow__body">
        <span class="t-headline" id="${ids}-t">${esc(q.title)}</span>
        <span class="sgrow__meta t-footnote" id="${ids}-m"><span>${icon(data.TYPE_ICON[q.type], 'icon--sm')}${data.TYPE_LABEL[q.type]}${questSummary(q) ? ` · ${questSummary(q)}` : ''}</span>${q.bonus ? `<span class="c-bonus">${icon('star', 'icon--sm')}Bonus</span>` : ''}${after ? `<span>${icon('lock', 'icon--sm')}After “${esc(after)}”</span>` : ''}</span>
      </span>
      <span class="tag tag--xp tnum">${icon('sparkle')}${questXp(q)} XP</span>
    </li>`;

  /* ───────── Charts (each with a table for screen readers; values labelled directly) ───────── */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const barChart = ({ values, labels = MONTHS, title, unit = 'XP', current = -1, ids = nextId('bc') }) => {
    const w = 342;
    const h = 170;
    const top = 22;
    const bottom = 24;
    const max = Math.max(...values, 1);
    const scaleMax = Math.ceil(max / 100) * 100;
    const bw = (w / values.length) * 0.56;
    const step = w / values.length;
    const y = (v) => top + (h - top - bottom) * (1 - v / scaleMax);
    const bars = values
      .map((v, i) => {
        const x = i * step + (step - bw) / 2;
        const label = `<text class="chart__xlabel ${i === current ? 'is-current' : ''}" x="${(x + bw / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle">${labels[i].slice(0, 1)}</text>`;
        if (!v) return `<rect class="chart__stub" x="${x.toFixed(1)}" y="${h - bottom - 2}" width="${bw.toFixed(1)}" height="2" rx="1"></rect>${label}`;
        const yy = y(v);
        return `<rect class="chart__bar" x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - bottom - yy).toFixed(1)}" rx="5"></rect><text class="chart__vlabel" x="${(x + bw / 2).toFixed(1)}" y="${(yy - 6).toFixed(1)}" text-anchor="middle">${fmt.num(v)}</text>${label}`;
      })
      .join('');
    const grid = [0, 0.5, 1].map((f) => `<line class="chart__grid" x1="0" x2="${w}" y1="${y(scaleMax * f).toFixed(1)}" y2="${y(scaleMax * f).toFixed(1)}"></line>`).join('');
    const rows = values.map((v, i) => `<tr><th scope="row">${labels[i]}</th><td>${fmt.num(v)} ${unit}</td></tr>`).join('');
    return `<figure class="chart" aria-labelledby="${ids}-c">
      <svg viewBox="0 0 ${w} ${h}" class="chart__svg" aria-hidden="true">${grid}${bars}</svg>
      <figcaption class="sr-only" id="${ids}-c">${esc(title)}</figcaption>
      <table class="sr-only"><caption>${esc(title)}</caption><tbody>${rows}</tbody></table>
    </figure>`;
  };

  /* Line chart for a target quest: value over time, the goal as a dashed line. */
  const lineChart = ({ points, start, goal, from, to, unit, title, money = false, ids = nextId('lc') }) => {
    const w = 342;
    const h = 180;
    const pad = { l: 8, r: 8, t: 26, b: 26 };
    const days = fmt.daysBetween(from, to);
    const vmax = Math.max(goal, start, ...points.map((p) => p.value));
    const vmin = Math.min(goal, start, ...points.map((p) => p.value));
    const x = (iso) => pad.l + ((w - pad.l - pad.r) * fmt.daysBetween(from, iso)) / days;
    const y = (v) => pad.t + ((h - pad.t - pad.b) * (vmax - v)) / (vmax - vmin || 1);
    const all = [{ date: from, value: start }, ...points];
    const d = all.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const val = (v) => (money ? `CHF ${fmt.num(v)}` : `${fmt.num(v)} ${unit}`);
    const rows = all.map((p) => `<tr><th scope="row">${fmt.date(p.date)}</th><td>${val(p.value)}</td></tr>`).join('');
    return `<figure class="chart" aria-labelledby="${ids}-c">
      <svg viewBox="0 0 ${w} ${h}" class="chart__svg" aria-hidden="true">
        <line class="chart__goal" x1="${pad.l}" x2="${w - pad.r}" y1="${y(goal).toFixed(1)}" y2="${y(goal).toFixed(1)}"></line>
        <text class="chart__goal-label" x="${w - pad.r}" y="${(y(goal) - 7).toFixed(1)}" text-anchor="end">Goal ${val(goal)}</text>
        <path class="chart__line" d="${d}"></path>
        ${all.map((p) => `<circle class="chart__dot" cx="${x(p.date).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4"></circle>`).join('')}
        <text class="chart__xlabel" x="${pad.l}" y="${h - 6}">${fmt.dayMonth(from)}</text>
        <text class="chart__xlabel" x="${w - pad.r}" y="${h - 6}" text-anchor="end">Today</text>
      </svg>
      <figcaption class="sr-only" id="${ids}-c">${esc(title)}</figcaption>
      <table class="sr-only"><caption>${esc(title)}</caption><tbody>${rows}</tbody></table>
    </figure>`;
  };

  /* Month grid for habits (week starts on the account's week start). Past days without a check-in are hollow and
     neutral; the screen reader hears each day's state. */
  const monthCalendar = ({ year, month, done, today, runStart, runEnd }) => {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const daysIn = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lead = (first.getUTCDay() + 6) % 7;
    const name = new Intl.DateTimeFormat(data.LOCALE, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);
    const cells = [];
    for (let i = 0; i < lead; i += 1) cells.push('<li class="cal__day cal__day--blank" aria-hidden="true"></li>');
    for (let d = 1; d <= daysIn; d += 1) {
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      let state = 'out';
      if (iso >= runStart && iso <= runEnd) {
        if (done.has(iso)) state = 'done';
        else if (iso === today) state = 'today';
        else if (iso < today) state = 'none';
        else state = 'future';
      }
      const sr = { done: 'checked in', none: 'no check-in', today: 'today, not checked in yet', future: 'upcoming', out: 'outside this run' }[state];
      cells.push(`<li class="cal__day cal__day--${state}"><span class="cal__num" aria-hidden="true">${d}</span><span class="sr-only">${d} ${name.split(' ')[0]}: ${sr}</span></li>`);
    }
    return `<div class="cal" role="group" aria-label="${esc(name)}">
      <p class="cal__title t-subhead">${esc(name)}</p>
      <div class="cal__head t-caption" aria-hidden="true"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span></div>
      <ol class="cal__grid">${cells.join('')}</ol>
    </div>`;
  };

  /* ───────── Empty, error and notice blocks ───────── */
  const pathArt = () =>
    `<svg class="empty__art" viewBox="0 0 160 120" aria-hidden="true">
      <path d="M24 98 C 52 98, 44 60, 80 60 S 112 22, 136 22" class="empty__path"></path>
      <circle cx="24" cy="98" r="7" class="empty__start"></circle>
      <circle cx="68" cy="63" r="6" class="empty__node"></circle>
      <circle cx="98" cy="45" r="6" class="empty__node"></circle>
      <polygon points="${HEX(17, 136, 22)}" class="empty__goal"></polygon>
    </svg>`;

  const emptyState = ({ title, body, actions = '', art = pathArt(), iconName = '' }) =>
    `<div class="empty">
      ${iconName ? `<span class="empty__icon" aria-hidden="true">${icon(iconName)}</span>` : art}
      <h2 class="t-title-3">${title}</h2>
      <p class="t-callout c-secondary">${body}</p>
      ${actions ? `<div class="empty__actions">${actions}</div>` : ''}
    </div>`;

  const notice = ({ iconName = 'circle-alert', title, body, actions = '', tone = 'neutral' }) =>
    `<div class="card notice notice--${tone}" role="${tone === 'error' ? 'alert' : 'status'}">
      <span class="notice__icon" aria-hidden="true">${icon(iconName)}</span>
      <div class="notice__body"><p class="t-headline">${title}</p><p class="t-subhead c-secondary">${body}</p>${actions ? `<div class="notice__actions">${actions}</div>` : ''}</div>
    </div>`;

  /* ───────── Celebrations ───────── */
  const confetti = (n = 26) =>
    `<div class="confetti" aria-hidden="true">${Array.from({ length: n }, (_, i) => {
      const left = (i * 37) % 100;
      const delay = ((i * 113) % 900) / 1000;
      const dur = 1.6 + ((i * 7) % 9) / 10;
      const kind = ['honey', 'moss', 'plum', 'sand'][i % 4];
      return `<span class="confetti__bit confetti__bit--${kind}" style="left:${left}%;animation-delay:${delay}s;animation-duration:${dur}s;--r:${(i * 47) % 360}deg"></span>`;
    }).join('')}</div>`;

  const levelUp = ({ from, to, xp, toNext, ids = nextId('lu') }) =>
    `<div class="scrim"></div>
    <div class="dialog dialog--centered levelup" role="dialog" aria-modal="true" aria-labelledby="${ids}-t" aria-describedby="${ids}-d">
      <div class="levelup__emblem">${ui.levelEmblem(to)}</div>
      <p class="t-overline c-accent">Level up</p>
      <h2 class="t-display" id="${ids}-t">Level ${to}</h2>
      <p class="t-callout c-secondary" id="${ids}-d">${to - from > 1 ? `You climbed from Level ${from} to Level ${to}.` : `You reached Level ${to}.`} <span class="tnum">${fmt.num(xp)} XP</span> · <span class="tnum">${fmt.num(toNext)} XP</span> to Level ${to + 1}.</p>
      <div class="dialog__actions">${button({ label: 'Continue', block: true, size: 'lg', extra: { 'data-action': 'levelup-continue', 'data-autofocus': true } })}</div>
    </div>`;

  const RANK_REASON = {
    champion: 'Flawless: every quest, every bonus quest, on time, never restarted.',
    diamond: 'Every required quest done, on time, never restarted.',
    emerald: 'Almost flawless.',
    platinum: 'A strong run with a restart or a late finish.',
    gold: 'A good run with a few bumps.',
    silver: 'Done, with a few restarts or a late finish.',
    bronze: 'Done. Every unlock counts.',
    unlocked: 'Done. Every unlock counts.',
  };

  const unlocked = ({ a, rank, questXp: qxp, bonus, days, motion = true, ids = nextId('ul') }) => {
    const cat = data.CATEGORIES[a.category];
    return `<div class="unlock" role="dialog" aria-modal="true" aria-labelledby="${ids}-t" aria-describedby="${ids}-d">
      ${motion ? confetti() : ''}
      <div class="unlock__glow" aria-hidden="true"></div>
      <div class="unlock__content">
        <p class="t-overline c-accent">Achievement unlocked</p>
        <div class="unlock__badge">${badge({ rank, iconName: cat.icon, size: 156, caption: false, title: a.title })}</div>
        <h2 class="t-brand-large unlock__title" id="${ids}-t">${esc(a.title)}</h2>
        <div id="${ids}-d">
          <p class="unlock__rank">${tag(ui.RANKS[rank], rank === 'champion' ? 'bonus' : 'outline', rank === 'champion' ? 'crown' : 'gem')}<span class="t-subhead c-secondary">${RANK_REASON[rank]}</span></p>
          <ul class="unlock__sum">
            <li><span class="t-subhead c-secondary">${a.requiredCount} quests in ${days} days</span><span class="t-headline tnum">+${fmt.num(qxp)} XP</span></li>
            <li><span class="t-subhead c-secondary">${ui.RANKS[rank]} rank bonus</span><span class="t-headline tnum c-accent">+${fmt.num(bonus)} XP</span></li>
          </ul>
        </div>
        <div class="stack" style="--gap:8px;margin-top:24px">
          ${button({ label: 'Continue', size: 'lg', block: true, extra: { 'data-action': 'unlock-continue', 'data-autofocus': true } })}
          ${button({ label: 'Create a share card', variant: 'secondary', size: 'lg', block: true, iconName: 'share', extra: { 'data-action': 'open-share' } })}
        </div>
      </div>
    </div>`;
  };

  /* Share card: made on the phone; the user picks every element. */
  const shareCard = ({ a, rank, show, name = 'Lena', days }) => {
    const cat = data.CATEGORIES[a.category];
    const title = show.title ? esc(a.title) : a.isPrivate ? 'A private achievement' : 'An achievement';
    return `<figure class="sharecard" aria-label="Share card preview">
      <div class="sharecard__brand">${icon('flag', 'icon--sm')}Questline</div>
      ${show.badge ? `<div class="sharecard__badge">${badge({ rank, iconName: cat.icon, size: 104, caption: false })}</div>` : ''}
      <p class="sharecard__over">Achievement unlocked</p>
      <p class="sharecard__title">${title}</p>
      ${show.badge ? `<p class="sharecard__rank">${ui.RANKS[rank]}</p>` : ''}
      ${show.date || show.stats ? `<p class="sharecard__meta">${show.date ? fmt.date(a.completedOn) : ''}${show.date && show.stats ? ' · ' : ''}${show.stats ? `${a.requiredCount} quests · ${days} days` : ''}</p>` : ''}
      ${show.why && a.why ? `<p class="sharecard__why">“${esc(a.why)}”</p>` : ''}
      ${show.name ? `<p class="sharecard__name">— ${esc(name)}</p>` : ''}
    </figure>`;
  };

  /* ───────── System surfaces (mock-ups of the OS around the app) ───────── */
  const appIcon = (size = 22) =>
    `<span class="appicon" style="--ai:${size}px" aria-hidden="true"><svg viewBox="0 0 100 108"><polygon points="${HEX(44)}" fill="#F0A93A" stroke="#F0A93A" stroke-width="8" stroke-linejoin="round"/><path d="M34 56l11 11 22-24" fill="none" stroke="#2B1A03" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;

  const notification = ({ title = 'Questline', body, time = 'now', actions = [] }) =>
    `<li class="notif"><span class="notif__icon">${appIcon(34)}</span><span class="notif__body"><span class="notif__head"><strong>${esc(title)}</strong><span>${esc(time)}</span></span><span class="notif__text">${body}</span>${
      actions.length ? `<span class="notif__actions">${actions.map((a) => `<span class="notif__action">${icon('check', 'icon--sm')}${esc(a)}</span>`).join('')}</span>` : ''
    }</span></li>`;

  /* ───────── Sign-in helpers ───────── */
  const passwordField = ({ label = 'Password', value = '', helper = '', error = '', ids = nextId('pw') }) =>
    `<div class="field ${error ? 'field--error' : ''}">
      <label class="field__label" for="${ids}">${esc(label)}</label>
      <div class="field__control"><input id="${ids}" type="password" value="${esc(value)}" autocomplete="current-password"${helper || error ? ` aria-describedby="${ids}-h"` : ''}${error ? ' aria-invalid="true"' : ''}>${iconButton({ iconName: 'eye', label: 'Show password' })}</div>
      ${error ? `<p class="field__helper t-footnote" id="${ids}-h">${icon('circle-alert', 'icon--sm')}<span>${esc(error)}</span></p>` : helper ? `<p class="field__helper t-footnote" id="${ids}-h">${helper}</p>` : ''}
    </div>`;

  const orDivider = () => `<div class="or" role="separator"><span class="t-footnote c-tertiary">or</span></div>`;

  Object.assign(QL.ui, {
    listRow,
    listGroup,
    avatar,
    radioRow,
    achievementCard,
    wizardTop,
    footer,
    templateCard,
    questXp,
    questSummary,
    suggestionRow,
    barChart,
    lineChart,
    monthCalendar,
    emptyState,
    notice,
    confetti,
    levelUp,
    unlocked,
    RANK_REASON,
    shareCard,
    appIcon,
    notification,
    passwordField,
    orDivider,
    widgetSmall,
    widgetMedium,
    lockWidgets,
  });
})(window.QL);
