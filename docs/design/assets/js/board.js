/* Board runtime: renders screens into device frames, applies the review toolbar (text size, platform,
   motion, frame length, annotation pins) and wires the frames' interactions. */
window.QL = window.QL || {};

(function (QL) {
  const media = (q) => window.matchMedia(q).matches;
  const settings = {
    ts: 1,
    platform: 'ios',
    motion: media('(prefers-reduced-motion: reduce)') ? 'reduced' : 'full',
    contrast: media('(prefers-contrast: more)') ? 'more' : 'standard',
    transparency: media('(prefers-reduced-transparency: reduce)') ? 'reduced' : 'standard',
    length: 'viewport',
    annos: 'on',
  };
  const frames = [];
  let frameCount = 0;

  const setting = (f, key) => (f.spec.fixed && f.spec.fixed[key] !== undefined ? f.spec.fixed[key] : settings[key]);
  const overlayOpen = (ctx) => !!(ctx.sheet || ctx.menu || ctx.dialog || ctx.hasOverlay);

  /* Applies text size, platform, motion, contrast and transparency to a frame's device or a static specimen panel.
     A specimen can pin its platform with data-fixed-platform (e.g. an iOS and an Android dialog side by side). */
  const applyScope = (el, { ts, platform, motion, contrast, transparency }) => {
    el.style.setProperty('--ts', ts);
    el.dataset.text = ts >= 1.5 ? 'ax' : 'default';
    el.dataset.platform = el.dataset.fixedPlatform || platform;
    el.dataset.contrast = contrast;
    el.dataset.transparency = transparency;
    el.classList.toggle('reduce-motion', motion === 'reduced');
  };

  const applySettings = (f) => {
    applyScope(f.device, { ts: setting(f, 'ts'), platform: setting(f, 'platform'), motion: setting(f, 'motion'), contrast: setting(f, 'contrast'), transparency: setting(f, 'transparency') });
    f.device.classList.toggle('device--full', setting(f, 'length') === 'full' && !overlayOpen(f.ctx));
  };

  const placePins = (f) => {
    const layer = f.annos;
    layer.textContent = '';
    const dRect = f.device.getBoundingClientRect();
    if (f.device.classList.contains('device--full') && f.screen.offsetHeight > 900) {
      const fold = document.createElement('div');
      fold.className = 'fold-line';
      fold.setAttribute('aria-hidden', 'true');
      fold.style.top = `${f.screen.offsetTop + 844}px`;
      fold.innerHTML = '<span>Fold · 390 × 844 pt</span>';
      layer.appendChild(fold);
    }
    if (settings.annos !== 'on' || !f.spec.pins) return;
    const sRect = f.screen.getBoundingClientRect();
    // Pins sit in the left gutter, beside the element, and never on top of a sticky tab bar.
    const tabbar = f.device.classList.contains('device--full') ? null : f.screen.querySelector('.tabbar');
    const bottom = tabbar ? tabbar.getBoundingClientRect().top : sRect.bottom;
    const map = f.spec.pinMap || {};
    const only = f.spec.pinsOnly;
    f.screen.querySelectorAll('[data-anno]').forEach((el) => {
      const r = el.getBoundingClientRect();
      const isTabbar = el.classList.contains('tabbar');
      if (only && !only.includes(Number(el.dataset.anno))) return;
      // Inside a sheet, content scrolled under its sticky footer is out of view.
      const sheet = el.closest('.sheet');
      const sheetFooter = sheet && sheet.querySelector('.sheet__footer--sticky');
      const limit = sheetFooter && !sheetFooter.contains(el) ? sheetFooter.getBoundingClientRect().top : bottom;
      if (!r.height || r.top < sRect.top - 4 || (!isTabbar && r.top > limit - 16)) return;
      const pin = document.createElement('span');
      pin.className = 'anno-pin';
      pin.setAttribute('aria-hidden', 'true');
      pin.textContent = map[el.dataset.anno] ?? el.dataset.anno;
      pin.style.left = `${Math.max(7, r.left - dRect.left - 14)}px`;
      pin.style.top = `${r.top - dRect.top + 14}px`;
      layer.appendChild(pin);
    });
  };

  const focusKey = (el) => (el && el.dataset ? `${el.dataset.action || ''}|${el.dataset.quest || ''}|${el.dataset.value || ''}` : '');
  /* The same control, or — when its state changed (check ↔ undo) — the control of the same quest. */
  const findByKey = (root, key) => {
    const all = [...root.querySelectorAll('[data-action]')];
    const exact = all.find((el) => focusKey(el) === key);
    const quest = key.split('|')[1];
    return exact || (quest ? all.find((el) => el.dataset.quest === quest) : undefined);
  };

  const render = (f, { focus = '', autofocus = false } = {}) => {
    const wasFull = f.device.classList.contains('device--full');
    f.ctx.platform = setting(f, 'platform');
    const out = QL.screens[f.spec.screen](f.ctx);
    f.ctx.hasOverlay = !!(out.overlay && out.overlay.trim());
    f.scroll.innerHTML = QL.ui.statusBar(setting(f, 'platform'), f.spec.time) + out.body;
    f.overlay.innerHTML = out.overlay || '';
    applySettings(f);
    f.screen.classList.toggle('has-tabbar', !!f.scroll.querySelector('.tabbar'));
    f.screen.classList.toggle('is-scrolled', f.scroll.scrollTop > 4);
    // An overlay opened in a full-length frame shows in a phone-sized viewport scrolled to its trigger.
    if (wasFull && !f.device.classList.contains('device--full') && f.triggerTop !== undefined) {
      f.scroll.scrollTop = Math.max(0, f.triggerTop - 420);
    }
    f.ctx.justDone = null;
    f.ctx.justCompleted = null;
    f.ctx.xpGain = 0;
    // Focus moves only after the reviewer interacted with this frame, never on page load or a toolbar change.
    const modal = autofocus ? f.overlay.querySelector('[role="alertdialog"], [role="dialog"], [role="menu"]') : null;
    if (modal) {
      const first = modal.querySelector('[data-autofocus]') || modal.querySelector('button, input, textarea');
      if (first) first.focus({ preventScroll: true });
    } else if (focus) {
      const match = findByKey(f.el, focus);
      if (match) match.focus({ preventScroll: true });
    }
    requestAnimationFrame(() => placePins(f));
  };

  const scheduleSnackDismiss = (f) => {
    const snack = f.ctx.snack;
    clearTimeout(f.snackTimer);
    f.snackTimer = setTimeout(() => {
      if (f.ctx.snack === snack) {
        f.ctx.snack = null;
        const active = f.el.contains(document.activeElement) ? focusKey(document.activeElement) : '';
        render(f, { focus: active });
      }
    }, 6000);
  };

  const closeOverlays = (f) => {
    f.ctx.menu = false;
    f.ctx.dialog = null;
    f.ctx.sheet = null;
    f.ctx.summary = false;
    render(f, { focus: f.returnFocus, autofocus: true });
  };

  const handle = (f, action, target) => {
    const ctx = f.ctx;
    const key = target.dataset.quest;
    const own = focusKey(target);
    let focus = own;
    if (['check', 'menu', 'summary'].includes(action)) {
      f.returnFocus = own;
      f.triggerTop = target.getBoundingClientRect().top - f.screen.getBoundingClientRect().top;
    }
    switch (action) {
      case 'summary':
        ctx.summary = true;
        break;
      case 'check':
        QL.actions.checkIn(ctx, key);
        break;
      case 'undo':
        QL.actions.undoQuest(ctx, key);
        break;
      case 'undo-last':
        QL.actions.undo(ctx);
        focus = '';
        break;
      case 'confirm-check-in':
        QL.actions.confirmSheet(ctx, key);
        focus = f.returnFocus;
        break;
      case 'reveal':
        ctx.revealed = true;
        focus = 'hide-private||';
        break;
      case 'hide-private':
        ctx.revealed = false;
        focus = 'reveal||';
        break;
      case 'view':
        ctx.view = target.dataset.value;
        break;
      case 'menu':
        ctx.menu = !ctx.menu;
        break;
      case 'pause':
        ctx.menu = false;
        ctx.dialog = 'pause';
        break;
      case 'close-overlay':
      case 'close-sheet':
        closeOverlays(f);
        return;
      default:
        return;
    }
    render(f, { focus, autofocus: true });
    if (ctx.snack) scheduleSnackDismiss(f);
  };

  const describeFixed = (fixed = {}) =>
    [fixed.ts ? `text ${Math.round(fixed.ts * 100)} %` : '', fixed.platform === 'android' ? 'Android' : '', fixed.length === 'full' ? 'full length' : '']
      .filter(Boolean)
      .join(', ');

  const mount = (container, specs, { annotations } = {}) => {
    const framesEl = document.createElement('div');
    framesEl.className = 'frames';
    const mounted = specs.map((spec) => {
      frameCount += 1;
      const fixedText = describeFixed(spec.fixed);
      const meta = [spec.meta, fixedText ? `fixed: ${fixedText}` : ''].filter(Boolean).join(' · ');
      const fig = document.createElement('figure');
      fig.className = 'frame';
      fig.id = spec.id;
      fig.innerHTML = `
        <figcaption class="frame__caption"><span class="frame__name">${spec.title}</span><span class="frame__meta">${meta}</span></figcaption>
        <div class="device ts-scope" data-theme="${spec.theme}" role="region" aria-label="Mock-up: ${spec.title}, ${meta}">
          <div class="device__screen">
            <div class="device__scroll"></div>
            <div class="device__overlay"></div>
            <div class="home-indicator" aria-hidden="true"></div>
          </div>
          <div class="device__annos"></div>
        </div>`;
      framesEl.appendChild(fig);
      const seeded = QL.data.seed();
      const f = {
        spec: { pins: true, ...spec },
        el: fig,
        device: fig.querySelector('.device'),
        screen: fig.querySelector('.device__screen'),
        scroll: fig.querySelector('.device__scroll'),
        overlay: fig.querySelector('.device__overlay'),
        annos: fig.querySelector('.device__annos'),
        ctx: { state: seeded, ...(spec.ctx || {}), label: `${spec.title} ${meta}`.trim(), ids: `f${frameCount}` },
      };
      if (spec.before) spec.before(f.ctx);
      fig.addEventListener('click', (e) => {
        const t = e.target.closest('[data-action]');
        if (t && fig.contains(t)) {
          e.preventDefault();
          handle(f, t.dataset.action, t);
          return;
        }
        if (e.target.closest('a[href="#"]')) e.preventDefault();
      });
      fig.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlayOpen(f.ctx)) {
          e.preventDefault();
          closeOverlays(f);
        }
      });
      let ticking = false;
      f.scroll.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          f.screen.classList.toggle('is-scrolled', f.scroll.scrollTop > 4);
          placePins(f);
        });
      });
      frames.push(f);
      return f;
    });

    container.appendChild(framesEl);
    if (annotations && QL.annotations[annotations]) {
      const panel = document.createElement('aside');
      panel.className = 'anno-panel';
      panel.setAttribute('aria-label', `Developer notes: ${specs[0].title}`);
      panel.innerHTML = `<p class="anno-panel__title">Developer notes</p><ol>${QL.annotations[annotations]
        .map(([title, text], i) => `<li><span class="anno-pin" aria-hidden="true">${i + 1}</span><div><strong>${title}</strong>${text}</div></li>`)
        .join('')}</ol>`;
      container.appendChild(panel);
    }
    mounted.forEach((f) => render(f));
  };

  const refreshStatic = () =>
    document.querySelectorAll('.ts-scope[data-static]').forEach((el) => applyScope(el, settings));

  const TOOLBAR = {
    ts: ['Text size', [['1', '100 %'], ['1.5', '150 %'], ['2', '200 %']]],
    platform: ['Platform', [['ios', 'iOS'], ['android', 'Android']]],
    motion: ['Motion', [['full', 'Full'], ['reduced', 'Reduced']]],
    contrast: ['Contrast', [['standard', 'Standard'], ['more', 'Increased']]],
    transparency: ['Transparency', [['standard', 'Standard'], ['reduced', 'Reduced']]],
    length: ['Frames', [['viewport', 'Phone viewport'], ['full', 'Full length']]],
    annos: ['Notes', [['on', 'Pins on'], ['off', 'Pins off']]],
  };

  const toolbar = (el, keys = Object.keys(TOOLBAR)) => {
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Review settings');
    el.innerHTML = keys
      .map((key) => {
        const [label, options] = TOOLBAR[key];
        return `<div class="toolbar__group"><span class="toolbar__label" id="tb-${key}">${label}</span>
          <div class="seg" role="group" aria-labelledby="tb-${key}">${options
            .map(([value, text]) => `<button type="button" class="seg__btn" data-setting="${key}" data-value="${value}" aria-pressed="${String(settings[key]) === value}">${text}</button>`)
            .join('')}</div></div>`;
      })
      .join('');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-setting]');
      if (!b) return;
      const key = b.dataset.setting;
      settings[key] = key === 'ts' ? Number(b.dataset.value) : b.dataset.value;
      el.querySelectorAll(`[data-setting="${key}"]`).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      frames.forEach((f) => render(f));
      refreshStatic();
    });
    refreshStatic();
  };

  window.addEventListener('resize', () => frames.forEach(placePins));
  if (document.fonts) document.fonts.ready.then(() => frames.forEach(placePins));

  QL.board = { mount, toolbar, settings, refreshStatic };
})(window.QL);
