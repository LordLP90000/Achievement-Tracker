/* Clickable prototype of the main flow: create achievement → add quests → check in → quest complete → achievement
   unlocked (→ level up → share card). One device, a small navigation stack, the same screens as the boards. */
(function (QL) {
  const { ui, data, story } = QL;
  const S = QL.screens;

  const media = (q) => window.matchMedia(q).matches;
  const settings = {
    theme: 'light',
    ts: 1,
    platform: 'ios',
    motion: media('(prefers-reduced-motion: reduce)') ? 'reduced' : 'full',
    contrast: media('(prefers-contrast: more)') ? 'more' : 'standard',
    transparency: media('(prefers-reduced-transparency: reduce)') ? 'reduced' : 'standard',
  };
  const device = document.getElementById('device');
  const scroll = document.getElementById('scroll');
  const overlayEl = document.getElementById('overlay');
  const screenEl = scroll.parentElement;
  scroll.addEventListener('scroll', () => screenEl.classList.toggle('is-scrolled', scroll.scrollTop > 4), { passive: true });
  const hint = document.getElementById('hint');
  const stepsEl = document.getElementById('steps');

  const STEPS = [
    ['Create an achievement', 'Tap <strong>+</strong> at the top right (on Android: <strong>New achievement</strong>).'],
    ['Name it, pick a template', 'Tap the field to type a title, pick <strong>Start running</strong>, then <strong>Next</strong>.'],
    ['Why and when', 'Tap the fields to fill them (or <strong>Skip</strong>), then <strong>Next</strong>.'],
    ['Add your own quest', 'Tap <strong>Add your own quest</strong>, then <strong>Add quest</strong> in the sheet. Then <strong>Next</strong>.'],
    ['Privacy & reminders', 'Try the switches, then <strong>Create achievement</strong>.'],
    ['Check in a quest', 'Tap <strong>Check in</strong> on “Buy running shoes”.'],
    ['Skip ahead to race day', 'Five weeks pass: the habit and the 8 km are done. Tap <strong>Continue</strong>.'],
    ['Check in the race', 'Tap <strong>Check in</strong> on “Run the Silvesterlauf”.'],
    ['Celebrate and share', 'Continue through the celebrations; make a share card if you like. That’s the flow — explore the tabs or restart.'],
  ];

  let P;
  const fresh = () => {
    const seeded = data.seed();
    return {
      route: 'today',
      stack: [],
      step: 0,
      wiz: null,
      overlay: null,
      snack: null,
      time: '18:40',
      ctx: { state: seeded, ids: 'pr', label: 'Prototype', dateIso: data.TODAY },
    };
  };

  const newWizard = () => ({ template: null, title: '', category: null, why: '', date: null, quests: [], private: false, hideNumbers: false, reminders: true, reminderTime: '18:30', error: '' });
  const applyTemplate = (w) => {
    const t = data.templates[0];
    w.template = t.id;
    w.category = t.category;
    if (!w.title) w.title = 'Run my first race';
    w.quests = JSON.parse(JSON.stringify(t.quests));
  };
  const ownQuest = () => ({ id: 'final', title: 'Run the Silvesterlauf', type: 'one_time', size: 'L', on: true, own: true, after: 'eightk' });

  /* The race achievement as the backend would return it, with what the user entered in the wizard. */
  const raceFor = (phase) => {
    const a = story.race(phase);
    const w = P.wiz || {};
    if (w.title) a.title = w.title;
    a.why = w.why || '';
    a.targetDate = w.date || a.targetDate;
    a.isPrivate = !!w.private;
    a.hideNumbers = !!w.hideNumbers;
    if (w.quests && w.quests.length) a.quests = a.quests.filter((q) => q.id === 'final' || w.quests.some((x) => x.id === q.id && x.on));
    return a;
  };

  const setRace = (phase) => {
    const list = P.ctx.state.achievements.filter((a) => a.id !== 'race');
    list.push(raceFor(phase));
    P.ctx.state.achievements = data.derive(list);
  };

  const setUser = (xp) => {
    const levels = [0, 100, 300, 900, 2700, 8100, 24300, 72900];
    const level = levels.findLastIndex((t) => t <= xp) + 1;
    Object.assign(P.ctx.state.user, { xp, level, levelFloor: levels[level - 1], nextLevelAt: levels[level] });
  };

  /* ───────── Rendering ───────── */
  const skipScreen = () => `<div class="screen"><div class="onb" style="justify-content:center;text-align:center">
      <p class="t-overline c-accent">Prototype · time skip</p>
      <h1 class="t-large-title" style="margin-top:8px">Five weeks later</h1>
      <p class="t-callout c-secondary" style="margin-top:8px">Sunday, 13.12.2026 — race day</p>
      <ul class="lgroup__list" style="margin-top:28px;text-align:left">
        <li><div class="lrow"><span class="lrow__icon lrow__icon--done" aria-hidden="true">${ui.icon('check')}</span><span class="lrow__body"><span class="lrow__label t-callout">Run 3× a week</span><span class="lrow__sub t-footnote">4 weeks, 12 runs · done 06.12.</span></span></div></li>
        <li><div class="lrow"><span class="lrow__icon lrow__icon--done" aria-hidden="true">${ui.icon('check')}</span><span class="lrow__body"><span class="lrow__label t-callout">Run 8 km without stopping</span><span class="lrow__sub t-footnote">8 km on 10.12.</span></span></div></li>
        <li><div class="lrow"><span class="lrow__icon lrow__icon--bonus" aria-hidden="true">${ui.icon('star')}</span><span class="lrow__body"><span class="lrow__label t-callout">Find a running buddy</span><span class="lrow__sub t-footnote">Bonus — still open, and that’s fine</span></span></div></li>
      </ul>
      <div class="onb__actions">${ui.button({ label: 'Continue', size: 'lg', block: true, extra: { 'data-action': 'skip-continue' } })}</div>
    </div></div>`;

  const celebrateToast = (title, xp) => `<div class="snackbar snackbar--floating snackbar--celebrate" role="status" aria-live="polite">
      <span class="snackbar__burst" aria-hidden="true">${ui.icon('sparkles')}</span>
      <p class="snackbar__text t-subhead"><strong>Quest complete · +${xp} XP</strong><br>${ui.esc(title)}</p>
      <button type="button" class="snackbar__action" data-action="proto-undo">Undo</button>
    </div>`;

  const render = ({ navigated = false, direction = 'push' } = {}) => {
    const ctx = P.ctx;
    ctx.platform = settings.platform;
    ctx.wiz = P.wiz;
    let out;
    if (P.route === 'skip') out = { body: skipScreen() };
    else out = S[P.route](ctx);
    scroll.innerHTML = ui.statusBar(settings.platform, P.time) + out.body;
    let extra = '';
    if (P.overlay === 'unlock') {
      const a = data.byId('race', ctx.state.achievements);
      extra = ui.unlocked({ a, rank: 'diamond', questXp: a.xpTotal, bonus: story.STORY.bonus, days: story.STORY.days, motion: settings.motion === 'full' });
    } else if (P.overlay === 'levelup') {
      extra = ui.levelUp({ from: 3, to: P.ctx.state.user.level, xp: P.ctx.state.user.xp, toNext: P.ctx.state.user.nextLevelAt - P.ctx.state.user.xp });
    }
    if (P.snack) extra += P.snack.celebrate ? celebrateToast(P.snack.title, P.snack.xp) : ui.snackbar({ text: P.snack.text, iconName: P.snack.icon || 'circle-check', action: P.snack.action || '', floating: true, extra: { 'data-action': 'proto-undo' } });
    overlayEl.innerHTML = (out.overlay || '') + extra;
    applySettings();
    screenEl.classList.toggle('has-tabbar', !!scroll.querySelector('.tabbar'));
    ctx.justDone = null;
    ctx.justCompleted = null;
    if (navigated) {
      const screen = scroll.querySelector('.screen');
      if (screen) screen.classList.add(`screen--${direction}`);
      scroll.scrollTop = 0;
      screenEl.classList.remove('is-scrolled');
      const h = scroll.querySelector('h1') || scroll.querySelector('.navbar__title');
      if (h) {
        h.setAttribute('tabindex', '-1');
        h.focus({ preventScroll: true });
      }
    }
    const modal = overlayEl.querySelector('[role="dialog"], [role="alertdialog"]');
    if (modal) {
      const first = modal.querySelector('[data-autofocus]') || modal.querySelector('button, input');
      if (first) first.focus({ preventScroll: true });
    }
    renderSteps();
  };

  const applySettings = () => {
    device.dataset.theme = settings.theme;
    device.style.setProperty('--ts', settings.ts);
    device.dataset.text = settings.ts >= 1.5 ? 'ax' : 'default';
    device.dataset.platform = settings.platform;
    device.dataset.contrast = settings.contrast;
    device.dataset.transparency = settings.transparency;
    device.classList.toggle('reduce-motion', settings.motion === 'reduced');
  };

  const renderSteps = () => {
    stepsEl.innerHTML = STEPS.map(
      ([title], i) => `<li><button type="button" class="proto-step ${i === P.step ? 'is-current' : ''} ${i < P.step ? 'is-done' : ''}" data-goto="${i}"${i === P.step ? ' aria-current="step"' : ''}>
        <span class="proto-step__n" aria-hidden="true">${i < P.step ? ui.icon('check', 'icon--sm') : i + 1}</span><span>${title}</span></button></li>`,
    ).join('');
    const skip = P.step === 6 && P.route !== 'skip' ? `<button type="button" class="btn btn--primary btn--sm" data-proto="skip" style="margin-top:12px">${ui.icon('arrow-right')}<span>Skip ahead to race day</span></button>` : '';
    hint.innerHTML = `<strong>Step ${P.step + 1}:</strong> ${STEPS[P.step][1]}${skip}`;
  };

  /* ───────── Navigation ───────── */
  const go = (route, { push = true, direction = 'push' } = {}) => {
    if (push) P.stack.push(P.route);
    P.route = route;
    render({ navigated: true, direction });
  };
  const back = () => {
    const prev = P.stack.pop();
    if (prev) {
      P.route = prev;
      render({ navigated: true, direction: 'pop' });
    }
  };
  const tab = (name) => {
    if (name === 'create') {
      P.wiz = newWizard();
      P.stack = [P.route];
      P.route = 'wizard1';
      if (P.step === 0) P.step = 1;
      render({ navigated: true, direction: 'modal' });
      return;
    }
    P.stack = [];
    P.route = { today: 'today', achievements: 'achievements', stats: 'stats', profile: 'profile' }[name] || 'today';
    render({ navigated: true, direction: 'fade' });
  };

  let snackTimer;
  const flash = (snack, ms = 5000) => {
    P.snack = snack;
    clearTimeout(snackTimer);
    snackTimer = setTimeout(() => {
      P.snack = null;
      render();
    }, ms);
  };

  const create = () => {
    setRace('created');
    P.ctx.achievementId = 'race';
    P.ctx.view = 'path';
    P.stack = ['today'];
    P.route = 'detail';
    P.step = 5;
    flash({ text: 'Achievement created', icon: 'flag' }, 3500);
    render({ navigated: true, direction: 'fade' });
  };

  const raceDay = () => {
    setRace('raceday');
    setUser(story.STORY.xp.raceMorning);
    P.time = '13:20';
    P.ctx.dateIso = story.STORY.raceDay;
    P.ctx.achievementId = 'race';
    P.stack = ['today'];
    P.route = 'detail';
    P.step = 7;
    render({ navigated: true, direction: 'fade' });
  };

  const unlock = () => {
    setRace('unlocked');
    setUser(story.STORY.xp.afterRace);
    P.overlay = 'unlock';
    P.step = 8;
    render();
    setUser(story.STORY.xp.unlocked);
  };

  /* Jump to a step from the side list: rebuild the state the flow would have at that point. */
  const goto = (i) => {
    clearTimeout(snackTimer);
    P = fresh();
    if (i >= 1) {
      P.wiz = newWizard();
      P.stack = ['today'];
      P.route = 'wizard1';
      P.step = 1;
    }
    if (i >= 2) {
      applyTemplate(P.wiz);
      P.wiz.title = 'Run the Silvesterlauf';
      P.route = 'wizard2';
      P.step = 2;
    }
    if (i >= 3) {
      Object.assign(P.wiz, { why: 'Run through the old town with my sister.', date: story.STORY.raceDay });
      P.route = 'wizard3';
      P.step = 3;
    }
    if (i >= 4) {
      P.wiz.quests.push(ownQuest());
      P.route = 'wizard4';
      P.step = 4;
    }
    if (i >= 5) {
      setRace('created');
      P.ctx.achievementId = 'race';
      P.stack = ['today'];
      P.route = 'detail';
      P.step = 5;
    }
    if (i >= 6) {
      setRace('shoes');
      setUser(story.STORY.xp.shoes);
      P.route = 'skip';
      P.step = 6;
    }
    if (i >= 7) {
      raceDay();
      if (i === 7) return;
    }
    if (i >= 8) {
      unlock();
      return;
    }
    render({ navigated: true, direction: 'fade' });
  };

  /* ───────── Interactions ───────── */
  const handle = (action, el) => {
    const w = P.wiz;
    switch (action) {
      case 'tab':
        return tab(el.dataset.tab);
      case 'create':
        return tab('create');
      case 'back':
        return back();
      case 'open-achievement':
        P.ctx.achievementId = el.dataset.achievement;
        return go('detail');
      case 'trophy':
        return go('trophy');
      case 'filter':
        P.ctx.filter = el.dataset.value;
        return render();
      case 'view':
        P.ctx.view = el.dataset.value;
        return render();
      case 'reveal':
        P.ctx.revealed = true;
        return render();
      case 'hide-private':
        P.ctx.revealed = false;
        return render();
      case 'menu':
        P.ctx.menu = !P.ctx.menu;
        return render();
      case 'pause':
        P.ctx.menu = false;
        P.ctx.dialog = 'pause';
        return render();
      case 'close-overlay':
        P.ctx.menu = false;
        P.ctx.dialog = null;
        P.ctx.sheet = null;
        return render();
      // Wizard
      case 'wiz-close':
        P.wiz = null;
        return back();
      case 'wiz-back':
        return back();
      case 'wiz-type':
        w.title = 'Run the Silvesterlauf';
        w.error = '';
        return render();
      case 'wiz-type-why':
        w.why = 'Run through the old town with my sister.';
        return render();
      case 'wiz-date':
        w.date = story.STORY.raceDay;
        return render();
      case 'wiz-template':
        applyTemplate(w);
        return render();
      case 'wiz-category':
        w.category = el.dataset.value;
        return render();
      case 'wiz-toggle': {
        const q = w.quests.find((x) => x.id === el.dataset.value);
        if (q) q.on = !q.on;
        return render();
      }
      case 'wiz-add-quest':
        P.ctx.sheetQuest = { mode: 'add', quest: ownQuest(), prereqTitle: 'Run 8 km without stopping', reminder: true };
        return render();
      case 'sheet-save':
        if (!w.quests.some((q) => q.id === 'final')) w.quests.push(ownQuest());
        P.ctx.sheetQuest = null;
        if (P.step === 3) P.step = 3;
        flash({ text: 'Quest added', icon: 'circle-plus' }, 2500);
        return render();
      case 'close-sheet':
        P.ctx.sheetQuest = null;
        P.ctx.sheet = null;
        return render();
      case 'wiz-next':
      case 'wiz-skip': {
        const n = Number(P.route.slice(-1));
        if (n === 1 && !w.title) {
          w.error = 'Give your achievement a name.';
          return render();
        }
        if (n === 3 && !w.quests.length) applyTemplate(w);
        P.step = Math.max(P.step, n + 1);
        return go(`wizard${n + 1}`);
      }
      case 'wiz-create':
        return create();
      // Check-ins
      case 'check': {
        const key = el.dataset.quest;
        const [aid, qid] = key.split('/');
        const q = data.quest(aid, qid, P.ctx.state.achievements);
        if (q.type === 'target') {
          P.ctx.sheet = key;
          return render();
        }
        QL.actions.checkIn(P.ctx, key);
        P.ctx.snack = null;
        if (aid === 'race' && qid === 'final') return unlock();
        if (q.state === 'completed') {
          flash({ celebrate: true, title: q.title, xp: q.xp });
          if (aid === 'race' && qid === 'shoes') P.step = 6;
        } else flash({ text: `Checked in · ${ui.esc(q.title)}`, action: 'Undo' });
        return render();
      }
      case 'confirm-check-in':
        QL.actions.confirmSheet(P.ctx, el.dataset.quest);
        P.ctx.snack = null;
        flash({ text: 'Check-in saved', action: 'Undo' });
        return render();
      case 'undo':
        QL.actions.undoQuest(P.ctx, el.dataset.quest);
        P.ctx.snack = null;
        flash({ text: 'Check-in undone', icon: 'undo-2' }, 2500);
        return render();
      case 'proto-undo':
        QL.actions.undo(P.ctx);
        P.ctx.snack = null;
        if (P.step === 6) P.step = 5;
        flash({ text: 'Check-in undone', icon: 'undo-2' }, 2500);
        return render();
      case 'skip-continue':
        return raceDay();
      // Celebrations
      case 'unlock-continue':
        P.overlay = 'levelup';
        return render();
      case 'levelup-continue':
        P.overlay = null;
        P.route = 'detail';
        return render();
      case 'open-share':
        P.overlay = null;
        P.ctx.share = { title: !data.byId('race', P.ctx.state.achievements).isPrivate };
        return go('share', { direction: 'modal' });
      case 'share-close':
        P.stack = ['today'];
        P.route = 'detail';
        return render({ navigated: true, direction: 'pop' });
      case 'share-send':
        flash({ text: 'Opens the share sheet — the card goes only where you send it.', icon: 'share' }, 3500);
        return render();
      default:
        if (action.startsWith('share-')) {
          const k = action.slice(6);
          P.ctx.share = { ...(P.ctx.share || {}), [k]: !(P.ctx.share && k in P.ctx.share ? P.ctx.share[k] : ['title', 'badge', 'date'].includes(k)) };
          return render();
        }
    }
    return undefined;
  };

  device.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el && device.contains(el)) {
      e.preventDefault();
      handle(el.dataset.action, el);
      return;
    }
    // Fields in the wizard “type” their example text when tapped.
    const field = e.target.closest('.field__control');
    if (field && P.wiz) {
      const label = field.closest('.field')?.querySelector('.field__label')?.textContent || '';
      if (/^Achievement/.test(label)) return handle('wiz-type', field);
      if (/^Why it matters/.test(label)) return handle('wiz-type-why', field);
      if (/^Target date/.test(label)) return handle('wiz-date', field);
    }
    // Switches, radios and plain checkboxes toggle in place.
    const sw = e.target.closest('[role="switch"], [role="checkbox"]');
    if (sw) {
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(on));
      const thumb = sw.querySelector('.switch__thumb');
      if (thumb) thumb.innerHTML = on ? ui.icon('check') : '';
      if (P.wiz && /Private achievement/.test(sw.getAttribute('aria-labelledby') ? document.getElementById(sw.getAttribute('aria-labelledby')).textContent : '')) P.wiz.private = on;
      return;
    }
    const radio = e.target.closest('[role="radio"]');
    if (radio) {
      radio.closest('[role="radiogroup"], ul')?.querySelectorAll('[role="radio"]').forEach((r) => r.setAttribute('aria-checked', String(r === radio)));
      return;
    }
    if (e.target.closest('a[href="#"]')) e.preventDefault();
  });

  device.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (P.ctx.sheetQuest || P.ctx.sheet || P.ctx.menu || P.ctx.dialog) handle('close-overlay', device);
    P.ctx.sheetQuest = null;
    render();
  });

  stepsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (b) goto(Number(b.dataset.goto));
  });

  document.getElementById('restart').addEventListener('click', () => goto(0));
  hint.addEventListener('click', (e) => {
    if (e.target.closest('[data-proto="skip"]')) {
      P.stack = ['today'];
      go('skip', { push: false, direction: 'fade' });
    }
  });

  /* Prototype settings */
  const OPTIONS = {
    theme: ['Phone appearance', [['light', 'Light'], ['dark', 'Dark']]],
    ts: ['Text size', [['1', '100 %'], ['1.5', '150 %'], ['2', '200 %']]],
    platform: ['Platform', [['ios', 'iOS'], ['android', 'Android']]],
    motion: ['Motion', [['full', 'Full'], ['reduced', 'Reduced']]],
    contrast: ['Contrast', [['standard', 'Standard'], ['more', 'Increased']]],
    transparency: ['Transparency', [['standard', 'Standard'], ['reduced', 'Reduced']]],
  };
  const panel = document.getElementById('proto-settings');
  panel.innerHTML = Object.entries(OPTIONS)
    .map(
      ([key, [label, opts]]) => `<div class="toolbar__group"><span class="toolbar__label" id="ps-${key}">${label}</span><div class="seg" role="group" aria-labelledby="ps-${key}">${opts
        .map(([v, t]) => `<button type="button" class="seg__btn" data-set="${key}" data-value="${v}" aria-pressed="${String(settings[key]) === v}">${t}</button>`)
        .join('')}</div></div>`,
    )
    .join('');
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-set]');
    if (!b) return;
    const key = b.dataset.set;
    settings[key] = key === 'ts' ? Number(b.dataset.value) : b.dataset.value;
    panel.querySelectorAll(`[data-set="${key}"]`).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    render();
  });

  P = fresh();
  render();
  QL.proto = { goto, state: () => P };
})(window.QL);
