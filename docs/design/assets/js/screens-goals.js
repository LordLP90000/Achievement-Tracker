/* Pass 2 screens: Achievements list, create wizard, add/edit quest sheet, quest detail. */
(function (QL) {
  const { ui, data, fmt } = QL;
  const { icon, esc, button, iconButton } = ui;
  const S = QL.screens;

  const tabs = (active, ctx) => ui.tabBar(active, { label: `Main, ${ctx.label}` });
  const ios = (ctx) => ctx.platform !== 'android';

  /* ───────── Achievements list ───────── */
  S.achievements = (ctx) => {
    const list = ctx.state.achievements;
    const filter = ctx.filter || 'active';
    const counts = ['active', 'paused', 'completed'].map((s) => list.filter((a) => a.status === s).length);
    const shown = list.filter((a) => a.status === filter);
    const empty = {
      active: ['Nothing active', 'Create an achievement to start a quest line.'],
      paused: ['Nothing paused', 'Paused achievements wait here. When you resume one, it starts fresh — your history stays.'],
      completed: ['Nothing unlocked yet', 'Unlocked achievements land here with their badge — your archive.'],
    }[filter];
    return {
      body: `<div class="screen">
        ${ios(ctx) ? ui.createButton('ios', { anno: 7 }) : ''}
        <header class="screen-header"><h1 class="screen-header__title t-large-title">Achievements</h1></header>
        <div class="screen__content">
          <div style="margin-top:16px" data-anno="1">${ui.segmented({
            label: 'Show achievements',
            selected: filter,
            block: true,
            action: 'filter',
            options: [
              ['active', 'Active', '', String(counts[0])],
              ['paused', 'Paused', '', String(counts[1])],
              ['completed', 'Completed', '', String(counts[2])],
            ],
          })}</div>
          ${
            shown.length
              ? `<ul class="acard-list" style="margin-top:20px" data-anno="2">${shown.map((a) => ui.achievementCard(a, { revealed: !!ctx.revealed, swiped: ctx.swiped === a.id, pressed: ctx.pressed === a.id, anno: ctx.swiped === a.id || ctx.pressed === a.id ? 8 : '' })).join('')}</ul>`
              : `<div class="card" style="margin-top:20px" data-anno="2">${ui.emptyState({ iconName: filter === 'paused' ? 'pause' : 'trophy', title: empty[0], body: empty[1] })}</div>`
          }
          ${filter === 'completed' && shown.length ? `<p class="t-footnote c-tertiary" style="margin-top:16px" data-anno="3">${icon('archive', 'icon--sm')} Completed achievements are read-only. They are your archive and can’t be deleted.</p>` : ''}
        </div>
        ${ios(ctx) ? '' : ui.createButton('android', { anno: 7 })}${tabs('achievements', ctx)}
      </div>`,
    };
  };

  /* ───────── Create achievement wizard ───────── */
  const W = (ctx) => ctx.wiz || {};
  const wizScreen = (ctx, step, content, cta, { skip = false } = {}) =>
    `<div class="screen">
      ${ui.wizardTop({ step, skip })}
      <div class="screen__content">${content}</div>
      ${ui.footer(button({ label: cta, size: 'lg', block: true, extra: { 'data-action': step === 4 ? 'wiz-create' : 'wiz-next' } }))}
    </div>`;

  S.wizard1 = (ctx) => {
    const w = W(ctx);
    const chips = Object.entries(data.CATEGORIES)
      .map(([k, c]) => `<button type="button" class="chip" aria-pressed="${w.category === k}" data-action="wiz-category" data-value="${k}">${icon(c.icon, 'icon--md')}${c.label}</button>`)
      .join('');
    return {
      body: wizScreen(
        ctx,
        1,
        `<h1 class="t-title-1 wiz-title">What do you want to achieve?</h1>
        <p class="t-callout wiz-lead">One big goal. You can change everything later.</p>
        <div style="margin-top:24px" data-anno="1">${ui.field({ label: 'Achievement', value: w.title || '', placeholder: 'e.g. Run my first 10 km', focus: !w.title && !w.error, error: w.error || '' })}</div>
        <p class="field__label" style="margin:20px 0 10px" id="${ctx.ids}-cat">Category</p>
        <div class="chip-wrap" role="group" aria-labelledby="${ctx.ids}-cat" data-anno="2">${chips}</div>
        <div class="section__header" style="margin:28px 0 12px"><h2 class="t-headline">Or start with a template</h2></div>
        <ul class="tcard-list" data-anno="3">${data.templates.map((t) => ui.templateCard(t, { selected: w.template === t.id })).join('')}</ul>`,
        'Next',
      ),
    };
  };

  S.wizard2 = (ctx) => {
    const w = W(ctx);
    return {
      body: wizScreen(
        ctx,
        2,
        `<h1 class="t-title-1 wiz-title">Why does it matter?</h1>
        <p class="t-callout wiz-lead">Optional. A line for the harder days — shown on the achievement.</p>
        <div style="margin-top:24px" data-anno="4">${ui.field({ label: 'Why it matters', optional: true, area: true, value: w.why || '', placeholder: 'e.g. Run through the old town with my sister.' })}</div>
        <div class="field" style="margin-top:20px" data-anno="5">
          <span class="field__label" id="${ctx.ids}-dl">Target date <span class="field__optional">(optional)</span></span>
          <div class="row" style="--gap:8px">
            <button type="button" class="field__control" style="flex:1;text-align:left" aria-labelledby="${ctx.ids}-dl ${ctx.ids}-dv"><span class="field__value tnum" id="${ctx.ids}-dv">${w.date ? fmt.weekdayDate(w.date) : 'No date'}</span>${icon('calendar', 'c-secondary')}</button>
            ${w.date ? iconButton({ iconName: 'x', label: 'Remove target date', variant: 'tonal' }) : ''}
          </div>
          <p class="field__helper t-footnote">${w.date ? `${fmt.daysLeft(w.date)}. ` : ''}Change or remove it any time. Finishing on time counts toward the badge’s rank.</p>
        </div>`,
        'Next',
        { skip: true },
      ),
    };
  };

  S.wizard3 = (ctx) => {
    const w = W(ctx);
    const quests = w.quests || [];
    const on = quests.filter((q) => q.on);
    const required = on.filter((q) => !q.bonus);
    const xp = required.reduce((s, q) => s + ui.questXp(q), 0);
    const template = data.templates.find((t) => t.id === w.template);
    const rows = quests
      .map((q) => {
        const after = q.after ? quests.find((x) => x.id === q.after) : null;
        const row = ui.suggestionRow(q, { after: after ? after.title : '' });
        return q.own ? row.replace('class="sgrow ', 'class="sgrow sgrow--new ') : row;
      })
      .join('');
    return {
      body: wizScreen(
        ctx,
        3,
        `<h1 class="t-title-1 wiz-title">Break it into quests</h1>
        <p class="t-callout wiz-lead">Small steps you can tick off.${template ? ` These come from “${esc(template.title)}” — keep what fits.` : ''}</p>
        <ul class="sg-list" style="margin-top:20px" data-anno="6">${rows}</ul>
        <div style="margin-top:12px" data-anno="7">${button({ label: 'Add your own quest', variant: 'secondary', block: true, iconName: 'plus', extra: { 'data-action': 'wiz-add-quest' } })}</div>
        <div class="xp-total" data-anno="8"><span class="t-subhead"><strong>To unlock:</strong> ${required.length} quests</span><span class="tag tag--xp tnum">${icon('sparkle')}${fmt.num(xp)} XP</span></div>
        <p class="t-footnote c-tertiary" style="margin-top:8px">Bonus quests are optional: they give XP but never block unlocking.</p>`,
        'Next',
      ),
      overlay: ctx.sheetQuest ? S.questSheetOverlay(ctx) : '',
    };
  };

  S.wizard4 = (ctx) => {
    const w = W(ctx);
    return {
      body: wizScreen(
        ctx,
        4,
        `<h1 class="t-title-1 wiz-title">Privacy &amp; reminders</h1>
        <p class="t-callout wiz-lead">Optional. Choose what shows where — change it any time.</p>
        <div style="margin-top:24px" data-anno="9">${ui.listGroup({
          title: 'Privacy',
          rows: [
            ui.listRow({ kind: 'toggle', iconName: 'eye-off', label: 'Private achievement', sub: 'Hidden on Today, in notifications and on share cards until you reveal it.', on: !!w.private }),
            ui.listRow({ kind: 'toggle', iconName: 'hash', label: 'Hide numbers on overview screens', sub: 'For weight or money: overviews show the trend only.', on: !!w.hideNumbers }),
          ],
        })}</div>
        <div style="margin-top:24px" data-anno="10">${ui.listGroup({
          title: 'Reminders',
          rows: [
            ui.listRow({ kind: 'toggle', iconName: 'bell', label: 'Remind me about habits', sub: 'Only on days you haven’t checked in yet.', on: w.reminders !== false }),
            ui.listRow({ kind: 'link', iconName: 'clock', label: 'Time', value: `<span class="tnum">${w.reminderTime || '18:30'}</span>` }),
          ],
          footer: `Reminders say “2 quests today”. Quest names appear only if you allow them in Settings — never for private achievements. The first time a reminder is switched on, your phone asks whether Questline may send notifications.`,
        })}</div>`,
        'Create achievement',
        { skip: true },
      ),
    };
  };

  /* ───────── Add / edit quest sheet ───────── */
  const miniStepper = (value, label) =>
    `<span class="mini-stepper" role="group" aria-label="${esc(label)}">${iconButton({ iconName: 'minus', label: `Fewer: ${label}` })}<span class="mini-stepper__value" aria-live="polite">${value}</span>${iconButton({ iconName: 'plus', label: `More: ${label}` })}</span>`;

  S.questSheetOverlay = (ctx) => {
    const sq = ctx.sheetQuest;
    const q = sq.quest;
    const kind = q.type;
    const xp = ui.questXp(q);
    const ids = ctx.ids;
    let typeFields = '';
    if (kind === 'habit') {
      typeFields = `<div class="field" data-anno="${sq.anno || 2}"><span class="field__label">How often</span>
          <div class="sched">
            <span class="t-subhead c-secondary">Times</span><span class="row" style="--gap:12px;flex-wrap:wrap">${miniStepper(q.habit.times, 'times per period')}${ui.segmented({ label: 'Per', selected: q.habit.period, options: [['day', 'a day'], ['week', 'a week']] })}</span>
            <span class="t-subhead c-secondary">For</span><span class="row" style="--gap:12px">${miniStepper(q.habit.count, `number of ${q.habit.period}s`)}<span class="t-subhead">${q.habit.period}s</span></span>
          </div></div>
        <div class="field"><span class="field__label" id="${ids}-st">Starts</span><button type="button" class="field__control" aria-labelledby="${ids}-st ${ids}-sv" style="text-align:left"><span class="field__value tnum" id="${ids}-sv">Today, 05.11.2026</span>${icon('calendar', 'c-secondary')}</button>
          <p class="field__helper t-footnote">The first week runs until Sunday, 15.11. After that, weeks run Monday to Sunday.</p></div>`;
    } else if (kind === 'target') {
      typeFields = `<div data-anno="${sq.anno || 2}"><div class="field-row">${ui.field({ label: 'Start value', value: fmt.num(q.target.start) })}${ui.field({ label: 'Target value', value: fmt.num(q.target.goal) })}</div>
        <div style="margin-top:16px">${ui.field({ label: 'Unit', value: q.target.unit, helper: 'Like km, kg, CHF, chapters.' })}</div>
        <p class="callout t-footnote" style="margin-top:12px">${icon('trending-up', 'icon--sm')}<span>Going up: ${fmt.num(q.target.start)} → ${fmt.num(q.target.goal)} ${esc(q.target.unit)}. Log a value whenever you like — the latest one counts.</span></p></div>`;
    }
    const prereq = sq.prereqTitle || 'None';
    return `<div class="scrim" data-action="close-sheet"></div>
      <div class="sheet sheet--docked sheet--large qsheet" role="dialog" aria-modal="true" aria-labelledby="${ids}-qs">
        <div class="sheet__grabber" aria-hidden="true"></div>
        <div class="sheet__header"><h2 class="t-title-3" id="${ids}-qs">${sq.mode === 'edit' ? 'Edit quest' : 'Add quest'}</h2>${iconButton({ iconName: 'x', label: 'Close', extra: { 'data-action': 'close-sheet' } })}</div>
        <div class="stack" style="--gap:20px">
          <div data-anno="${sq.annoTitle || 1}">${ui.field({ label: 'Quest', value: q.title })}</div>
          <div class="field"><span class="field__label" id="${ids}-ty">Type</span>${ui.segmented({ label: 'Quest type', selected: kind, block: true, options: [['one_time', 'One-time'], ['habit', 'Habit'], ['target', 'Target']] })}
            <p class="field__helper t-footnote">${{ one_time: 'Do it once, like “Register for the exam”.', habit: 'Repeat on a schedule and build a streak.', target: 'Reach a number, up or down.' }[kind]}</p></div>
          ${typeFields}
          <div class="field" data-anno="${sq.annoSize || 3}"><span class="field__label">Size</span>${ui.segmented({ label: 'Size', selected: q.size, block: true, options: [['S', 'S', '', '10 XP'], ['M', 'M', '', '25 XP'], ['L', 'L', '', '50 XP']] })}
            <p class="field__helper t-footnote tnum">${kind === 'habit' ? `This habit is worth ${xp} XP. Longer habits earn more: up to 4 weeks ×1, 8 weeks ×1.5, 16 weeks ×2, longer ×3.` : `Worth ${xp} XP when it’s done.`}</p></div>
          <div data-anno="${sq.annoMore || 4}">${ui.listGroup({
            rows: [
              ui.listRow({ kind: 'link', iconName: 'lock', label: 'Unlocks after', value: esc(prereq) }),
              ui.listRow({ kind: 'toggle', iconName: 'star', label: 'Bonus quest', sub: 'Optional: gives XP but doesn’t block unlocking.', on: !!q.bonus }),
              ui.listRow({ kind: 'toggle', iconName: 'bell', label: 'Reminder', sub: kind === 'habit' ? '18:30, on days you haven’t checked in' : kind === 'one_time' ? 'Saturday, 12.12.2026, 09:00' : 'Mondays, 07:30', on: !!sq.reminder }),
            ],
          })}</div>
          ${ui.field({ label: 'Notes', optional: true, area: true, placeholder: 'Anything that helps', value: q.notes || '' })}
          ${sq.mode === 'edit' ? button({ label: 'Delete quest…', variant: 'text', iconName: 'trash-2', extra: { style: 'color:var(--state-danger-fg)' } }) : ''}
        </div>
        <div class="sheet__footer sheet__footer--sticky">${button({ label: sq.mode === 'edit' ? 'Save changes' : 'Add quest', size: 'lg', block: true, extra: { 'data-action': 'sheet-save' } })}</div>
      </div>`;
  };

  /* A frame that shows only the sheet over a dimmed wizard step 3. */
  S.questSheet = (ctx) => {
    const base = S.wizard3(ctx);
    return { body: base.body, overlay: S.questSheetOverlay(ctx) };
  };

  /* ───────── Quest detail ───────── */
  const histList = (rows) => `<ul class="card card--flush hist">${rows.join('')}</ul>`;

  S.questDetail = (ctx) => {
    const [aid, qid] = (ctx.questKey || 'exams/study').split('/');
    const a = data.byId(aid, ctx.state.achievements);
    const q = a.quests.find((x) => x.id === qid);
    const ids = ctx.ids;
    const nav = ui.navBar({ back: a.title, actions: q.state === 'locked' ? '' : iconButton({ iconName: 'pencil', label: 'Edit quest' }) + iconButton({ iconName: 'ellipsis', label: 'More actions' }) });
    const head = `<header class="detail-head" data-anno="1">
        <div class="row" style="--gap:6px;flex-wrap:wrap">${ui.tag(data.TYPE_LABEL[q.type], 'outline', data.TYPE_ICON[q.type])}${q.state === 'locked' ? ui.tag('Locked', 'locked', 'lock') : ''}${q.bonus ? ui.tag('Bonus', 'bonus', 'star') : ''}</div>
        <h1 class="t-title-1" style="margin-top:12px">${esc(q.title)}</h1>
        <p class="detail-head__meta t-footnote">${q.type === 'habit' ? `${icon('repeat', 'icon--sm')}<span>${ui.habitScheduleText(q)}</span>` : q.type === 'target' ? `${icon('target', 'icon--sm')}<span class="tnum">${ui.targetValue(q, q.target.start)} → ${ui.targetValue(q, q.target.goal)}</span>` : ''}<span class="dot-sep"></span>${ui.xpTag(q.xp)}${q.durationFactor > 1 ? `<span class="c-tertiary">×${q.durationFactor} for its length</span>` : ''}</p>
      </header>`;
    let content = '';

    if (q.state === 'locked') {
      const pre = a.quests.find((x) => x.id === q.after);
      content = `<div style="margin-top:24px" data-anno="2">${ui.notice({
        iconName: 'lock',
        title: `Unlocks after “${esc(pre.title)}”`,
        body: `You can plan it now; check-ins open once “${esc(pre.title)}” is done.`,
        actions: button({ label: `Open “${pre.title}”`, variant: 'secondary', size: 'sm', iconName: 'arrow-right' }),
      })}</div>
      <div class="card" style="margin-top:12px"><p class="t-subhead" style="font-weight:600">${esc(pre.title)}</p>
        <div class="qpath__progress">${ui.bar({ p: pre.progress, cls: 'bar--sm', label: `${pre.title} progress`, valueText: ui.targetProgressText(pre) })}<span class="t-footnote tnum c-secondary">${ui.targetProgressText(pre)}</span></div></div>
      <section class="section"><h2 class="t-title-3">Notes</h2><p class="t-callout c-secondary" style="margin-top:8px">Book the practice room for Saturdays.</p></section>`;
    } else if (q.type === 'habit') {
      const calDone = new Set(data.studyDays);
      content = `<div class="tiles" style="margin-top:20px" data-anno="2">
          <div class="tile"><span class="t-headline tnum">Week ${q.habit.periodIndex} of ${q.habit.count}</span><span class="t-footnote">${fmt.pct(q.progress)} done</span></div>
          <div class="tile"><span class="t-headline tnum">${q.habit.doneThisPeriod} of ${q.habit.times}</span><span class="t-footnote">this week</span></div>
          <div class="tile"><span class="t-headline tnum">${ui.streak(q.streak)}</span><span class="t-footnote">best ${ui.streakText({ ...q.streak, current: q.streak.best })}</span></div>
        </div>
        <div style="margin-top:16px">${button({ label: 'Check in', size: 'lg', block: true, iconName: 'check' })}</div>
        <section class="section" aria-labelledby="${ids}-cal" data-anno="3">
          <div class="section__header"><h2 class="t-title-3" id="${ids}-cal">Streak calendar</h2></div>
          <div class="card">
            ${ui.monthCalendar({ year: 2026, month: 10, done: calDone, today: data.TODAY, runStart: q.habit.start, runEnd: '2026-12-06' })}
            ${ui.monthCalendar({ year: 2026, month: 11, done: calDone, today: data.TODAY, runStart: q.habit.start, runEnd: '2026-12-06' })}
            <div class="cal-legend t-footnote"><span><i style="background:var(--state-done-solid)"></i>Checked in</span><span><i style="box-shadow:inset 0 0 0 1.5px var(--state-missed-border)"></i>No check-in</span><span><i style="background:var(--state-upcoming)"></i>Ahead</span></div>
          </div>
        </section>
        <section class="section" data-anno="4">
          <div class="section__header"><h2 class="t-title-3">History</h2><a href="#" class="btn btn--text btn--sm">See all</a></div>
          ${histList(
            data.studyLog.map(
              (h) => `<li><span class="hist__dot" aria-hidden="true">${icon('check')}</span><div><p class="t-subhead tnum" style="font-weight:600">${fmt.weekdayDate(h.date).split(',')[0]}, ${fmt.date(h.date)} · ${h.time}</p>${h.note ? `<p class="hist__note t-footnote">“${esc(h.note)}”</p>` : ''}</div><span></span></li>`,
            ),
          )}
          <p class="t-footnote c-tertiary" style="margin-top:8px">Today’s check-ins can be undone until midnight. Earlier days can be added as history; they don’t count toward the streak.</p>
        </section>
        <section class="section"><h2 class="t-title-3">Notes</h2><p class="t-callout c-secondary" style="margin-top:8px">Library on Tuesdays, my desk at home otherwise. Phone in the other room.</p></section>`;
    } else {
      const t = q.target;
      const log = data.savingsLog;
      content = `<div class="tiles" style="margin-top:20px" data-anno="2">
          <div class="tile"><span class="t-headline tnum">${ui.targetValue(q, t.current)}</span><span class="t-footnote">now</span></div>
          <div class="tile"><span class="t-headline tnum">${ui.targetValue(q, t.goal)}</span><span class="t-footnote">goal</span></div>
          <div class="tile"><span class="t-headline tnum">${fmt.pct(q.progress)}</span><span class="t-footnote">of the way</span></div>
        </div>
        <div style="margin-top:16px">${button({ label: 'Log progress', size: 'lg', block: true, iconName: 'plus' })}</div>
        <section class="section" data-anno="3">
          <div class="section__header"><h2 class="t-title-3">Progress</h2><span class="t-footnote c-secondary">since ${fmt.date(a.createdAt)}</span></div>
          <div class="card">${ui.lineChart({ points: log.map((l) => ({ date: l.date, value: l.value })), start: t.start, goal: t.goal, from: a.createdAt, to: data.TODAY, unit: t.unit, money: t.unit === 'CHF', title: `${q.title}: value over time` })}</div>
        </section>
        <section class="section" data-anno="4">
          <div class="section__header"><h2 class="t-title-3">History</h2></div>
          ${histList(
            [...log].reverse().map(
              (h, i) => `<li><span class="hist__dot ${i ? 'hist__dot--history' : ''}" aria-hidden="true">${icon(i ? 'circle' : 'check')}</span><div><p class="t-subhead tnum" style="font-weight:600">${fmt.date(h.date)}</p>${h.note ? `<p class="hist__note t-footnote">“${esc(h.note)}”</p>` : ''}</div><span class="hist__value t-subhead">CHF ${fmt.num(h.value)}</span></li>`,
            ),
          )}
          <p class="t-footnote c-tertiary" style="margin-top:8px">The latest value counts. Earlier values stay as history.</p>
        </section>`;
    }
    return {
      body: `<div class="screen">${nav}<div class="screen__content">${head}${content}</div>${tabs('achievements', ctx)}</div>`,
    };
  };

  QL.annotations.achievements = [
    ['Filter by status', 'Active, Paused, Completed with counts — no Archive: completed achievements are the read-only archive (R-ACH-07). The choice is remembered.'],
    ['Cards', 'Ring with the category icon, title, progress, days left and the next quest; one card = one link, read as one sentence. Private ones show “Private achievement · Tap to show” (or Face ID with App lock). Paused ones show the paused ring and “starts fresh when resumed”.'],
    ['Archive', 'Completed cards carry the badge and rank. Completed achievements can’t be edited or deleted (backend rule); they can be shared or made private.'],
    ['Paused detail', 'A calm card explains the restart before anything happens (R-ACH-06): Resume starts attempt 2 from 0 %; history stays. No red, no “failed”.'],
    ['Private behind App lock', 'With App lock on, a private achievement opens locked: title, quests and numbers replaced by fixed-length placeholders until Face ID / fingerprint / PIN. It locks again when the user leaves.'],
    ['Completed detail', 'Badge, rank and the reason for the rank in positive words; quest XP and rank bonus listed separately. Read-only: no edit, no Add quest; Share card is the main action.'],
    ['New achievement', 'iOS: prominent glass “+” in the top bar; Android: extended FAB above the navigation bar. Not a tab (HIG tab-bars.md).'],
    ['Row actions', 'iOS: swipe a card left for Pause and Delete (Resume and Delete when paused, Share when completed) — HIG designing-for-ios.md: let people swipe to initiate actions in a list row; filled symbols as sf-symbols.md suggests for swipe actions. They are shortcuts: the same actions stay in the detail screen’s ••• menu, VoiceOver offers them as custom actions, and Pause and Delete still confirm with the action sheet (no full-swipe delete). Android: Material lists don’t use swipe actions, so a long-press opens the same menu (TalkBack: custom actions).'],
  ];

  QL.annotations.wizard = [
    ['Goal', 'Full-screen modal from “New achievement” (iOS “+” in the top bar, Android FAB). Step 1 is the only required step: a title (1–120 characters). Close asks before discarding typed text.'],
    ['Category', 'Six single-select chips; Custom asks for a name. Stored in the API’s category field.'],
    ['Templates', 'Bundled with the app; picking one fills title, category and suggested quests (step 3) — everything stays editable.'],
    ['Why it matters', 'Optional; shown on the achievement in italics. Step 2 and step 4 have Skip.'],
    ['Target date', 'Optional; the system date picker in the device locale. Helper text explains that finishing on time counts toward the rank (R-RANK-01) — no pressure language.'],
    ['Suggested quests', 'Checkbox rows (whole row toggles); unticked suggestions stay visible, muted. Each shows type, schedule and XP. Long-press or the “Move” action reorders (no drag-only interaction).'],
    ['Own quests', 'Opens the Add quest sheet. A new quest is highlighted when it lands in the list.'],
    ['XP to unlock', 'Sum of the required quests’ XP, as the server will compute it; bonus quests excluded.'],
    ['Privacy', 'Both switches off by default; private and hide-numbers are stored on the achievement (API field for hide-numbers: requested, see README).'],
    ['Reminders', 'Habit reminders on by default only after the user saw this step; quiet text by default. The system notification permission is requested here, in context, the first time a reminder is switched on — never at launch and without a custom pre-prompt (HIG privacy.md). Denied → the switch stays off with a link to the phone’s Settings. The time syncs across devices (requested API field); each phone schedules its own local notification.'],
  ];

  QL.annotations.quests = [
    ['Quest sheet', 'Bottom sheet, medium and large detents; the title field gets focus first. The type can’t change after the first check-in (R-QST-07).'],
    ['Type fields', 'Habit: times per day or week, length, start (today or later — A-28; the first week runs to the end of the first full week, Q-33). Target: start, target (≠ start), unit; direction detected from the numbers.'],
    ['Size and XP', 'S / M / L = 10 / 25 / 50 XP. Habits show their effective XP with the duration factor (R-XP-02), so longer habits visibly pay more.'],
    ['More', 'Unlocks after: one quest of the same achievement, no cycles (R-QST-02). Bonus: optional, never blocks unlocking. Reminder: per type (habit: time on open days; one-time: date + time; target: weekday + time).'],
  ];

  QL.annotations.questDetail = [
    ['Header', 'Type, title, schedule or start → target, and the XP it pays on completion with its duration factor.'],
    ['Numbers', 'Three tiles that reflow to one column at large text. For achievements with hidden numbers, values here appear after a tap on “Show values”.'],
    ['Calendar / chart', 'Habit: month calendar (week starts on the account’s week start), done days filled, days without a check-in hollow and neutral, days ahead muted. Target: line chart with the goal as a dashed line, latest value labelled; both have a table for screen readers.'],
    ['History', 'Newest first, with notes. Today’s check-ins can be undone until midnight (Q-36); back-dated entries (up to 7 days) are marked as history and don’t count (R-CHK-04).'],
    ['Locked quest', 'Explains what unlocks it and shows that quest’s progress with a shortcut to it. No check-in button until it unlocks (the API refuses it, R-CHK-05).'],
  ];
})(window.QL);
