/* Renders the design-system page from the tokens (tokens.js, generated from tokens.json) and the components
   (ui.js). Every specimen is shown in the light and the dark theme; the toolbar applies text size, platform
   and motion to all of them. */
(function (QL) {
  const { ui, data, fmt } = QL;
  const { icon, esc } = ui;

  const S = data.seed();
  const A = (id) => data.byId(id, S.achievements);
  const Q = (aid, qid) => A(aid).quests.find((q) => q.id === qid);
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* ───────── Layout helpers ───────── */
  const section = (id, title, intro, content) =>
    `<section class="ds-section" id="${id}" aria-labelledby="${id}-h">
      <h2 class="ds-h2" id="${id}-h">${title}</h2>
      ${intro ? `<p class="ds-intro">${intro}</p>` : ''}
      ${content}
    </section>`;

  const sub = (title, note, content, id = '') =>
    `<div class="ds-sub"${id ? ` id="${id}"` : ''}><h3 class="ds-h3">${title}</h3>${note ? `<p class="ds-note">${note}</p>` : ''}${content}</div>`;

  const panel = (theme, html, { width = 390, wide = false } = {}) =>
    `<div class="spec ts-scope${wide ? ' spec--wide' : ''}" data-static data-theme="${theme}" style="--spec-w:${width}px">
      <p class="spec__theme">${theme === 'light' ? 'Light' : 'Dark'}</p>
      <div class="spec__body">${html}</div>
    </div>`;

  const pair = (render, opts = {}) => `<div class="spec-pair">${panel('light', render('light'), opts)}${panel('dark', render('dark'), opts)}</div>`;

  const item = (label, html, note = '') =>
    `<div class="spec-item"><p class="spec-item__label">${label}</p>${html}${note ? `<p class="spec-item__note">${note}</p>` : ''}</div>`;

  const row = (...parts) => `<div class="spec-row">${parts.join('')}</div>`;

  const table = (head, rows, cls = '') =>
    `<div class="ds-table-wrap"><table class="ds-table ${cls}"><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;

  const passMark = (ok, ratio) =>
    `<span class="ds-pass ${ok ? 'is-pass' : 'is-fail'}">${icon(ok ? 'circle-check' : 'circle-alert', 'icon--sm')}<span class="tnum">${ratio.toFixed(2)}:1</span><span class="sr-only">${ok ? 'passes' : 'fails'}</span></span>`;

  /* ───────── Foundations: colour ───────── */
  const primitives = Object.entries(QL.TOKENS.color)
    .map(([name, group]) => {
      const swatches = Object.entries(group)
        .filter(([k]) => !k.startsWith('$'))
        .map(([k, v]) => `<li class="swatch"><span class="swatch__chip" style="background:${v.$value}"></span><span class="swatch__name">${name}-${k}</span><span class="swatch__hex">${v.$value}</span></li>`)
        .join('');
      return `<div class="ramp"><h4 class="ramp__name">${name}${group.$description ? ` <span class="ramp__desc">${esc(group.$description)}</span>` : ''}</h4><ul class="ramp__list">${swatches}</ul></div>`;
    })
    .join('');

  const ROLES = {
    'bg-canvas': 'Screen background',
    'bg-surface': 'Cards and list rows',
    'bg-surface-raised': 'Sheets, dialogs and menus (lighter than cards in dark mode)',
    'bg-muted': 'Quiet fills: locked cards, secondary buttons, segmented controls',
    'bg-inverse': 'Snackbars',
    'bg-scrim': 'Behind sheets and dialogs',
    'border-subtle': 'Dividers and chip outlines (decorative only)',
    'border-strong': 'Outlines of inputs and controls (≥ 3:1)',
    'border-hairline': 'Edge of cards',
    'text-primary': 'Titles and body text',
    'text-secondary': 'Supporting text',
    'text-tertiary': 'Metadata and captions (still ≥ 4.5:1)',
    'text-disabled': 'Disabled labels (exempt from contrast, always with a disabled state)',
    'text-inverse': 'Text on snackbars',
    'text-accent': 'Text buttons, links, accent numbers',
    'text-on-primary': 'Label and icon on the primary button',
    'action-primary': 'The one primary action of a screen',
    'action-primary-pressed': 'Primary button while pressed',
    'action-secondary': 'Secondary buttons and tonal icon buttons',
    'action-secondary-pressed': 'Secondary button while pressed',
    'action-on-secondary': 'Label on secondary buttons',
    'action-inverse-accent': 'Action in a snackbar (Undo)',
    'action-disabled': 'Disabled button fill',
    'focus-ring': 'Focus indicator, 3 px (≥ 3:1)',
    'progress-fill': 'Progress rings and bars, the walked part of the quest path',
    'progress-track': 'Empty part of rings and bars',
    'progress-glow': 'Halo around today and the current quest node',
  };
  const STATE_ROLES = [
    ['state-active', 'Current quest, today, selected (gold)'],
    ['state-done', 'Done: completed quests and check-ins (always with a tick)'],
    ['state-bonus', 'Bonus quests: optional (always with a star)'],
    ['state-locked', 'Locked quests (always with a lock and “Unlocks after …”)'],
    ['state-paused', 'Paused achievement, habit to restart, offline banner'],
    ['state-danger', 'Delete actions and form errors only — never for missed days'],
    ['state-missed', 'A past day without a check-in: hollow and neutral'],
    ['state-upcoming', 'Future days in a week strip'],
    ['state-private', 'Placeholder bars of hidden private content'],
    ['state-streak', 'Flame of a streak'],
  ];
  const roleFor = (name) => ROLES[name] || (STATE_ROLES.find(([p]) => name.startsWith(p)) || [])[1] || '';

  const semanticRows = Object.keys(QL.THEMES.light)
    .filter((name) => !name.startsWith('elevation-'))
    .map((name) => {
      const chip = (theme) => {
        const v = QL.THEMES[theme][name];
        return `<span class="ds-chip"><span class="swatch__chip swatch__chip--sm" style="background:${v}"></span><code>${v}</code></span>`;
      };
      return `<tr><th scope="row"><code>--${name}</code></th><td>${chip('light')}</td><td>${chip('dark')}</td><td>${roleFor(name)}</td></tr>`;
    });

  const contrastPairs = [];
  QL.CONTRAST.forEach((r) => {
    const key = `${r.kind}|${r.fg}|${r.bg}`;
    let entry = contrastPairs.find((p) => p.key === key);
    if (!entry) {
      entry = { key, kind: r.kind, fg: r.fg, bg: r.bg };
      contrastPairs.push(entry);
    }
    entry[r.theme] = r;
  });
  const contrastRows = contrastPairs.map(
    (p) =>
      `<tr><th scope="row"><code>${p.fg}</code> on <code>${p.bg}</code></th><td>${p.kind === 'text' ? 'Text 4.5:1 · 7:1' : 'UI 3:1 · 4.5:1'}</td>${['light', 'dark', 'light-contrast', 'dark-contrast']
        .map((t) => `<td>${passMark(p[t].pass, p[t].ratio)}</td>`)
        .join('')}</tr>`,
  );
  const passCount = QL.CONTRAST.filter((r) => r.pass).length;

  const STATES = [
    ['active', 'Current', 'map-pin', 'The quest you are on; today'],
    ['done', 'Done', 'circle-check', 'Completed quests and check-ins'],
    ['bonus', 'Bonus', 'star', 'Optional; never blocks unlocking'],
    ['locked', 'Locked', 'lock', 'Waits for a previous quest'],
    ['paused', 'Paused', 'pause', 'Paused achievement; habit to restart'],
    ['danger', 'Delete', 'trash-2', 'Destructive actions and errors only'],
  ];
  const stateSpec = () =>
    `<ul class="state-list">${STATES.map(([s, label, ic, text]) => {
      const solid = QL.THEMES.light[`state-${s}-solid`] ? `<span class="swatch__chip swatch__chip--sm" style="background:var(--state-${s}-solid)" title="solid"></span>` : '';
      return `<li class="state-list__row">${ui.tag(label, s === 'active' ? 'active' : s, ic)}<span class="state-list__chips"><span class="swatch__chip swatch__chip--sm" style="background:var(--state-${s}-container)"></span><span class="swatch__chip swatch__chip--sm" style="background:var(--state-${s}-fg)"></span>${solid}</span><span class="t-footnote c-secondary">${text}</span></li>`;
    }).join('')}</ul>`;

  const colour = section(
    'colour',
    'Colour',
    'One accent — <strong>honey</strong> — for progress, the primary action and the current quest. Warm sand neutrals instead of grey. Four semantic state colours (done, bonus, locked, paused) that never stand alone: each comes with an icon and a label. Red is reserved for deleting and for form errors; a missed day is never red.',
    [
      sub('Primitives', 'Raw palette. Components never use these directly.', `<div class="ramps">${primitives}</div>`),
      sub('Quest states', 'Container, foreground and solid colour per state, always paired with an icon and a word.', pair(stateSpec)),
      sub('Semantic tokens', 'What components use. Light and dark have the same names, so a theme switch changes values only.', table(['Token', 'Light', 'Dark', 'Use'], semanticRows)),
      sub(
        'Contrast',
        `Checked by <code>tools/tokens.mjs</code> for both themes (WCAG 2.2 SC 1.4.3 text 4.5:1, SC 1.4.11 non-text 3:1) and for their <strong>Increase Contrast</strong> variants at 7:1 and 4.5:1 (HIG color.md asks for an increased-contrast option of every custom colour): <strong>${passCount} of ${QL.CONTRAST.length} pairs pass</strong>. Large text is held to the same bar. Try “Contrast: Increased” in the toolbar.`,
        table(['Pair', 'Requirement', 'Light', 'Dark', 'Light · increased', 'Dark · increased'], contrastRows),
      ),
    ].join(''),
  );

  /* ───────── Foundations: typography ───────── */
  const SAMPLES = {
    display: 'Level 4',
    'brand-large': 'Turn a big goal into a quest line',
    'brand-title': 'Pass my final exams',
    'large-title': 'Today',
    'title-1': 'Check your email',
    'title-2': 'Quest complete',
    'title-3': 'Today’s quests',
    headline: 'Study 30 min',
    body: 'Pausing puts this achievement on hold.',
    callout: 'Good evening, Lena.',
    subhead: '20 of 205 XP earned',
    footnote: '3 of 5 this week',
    caption: '+10 XP',
    overline: 'Thursday, 05.11.2026',
    label: 'Check in',
    stat: '6’000 XP',
  };
  const typeRows = Object.entries(QL.TOKENS.type)
    .filter(([k]) => !k.startsWith('$'))
    .map(([name, t]) => {
      const v = t.$value;
      return `<tr><th scope="row"><code>${name}</code></th><td><span class="t-${name}">${SAMPLES[name] || name}</span></td><td class="tnum">${v.fontSize} / ${v.lineHeight} · ${v.fontWeight}</td><td>${t.$extensions.ios}<br>${t.$extensions.android}${t.$extensions.use ? `<br><em>${t.$extensions.use}</em>` : ''}</td></tr>`;
    });

  const fonts = `<div class="font-cards">
      <div class="font-card"><p class="font-card__sample" style="font-family:var(--font-text);font-weight:600">Aa Qq 465</p>
        <p><strong>System font</strong> — all UI text. <strong>SF Pro</strong> on iOS through the built-in text styles, <strong>Roboto</strong> (or the phone’s own font) on Android through MaterialTheme typography. Dynamic Type, Bold Text and size-specific tracking come for free (HIG typography.md). Never bundled. Numbers that change use tabular figures.</p></div>
      <div class="font-card"><p class="font-card__sample" style="font-family:var(--font-display);font-variation-settings:'SOFT' 100,'WONK' 0;font-weight:600">Aa Qq 465</p>
        <p><strong>Fraunces</strong> — brand moments only: onboarding headlines, the achievement title in its detail header, level numbers, celebrations, badges and the share card (HIG branding.md: a custom font for headlines, the system font for body copy). Variable; soft terminals (SOFT 100, WONK 0).</p></div>
    </div>
    <p class="ds-note">Fraunces is SIL Open Font License 1.1 and ships in the apps; it must follow Dynamic Type (<code>Font.custom(_:size:relativeTo:)</code>; <code>sp</code> on Android) and Bold Text (+100 weight). These previews can’t use SF Pro on every computer, so they fall back to <strong>Inter</strong> for iOS frames and bundle <strong>Roboto</strong> for Android frames (both OFL, preview only). The platform toggle switches the font.</p>`;

  const deCard = `<article class="qcard" lang="de" aria-label="Beispielkarte auf Deutsch">
      <div class="qcard__lead" aria-hidden="true">${icon('circle-check')}</div>
      <div class="qcard__body">
        <p class="qcard__context t-footnote">${icon('key-round')}<span>In meine eigene Wohnung ziehen</span></p>
        <h3 class="qcard__title t-headline">Betreibungs&shy;register&shy;auszug bestellen</h3>
        <p class="qcard__meta t-footnote"><span>${icon('circle-check')}Einmalig</span><span class="tnum">10 XP</span></p>
      </div>
      <div class="qcard__action">${ui.checkButton({ title: 'Betreibungsregisterauszug bestellen' }).replace('Check in:', 'Abhaken:')}</div>
    </article>`;

  const localisation = (lang) =>
    lang === 'en'
      ? [
          item('Quest card', ui.questCard(Q('flat', 'extract'), A('flat'))),
          item('Buttons', `<div class="stack" style="--gap:8px">${ui.button({ label: 'Mark as done', block: true, iconName: 'check' })}${ui.button({ label: 'Pause and start over', variant: 'secondary', block: true })}</div>`),
          item('Tab bar', `<div class="spec-tabbar">${ui.tabBar('today', { label: 'Main (English example)' })}</div>`),
        ].join('')
      : `<div lang="de">${[
          item('Quest card', deCard),
          item('Buttons', `<div class="stack" style="--gap:8px">${ui.button({ label: 'Als erledigt markieren', block: true, iconName: 'check' })}${ui.button({ label: 'Pausieren und neu beginnen', variant: 'secondary', block: true })}</div>`),
          item('Tab bar', `<div class="spec-tabbar">${ui.tabBar('today', { label: 'Hauptnavigation (Beispiel)', labels: { today: 'Heute', achievements: 'Erfolge', stats: 'Statistik', profile: 'Profil' } })}</div>`),
        ].join('')}</div>`;

  const typography = section(
    'type',
    'Typography',
    'The system font for the interface, Fraunces for a few brand moments; one scale. Sizes are the default text size; every style scales with Dynamic Type / font scale. Display styles stop growing at 150 % (like iOS large titles and Android 14’s non-linear scaling); body text scales to 200 %. Use the toolbar to try it.',
    [
      sub('Families', '', fonts),
      sub('Type scale', 'Size / line height in pt (iOS) and sp (Android) · weight. Right: the platform text style each one maps to.', `<div class="spec ts-scope spec--wide" data-static data-theme="light"><div class="spec__body">${table(['Style', 'Specimen', 'Size', 'iOS / Android'], typeRows, 'ds-table--type')}</div></div>`),
      sub(
        'Room for German',
        'German strings run ~30 % longer and use long compound words. Layouts wrap instead of truncating; titles hyphenate (<code>lang="de"</code>, <code>hyphens: auto</code> — on iOS <code>hyphenationFactor</code>, on Android <code>Hyphens.Auto</code>). Translations mark the joints of very long compounds with soft hyphens (<code>Betreibungs·register·auszug</code>), so a break never lands mid-syllable on devices without a German dictionary. German shown here is placeholder copy for layout testing, not a translation.',
        `<div class="spec-pair"><div class="spec ts-scope" data-static data-theme="light" style="--spec-w:390px"><p class="spec__theme">English</p><div class="spec__body stack" style="--gap:20px">${localisation('en')}</div></div><div class="spec ts-scope" data-static data-theme="light" style="--spec-w:390px"><p class="spec__theme">German (+30 %)</p><div class="spec__body stack" style="--gap:20px">${localisation('de')}</div></div></div>`,
      ),
    ].join(''),
  );

  /* ───────── Foundations: space, radius, elevation, icons, motion ───────── */
  const spaces = Object.entries(QL.TOKENS.space)
    .filter(([k]) => !k.startsWith('$') && k !== '0')
    .map(([k, v]) => `<li class="space-row"><code>space-${k}</code><span class="space-row__bar" style="width:${v.$value}"></span><span class="tnum">${v.$value}</span></li>`)
    .join('');
  const radii = Object.entries(QL.TOKENS.radius)
    .filter(([k]) => !k.startsWith('$'))
    .map(([k, v]) => `<li class="radius-box"><span class="radius-box__shape" style="border-radius:${v.$value}"></span><code>radius-${k}</code><span class="tnum">${v.$value === '999px' ? 'full' : v.$value}</span><span class="radius-box__use">${esc(v.$description || '')}</span></li>`)
    .join('');
  const elevation = () =>
    `<div class="elev-row">${['e1', 'e2', 'e3']
      .map((e, i) => `<div class="elev-card" style="box-shadow:var(--elevation-${e})"><strong>${e}</strong><span class="t-footnote c-secondary">${['Cards, quest cards', 'Android FAB, popovers', 'Sheets, dialogs, snackbars'][i]}</span></div>`)
      .join('')}</div>`;

  const iconNames = Object.keys(QL.ICONS).sort();
  const iconGrid = `<ul class="icon-grid">${iconNames.map((n) => `<li>${icon(n)}<span>${n}</span></li>`).join('')}</ul>`;
  const ICON_STATES = [
    ['check / circle-check', 'check', 'Done, checked in'],
    ['lock', 'lock', 'Locked quest'],
    ['star', 'star', 'Bonus quest'],
    ['map-pin', 'map-pin', 'Current quest'],
    ['circle-check · repeat · target', 'repeat', 'Quest types: one-time, habit, target'],
    ['pause', 'pause', 'Paused'],
    ['rotate-ccw', 'rotate-ccw', 'Habit needs a restart'],
    ['eye-off', 'eye-off', 'Private / hidden'],
    ['flame', 'flame', 'Streak'],
    ['sparkle', 'sparkle', 'XP'],
    ['cloud-upload · wifi-off', 'cloud-upload', 'Waiting to sync · offline'],
  ];
  const iconStateRows = ICON_STATES.map(([names, ic, meaning]) => `<tr><td>${icon(ic)}</td><th scope="row"><code>${names}</code></th><td>${meaning}</td></tr>`);

  const MOTION = [
    ['Check-in tick', 'Circle fills and the tick draws; light haptic. Nothing else — check-ins happen many times a day (HIG motion.md)', 'Filled state appears; haptic stays', '160 ms'],
    ['Quest complete', 'Circle pops once (0.82 → 1.1 → 1) with a soft ring burst; success haptic; toast with XP', 'No pop or burst; toast fades in', 'spring 0.35 s, damping 0.75'],
    ['XP gain', 'Bar fill slides to the new value, “+10 XP” floats up and fades', 'Bar updates in place, label fades', '400 ms standard'],
    ['Progress ring', 'Stroke draws to the new value', 'Updates in place', '400 ms standard'],
    ['Current quest node', 'Static halo — no looping animation', 'Same', '—'],
    ['Sheet / dialog', 'Slides up / scales from the trigger, scrim fades', 'Fades', '280 ms enter, 200 ms exit'],
    ['Snackbar', 'Rises 16 pt', 'Fades', '280 ms enter'],
    ['Loading skeleton', 'Shimmer sweeps', 'Static placeholders', '1.4 s'],
    ['Level up (pass 2)', 'Emblem flips to the new level, gentle glow', 'Crossfade of the number', '≤ 900 ms'],
    ['Achievement unlocked (pass 2)', 'Badge reveal with confetti', 'Soft fade, no confetti, no particles', '≤ 1.2 s'],
  ];
  const motionRows = MOTION.map(([what, full, reduced, timing]) => `<tr><th scope="row">${what}</th><td>${full}</td><td>${reduced}</td><td>${timing}</td></tr>`);
  const motionDemo = () =>
    `<div class="row" style="--gap:16px">${ui.checkButton({ title: 'Demo quest', extra: { 'data-demo': 'check' } })}<span class="t-subhead c-secondary">Tap to replay the check-in. Switch “Motion” in the toolbar to compare.</span></div>`;

  const foundations = [
    section(
      'space',
      'Spacing, radius, elevation',
      '8-pt grid with 4-pt half steps inside components. Screen gutter 24 pt (16 pt at accessibility text sizes). Rounded but not bubbly: cards 24, sheets 28, buttons fully rounded.',
      [
        sub('Spacing', '', `<ul class="space-list">${spaces}</ul>`),
        sub('Radius', '', `<ul class="radius-list">${radii}</ul>`),
        sub('Elevation', 'Subtle, warm-tinted shadows in light mode; in dark mode depth comes from lighter surfaces plus deeper shadows.', pair(elevation)),
      ].join(''),
    ),
    section(
      'icons',
      'Iconography',
      'One icon style: <strong>Lucide</strong> (ISC licence) — outline, 24 × 24 grid, 2 px stroke, round caps and joins. Sizes 16 / 20 / 24 / 28; icons scale with the text up to 150 %. Outline everywhere except the tab bar: filled there on iOS (as SF Symbols’ .fill variants; the app uses SF Symbols on iOS) and filled when selected on Android. Never emoji. Icon-only buttons always have a label for screen readers.',
      [sub('States and meanings', 'A state is never shown by colour alone: these icons always accompany it, together with a word.', table(['<span class="sr-only">Icon</span>', 'Name', 'Means'], iconStateRows, 'ds-table--icons')), sub(`Set used in the app (${iconNames.length})`, '', iconGrid)].join(''),
    ),
    section(
      'motion',
      'Motion',
      'Short, physical and meaningful: motion confirms an action or shows progress — never decoration. Every animation has a reduced-motion version (iOS “Reduce Motion”, Android “Remove animations”), which becomes a ≤ 150 ms fade. Animations never block input.',
      [sub('Rules', '', table(['Moment', 'Full motion', 'Reduced motion', 'Timing'], motionRows)), sub('Try it', '', pair(motionDemo))].join(''),
    ),
  ].join('');

  /* ───────── Components ───────── */
  const buttons = () =>
    [
      item('Primary — one per screen', ui.button({ label: 'Check in', size: 'lg', block: true, iconName: 'check' })),
      item('Hierarchy', row(ui.button({ label: 'Save' }), ui.button({ label: 'Cancel', variant: 'secondary' }), ui.button({ label: 'Edit', variant: 'outline' }), ui.button({ label: 'See all', variant: 'text' }))),
      item('Destructive', row(ui.button({ label: 'Delete…', variant: 'danger' }), ui.button({ label: 'Delete achievement', variant: 'danger-solid' }))),
      item('States', row(ui.button({ label: 'Pressed', state: 'is-pressed' }), ui.button({ label: 'Focused', variant: 'secondary', state: 'is-focus' }), ui.button({ label: 'Disabled', state: 'is-disabled' }), ui.button({ label: 'Saving…', iconName: 'loader-circle', state: 'is-loading' }))),
      item('Small (48 pt hit area)', row(ui.button({ label: 'Show', variant: 'secondary', size: 'sm', iconName: 'eye' }), ui.button({ label: 'Restart', variant: 'secondary', size: 'sm' }))),
      item('Icon buttons', row(ui.iconButton({ iconName: 'ellipsis', label: 'More actions' }), ui.iconButton({ iconName: 'plus', label: 'Add', variant: 'tonal' }), ui.iconButton({ iconName: 'pencil', label: 'Edit', variant: 'accent' }))),
    ].join('');

  const tags = () =>
    [
      item('Tags', row(ui.xpTag(25), ui.tag('Bonus', 'bonus', 'star'), ui.tag('Done', 'done', 'check'), ui.tag('Locked', 'locked', 'lock'), ui.tag('Paused', 'paused', 'pause'), ui.tag('Current', 'active', 'map-pin'), ui.tag('Study', 'outline', 'graduation-cap'))),
      item(
        'Chips (single choice)',
        row(
          ...Object.entries(data.CATEGORIES)
            .slice(0, 4)
            .map(([k, c], i) => `<button type="button" class="chip" aria-pressed="${i === 1}">${icon(c.icon, 'icon--md')}${c.label}</button>`),
        ),
      ),
    ].join('');

  const rings = () =>
    [
      item('Sizes', row(ui.ring({ p: 0.36, size: 'sm', label: '36 % complete' }), ui.ring({ p: 0.36, center: icon('heart-pulse'), label: '36 % complete' }), ui.ring({ p: 0.36, size: 'lg', center: `<span class="t-stat">36 %</span>`, label: '36 % complete' }))),
      item(
        'States',
        row(
          ui.ring({ p: 0, center: '<span class="t-caption c-secondary">0 %</span>', label: 'Not started' }),
          ui.ring({ p: 1, variant: 'done', center: `<span class="c-done">${icon('check')}</span>`, label: 'Complete' }),
          ui.ring({ p: 0.5, variant: 'paused', center: icon('pause'), label: 'Paused' }),
          ui.ring({ p: 0.36, variant: 'private', center: icon('eye-off'), label: 'Private achievement, hidden' }),
        ),
        'Paused and private rings hide the fill: a paused achievement restarts at 0 %, a private one reveals nothing.',
      ),
    ].join('');

  const xp = () =>
    [
      item('Level card', ui.levelCard(S.user)),
      item('XP bar while gaining XP', `<div style="padding-top:28px;position:relative">${ui.bar({ p: 0.29, cls: 'bar--xp', label: 'Level 3 progress', min: 300, max: 900, now: 475, valueText: '475 XP' })}<span class="xp-gain xp-gain--static t-subhead" style="top:0" aria-hidden="true">+10 XP</span></div>`, 'The “+10 XP” label floats up and fades out after a check-in (shown here held at full opacity).'),
      item('Progress bar (quests)', ui.bar({ p: 7 / 12, cls: 'bar--sm', label: 'Read all 12 chapters', valueText: '7 of 12 chapters' })),
    ].join('');

  const WEEK_LEGEND = [
    ['done', 'Checked in'],
    ['none', 'No check-in — neutral, never red'],
    ['today', 'Today, open'],
    ['today-done', 'Today, checked in'],
    ['upcoming', 'Upcoming'],
  ];
  const streaks = () =>
    [
      item('Streak indicator', row(ui.streak({ current: 12, unit: 'day' }), ui.streak({ current: 3, unit: 'week' }), ui.streak({ current: 1, unit: 'day' }))),
      item('Week strip (habit)', ui.weekStrip(['done', 'none', 'done', 'today', 'upcoming', 'upcoming', 'upcoming'], { label: 'Cook at home, this week' })),
      item(
        'Day states',
        `<ul class="legend">${WEEK_LEGEND.map(([s, l]) => `<li class="week__day week__day--${s}"><span class="week__dot" aria-hidden="true">${s === 'done' || s === 'today-done' ? icon('check') : ''}</span><span class="t-footnote">${l}</span></li>`).join('')}</ul>`,
      ),
    ].join('');

  const restartQuest = Object.assign(clone(Q('exams', 'study')), { state: 'needs_restart', endedOn: '2026-11-01' });
  const pausedAchievement = Object.assign(clone(A('flat')), { status: 'paused' });
  const syncingQuest = Object.assign(clone(Q('flat', 'extract')), { state: 'completed', completedOn: data.TODAY, completedAt: '18:42', syncing: true });
  const questCards = () =>
    [
      item('Available · one-time', ui.questCard(Q('flat', 'extract'), A('flat'))),
      item('Available · habit', ui.questCard(Q('exams', 'study'), A('exams'))),
      item('Available · target (opens the sheet)', ui.questCard(Q('flat', 'save'), A('flat'))),
      item('Target with numbers hidden', ui.questCard(Q('weight', 'reach80'), A('weight')), 'For goals like body weight: overview screens show the trend only.'),
      item('Done today · one-time', ui.questCard(Q('exams', 'register'), A('exams'))),
      item('Done today · habit', ui.questCard(Q('weight', 'steps'), A('weight'))),
      item('Done earlier (list view)', ui.questCard(Q('exams', 'plan'), A('exams'), { mode: 'list' })),
      item('Bonus', ui.questCard(Q('exams', 'group'), A('exams'))),
      item('Locked (list view)', ui.questCard(Q('exams', 'mocks'), A('exams'), { mode: 'list' })),
      item('Habit needs a restart', ui.questCard(restartQuest, A('exams')), 'A period was missed (R-QST-04). Neutral wording; history stays.'),
      item('Achievement paused', ui.questCard(pausedAchievement.quests[1], pausedAchievement)),
      item('Private, hidden', ui.privateGroupCard({ count: 3, doneCount: 1 })),
      item('Offline · waiting to sync', ui.questCard(syncingQuest, A('flat'))),
      item('Loading', ui.skeletonCard()),
    ].join('');

  const NODES = [
    ['start', '', 'Start'],
    ['done', 'check', 'Done'],
    ['current', 'repeat', 'Current'],
    ['available', 'target', 'Available'],
    ['bonus', 'star', 'Bonus'],
    ['bonus-done', 'check', 'Bonus done'],
    ['locked', 'lock', 'Locked'],
    ['restart', 'rotate-ccw', 'Needs restart'],
  ];
  const goalNode = (done) =>
    `<span class="pnode pnode--goal${done ? ' pnode--goal-done' : ''}" aria-hidden="true"><svg class="goal-shape" viewBox="0 0 100 108"><path d="M${ui.HEX(46).split(' ').join(' L')} Z"/></svg>${icon('trophy', 'icon--md')}</span>`;
  const nodes = () =>
    [
      item(
        'Nodes',
        `<ul class="node-list">${NODES.map(([cls, ic, label]) => `<li><span class="node-list__slot"><span class="pnode pnode--${cls}" aria-hidden="true">${ic ? icon(ic) : ''}</span></span><span class="t-footnote">${label}</span></li>`).join('')}
          <li><span class="node-list__slot">${goalNode(false)}</span><span class="t-footnote">Goal</span></li>
          <li><span class="node-list__slot">${goalNode(true)}</span><span class="t-footnote">Unlocked</span></li></ul>`,
      ),
      item('Path (example: Move into my own flat)', ui.questPath(A('flat'))),
    ].join('');

  const RANK_SPECS = [
    ['unlocked', 'compass', 'Below 55 points: still unlocked, never “unranked”'],
    ['bronze', 'heart-pulse', ''],
    ['silver', 'key-round', ''],
    ['gold', 'graduation-cap', ''],
    ['platinum', 'briefcase-business', ''],
    ['emerald', 'piggy-bank', ''],
    ['diamond', 'mountain', ''],
    ['champion', 'trophy', ''],
    ['unearned', 'flag', ''],
  ];
  const badges = () =>
    `<ul class="badge-grid">${RANK_SPECS.map(([rank, ic]) => `<li>${ui.badge({ rank, iconName: ic, size: 72 })}</li>`).join('')}</ul>
     <p class="spec-item__note">The badge carries the achievement’s category icon and its rank (API: <code>rank</code>, R-RANK-02). The rank name is always written, so colour is never the only cue.</p>`;

  const sheets = (type) => () => {
    const [aid, qid, opts] = { one_time: ['flat', 'extract', {}], habit: ['exams', 'study', {}], target: ['weight', 'reach80', { earlierDate: true }] }[type];
    return ui.checkInSheet({ q: Q(aid, qid), a: A(aid), ...opts });
  };

  const inputs = () =>
    [
      item('Text field', ui.field({ label: 'Achievement', placeholder: 'e.g. Pass my final exams' })),
      item('Filled · focused', ui.field({ label: 'Achievement', value: 'Pass my final exams', focus: true })),
      item('With unit · error', ui.field({ label: 'Target value', value: '90', suffix: 'kg', error: 'Choose a target different from the start value (90 kg).' })),
      item('Disabled', ui.field({ label: 'Start date', value: '12.10.2026', disabled: true, helper: 'Fixed while the habit is running. Restart it to change the schedule.' })),
      item('Text area (optional)', ui.field({ label: 'Why it matters', optional: true, area: true, value: 'Finish my Bachelor and start my first job in spring.' })),
      item('Switch', ui.switchRow({ label: 'Private achievement', hint: 'Hidden on Today, in notifications and on share cards.', on: true }) + ui.switchRow({ label: 'Hide numbers on overview screens', hint: 'Show the trend only, e.g. for body weight.', on: false })),
      item('Checkbox (consent, unticked by default)', ui.checkboxRow({ html: 'Store my goals – they may include health information – so the app can work. <a href="#" class="link">What this means</a>' })),
      item('Segmented control', ui.segmented({ label: 'Quest size', selected: 'M', block: true, options: [['S', 'S', '', '10 XP'], ['M', 'M', '', '25 XP'], ['L', 'L', '', '50 XP']] })),
      item('Value stepper', ui.stepper({ value: '86.3', unit: 'kg', label: 'New value in kg', step: '0.1' })),
    ].join('');

  const navigation = (theme) =>
    [
      item('Navigation bar', `<div class="spec-navbar">${ui.navBar({ back: 'Achievements', actions: ui.iconButton({ iconName: 'pencil', label: 'Edit achievement' }) + ui.iconButton({ iconName: 'ellipsis', label: 'More actions' }) })}</div>`, 'iOS: bar items on Liquid Glass capsules, no bar background (a scroll-edge effect separates content). Android: plain top app bar with the back arrow (platform toggle).'),
      item('Tab bar', `<div class="spec-tabbar">${ui.tabBar('today', { label: `Main (${theme} example)` })}</div>`, 'Four destinations; creating is an action, not a tab. iOS: floating glass capsule, filled symbols, selected tab tinted on a platter. Android: Material 3 bar, selected icon filled in a pill and a bold label.'),
      item('New achievement', `<div class="row" style="--gap:24px;align-items:center">${ui.createButton('ios').replace('navbar navbar--root', 'spec-create')}<span class="t-footnote c-secondary">iOS: prominent glass “+” in the top bar of Today and Achievements</span></div>`),
      item('Segmented view switch', ui.segmented({ label: 'Quest view', selected: 'path', options: [['path', 'Path'], ['list', 'List']] }), 'Text only: text and icons are never mixed in one control (HIG segmented-controls.md).'),
    ].join('');

  const feedback = () =>
    [
      item('Snackbar · after a check-in', ui.snackbar({ text: 'Quest complete · <strong>+10 XP</strong>', iconName: 'sparkles' })),
      item('Snackbar · after undo', ui.snackbar({ text: 'Check-in undone · Study 30 min', iconName: 'undo-2', action: 'Redo' })),
      item('Banner · offline', ui.banner({ iconName: 'wifi-off', text: '<strong>You’re offline.</strong> Check-ins are saved on this phone and sync when you’re back online.' })),
      item('Banner · syncing', ui.banner({ iconName: 'refresh-cw', text: 'Syncing 2 check-ins…' })),
    ].join('');

  const confirmSpec = (platform) =>
    ui.confirm({
      platform,
      iconName: 'pause',
      title: 'Pause “Pass my final exams”?',
      message: 'When you resume, all 7 quests start again at 0 % and the 20 XP from this attempt is removed. Check-ins and notes stay in your history.',
      action: 'Pause and start over',
    });
  const fixedPanel = (theme, platform, label, html) =>
    `<div class="spec ts-scope" data-static data-theme="${theme}" data-fixed-platform="${platform}" style="--spec-w:390px"><p class="spec__theme">${label}</p><div class="spec__body">${html}</div></div>`;
  const dialogs = () =>
    `<div class="spec-pair">${fixedPanel('light', 'ios', 'iOS · action sheet', confirmSpec('ios'))}${fixedPanel('dark', 'android', 'Android · Material dialog', confirmSpec('android'))}</div>
     ${pair(() => item('Menu', ui.menu([
       { icon: 'pencil', label: 'Edit details' },
       { icon: 'eye-off', label: 'Make private' },
       { icon: 'pause', label: 'Pause…' },
       '-',
       { icon: 'trash-2', label: 'Delete…', danger: true },
     ])))}`;

  const components = section(
    'components',
    'Components',
    'Built once, used on every screen (<code>assets/js/ui.js</code>). Each shows its states in both themes. Hit areas are at least 48 × 48 pt even where the visible control is smaller.',
    [
      sub('Buttons', '', pair(buttons)),
      sub('Tags and chips', '', pair(tags)),
      sub('Progress ring', 'Progress comes from the API (XP-weighted, R-ACH-03). Screen readers hear “Pass my final exams: 32 % complete, 85 days left”.', pair(rings)),
      sub('XP bar and level', 'Level thresholds 100 × 3^(L−2) (R-XP-03). The bar shows progress within the current level.', pair(xp)),
      sub('Streak indicator', 'Streaks count met days or weeks (R-STR-01).', pair(streaks)),
      sub('Quest card — every state', 'Lead icon + words carry the state; colour only supports it. At 150 % text and more, the lead icon drops and the card stacks.', pair(questCards)),
      sub('Quest path', 'Vertical journey map. Solid gold line = the way walked so far; dashed = ahead. Bonus quests branch off as side quests.', pair(nodes)),
      sub('Badge', 'Earned when an achievement is unlocked.', pair(badges, { width: 420 })),
      sub('Check-in sheet — one-time', '', pair(sheets('one_time'))),
      sub('Check-in sheet — habit', '', pair(sheets('habit'))),
      sub('Check-in sheet — target, dated earlier', 'Only check-ins for today count (R-CHK-04); the helper explains it when another day is picked.', pair(sheets('target'))),
      sub('Inputs and controls', 'Visible labels, helper text below, errors say what to do next.', pair(inputs)),
      sub('Navigation', '', pair(navigation)),
      sub('Snackbar and banners', 'Snackbars stay 6 s (longer with VoiceOver / TalkBack running), are announced politely and never steal focus.', pair(feedback)),
      sub('Confirmations and menu', 'Platform-native: an iOS action sheet for a choice the person started (destructive button on top in the destructive style, Cancel apart at the bottom; title case on iOS buttons), a Material 3 dialog on Android (Cancel first, the red text button last). Cancel has initial focus. Used for pause (which starts the achievement over), deleting an achievement, withdrawing consent and the final account deletion.', dialogs()),
    ].join(''),
  );

  /* ───────── Components added in pass 2 ───────── */
  const lists = (theme) =>
    [
      item('Grouped list (settings)', ui.listGroup({
        title: 'Security',
        rows: [
          ui.listRow({ iconName: 'key-round', label: 'iCloud Keychain', sub: 'Added 01.03.2026 · used today', tone: 'done' }),
          ui.listRow({ kind: 'toggle', iconName: 'eye-off', label: 'Hide content in the app switcher', on: true }),
          ui.listRow({ kind: 'static', iconName: 'smartphone', label: 'iPad', sub: 'iOS · last active 03.11.2026', value: ui.button({ label: 'Sign out', variant: 'secondary', size: 'sm' }) }),
          ui.listRow({ iconName: 'user-x', label: 'Delete account', tone: 'danger', danger: true }),
        ],
      })),
      item('Radio group', ui.listGroup({ rows: [ui.radioRow({ label: 'Generic', hint: '“2 quests today”', checked: true, name: `n-${theme}` }), ui.radioRow({ label: 'Quest names', hint: 'Never for private achievements', name: `n-${theme}` })] }).replace('<ul class="lgroup__list">', `<ul class="lgroup__list" role="radiogroup" aria-label="Notification text (${theme})">`)),
    ].join('');

  const cards2 = () =>
    [
      item('Achievement card', `<ul class="acard-list">${ui.achievementCard(A('exams'))}${ui.achievementCard(A('weight'), { revealed: false })}${ui.achievementCard(A('licence'))}</ul>`),
      item('Template card', `<ul class="tcard-list">${ui.templateCard(data.templates[0], { selected: true })}</ul>`),
      item('Suggested quest', `<ul class="sg-list">${ui.suggestionRow({ ...data.templates[0].quests[1] })}</ul>`),
    ].join('');

  const states2 = () =>
    [
      item('Empty state', `<div class="card">${ui.emptyState({ title: 'Your quest log is empty', body: 'Start with one big goal.', actions: ui.button({ label: 'Create an achievement', block: true, iconName: 'plus' }) })}</div>`),
      item('Notice · done', ui.notice({ tone: 'done', iconName: 'circle-check', title: 'Nothing due today', body: 'Your habits are on track for this week.' })),
      item('Notice · problem', ui.notice({ tone: 'error', iconName: 'cloud-off', title: 'Today didn’t load', body: 'Nothing is lost. Check-ins sync later.', actions: ui.button({ label: 'Try again', variant: 'secondary', size: 'sm', iconName: 'refresh-cw' }) })),
    ].join('');

  const data2 = () =>
    [
      item('Bar chart (with a table for screen readers)', `<div class="card">${ui.barChart({ values: data.xpByMonth, title: 'XP by month in 2026', current: 10 })}</div>`),
      item('Line chart (target quest)', `<div class="card">${ui.lineChart({ points: data.savingsLog.map((l) => ({ date: l.date, value: l.value })), start: 0, goal: 6000, from: '2026-09-20', to: data.TODAY, unit: 'CHF', money: true, title: 'Savings over time' })}</div>`),
      item('Streak calendar', `<div class="card">${ui.monthCalendar({ year: 2026, month: 11, done: new Set(data.studyDays), today: data.TODAY, runStart: '2026-10-12', runEnd: '2026-12-06' })}</div>`),
    ].join('');

  const celebrate2 = () =>
    [
      item('Quest complete toast', `<div class="snackbar snackbar--celebrate" role="status"><span class="snackbar__burst" aria-hidden="true">${icon('sparkles')}</span><p class="snackbar__text t-subhead"><strong>Quest complete · +10 XP</strong><br>Buy running shoes</p><button type="button" class="snackbar__action">Undo</button></div>`),
      item('Share card', ui.shareCard({ a: { ...A('licence'), requiredCount: 6 }, rank: 'silver', show: { title: true, badge: true, date: true }, days: 108 })),
    ].join('');

  const components2 = section(
    'components-2',
    'Components added in pass 2',
    'The same rules — semantic tokens, 48 pt targets, state by icon and word, names and values for screen readers — applied to settings, lists, charts, empty and error states and celebrations.',
    [
      sub('Lists and choices', 'Rows with the current value on the right; toggles are switches, single choices are radio groups.', pair(lists)),
      sub('Cards', 'An achievement card is one link whose name is its visible text; private ones reveal nothing.', pair(cards2)),
      sub('Empty and error states', 'Calm, specific, with one way forward. Problems never use red; red is for deleting.', pair(states2)),
      sub('Charts and calendar', 'Values labelled directly; every chart has a table for screen readers; days without a check-in stay neutral.', pair(data2)),
      sub('Celebrations', 'The small quest-complete toast and the share card. The full-screen unlock and the level-up card are in pass 2 → Celebrations.', pair(celebrate2)),
    ].join(''),
  );

  /* ───────── Accessibility ───────── */
  const SR = [
    ['Check-in button', '“Check in: Study 30 min”, toggle button, not pressed; after checking in: pressed (activating it again undoes today’s check-in). Hint: “Records today’s check-in.”'],
    ['Progress ring', '“Pass my final exams: 32 % complete, 85 days left”, image'],
    ['XP bar', '“Level 3 progress”, 465 XP, 435 XP to level 4'],
    ['Week strip day', '“Thursday: today, not checked in yet”'],
    ['Quest path node', '“Current quest: Study 30 min, Habit, 5× a week for 8 weeks …”, current step'],
    ['Locked quest', '“Locked: Do 3 mock exams. Unlocks after “Read all 12 chapters””'],
    ['Private row', '“3 private quests” + button “Show private quests” (nothing else is read out)'],
    ['Badge', '“Silver badge: Get my driving licence”'],
  ];
  const a11y = section(
    'a11y',
    'Accessibility rules',
    'WCAG 2.2 AA, built into the components rather than added per screen.',
    [
      sub(
        'Checklist',
        '',
        `<ul class="ds-list">
          <li><strong>Contrast</strong> — all text ≥ 4.5:1, controls and focus ≥ 3:1, in both themes (<a href="#colour">table</a>).</li>
          <li><strong>Targets</strong> — ≥ 48 × 48 pt hit area everywhere (iOS 44 pt, Android 48 dp), ≥ 8 pt apart.</li>
          <li><strong>State never by colour alone</strong> — every state has an icon and a word: done (tick), locked (lock + “Unlocks after …”), bonus (star + “Bonus”), current (pin + “Current”), private (crossed-out eye + “Private”).</li>
          <li><strong>Focus order</strong> follows the visual order top to bottom; sheets and dialogs move focus inside, trap it, close with Escape / back gesture and return focus to the control that opened them.</li>
          <li><strong>Large text</strong> — body text to 200 %, display titles to 150 %. From 150 %: progress rings become a list, quest cards drop the lead icon and stack, the level card stacks, the gutter shrinks to 16 pt. Nothing truncates that the user needs; tab labels keep their size (as on iOS) and show the Large Content Viewer (iOS) or a tooltip (Android) on long-press.</li>
          <li><strong>Reduced motion</strong> — every animation has a fade alternative (<a href="#motion">table</a>).</li>
          <li><strong>Announcements</strong> — check-ins, XP and errors are announced politely; nothing time-limited without a way to extend it.</li>
        </ul>`,
      ),
      sub('Screen-reader labels (examples)', 'Names, roles and values as VoiceOver / TalkBack read them.', table(['Control', 'Read as'], SR.map(([c, r]) => `<tr><th scope="row">${c}</th><td>${r}</td></tr>`))),
    ].join(''),
  );

  document.getElementById('ds').innerHTML = [colour, typography, foundations, components, components2, a11y].join('');

  // Motion demo: replay the check-in animation (respects the panel's reduced-motion class).
  document.getElementById('ds').addEventListener('click', (e) => {
    const demo = e.target.closest('[data-demo="check"]');
    if (demo) {
      const done = demo.classList.contains('check--done');
      demo.classList.remove('check--just-done');
      demo.classList.toggle('check--done', !done);
      demo.setAttribute('aria-pressed', String(!done));
      if (!done) {
        void demo.offsetWidth;
        demo.classList.add('check--just-done');
      }
      return;
    }
    if (e.target.closest('a[href="#"]')) e.preventDefault();
  });

  QL.board.toolbar(document.getElementById('toolbar'), ['ts', 'platform', 'motion', 'contrast', 'transparency']);
})(window.QL);
