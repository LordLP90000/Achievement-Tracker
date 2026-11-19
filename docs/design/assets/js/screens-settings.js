/* Pass 2 screens: profile, settings, privacy & data centre, account deletion, and the system surfaces around the app
   (lock-screen notifications, app switcher). */
(function (QL) {
  const { ui, data, fmt } = QL;
  const { icon, esc, button } = ui;
  const S = QL.screens;
  const L = ui.listRow;

  const page = (ctx, { back = 'Profile', title, lead = '', content, tab = 'profile', anno = '' }) => ({
    body: `<div class="screen">${back ? ui.navBar({ back }) : ''}<div class="screen__content">
      ${title ? `<h1 class="t-large-title" style="margin-top:4px"${anno ? ` data-anno="${anno}"` : ''}>${title}</h1>` : ''}
      ${lead ? `<p class="t-callout c-secondary" style="margin-top:8px">${lead}</p>` : ''}
      <div class="stack" style="--gap:24px;margin-top:20px">${content}</div>
    </div>${tab ? ui.tabBar(tab, { label: `Main, ${ctx.label}` }) : ''}</div>`,
  });

  const bio = (ctx) => (ctx.platform === 'android' ? 'fingerprint' : 'Face ID');

  /* ───────── Profile and settings ───────── */
  S.profile = (ctx) => {
    const u = ctx.state.user;
    return {
      body: `<div class="screen">
        ${ui.rootBar(ctx.platform)}<header class="screen-header"><h1 class="screen-header__title t-large-title">Profile</h1></header>
        <div class="screen__content">
          <div class="card row" style="--gap:16px;margin-top:20px" data-anno="1">${ui.avatar('L')}<div style="flex:1;min-width:0"><p class="t-title-3">${esc(u.nickname)}</p><p class="t-footnote c-secondary" style="overflow-wrap:anywhere">${esc(u.email)}</p><p class="t-footnote c-secondary tnum">Level ${u.level} · ${fmt.num(u.xp)} XP</p></div></div>
          <div class="stack" style="--gap:24px;margin-top:24px">
            <div data-anno="2">${ui.listGroup({
              title: 'Settings',
              rows: [
                L({ iconName: 'user-round', label: 'Account', sub: 'Name, email, password, time zone' }),
                L({ iconName: 'shield-check', label: 'Security', sub: 'Passkey · two-step verification on', tone: 'done' }),
                L({ iconName: 'bell', label: 'Notifications', value: 'Generic' }),
                L({ iconName: 'sparkles', label: 'Celebrations', value: 'Full' }),
                L({ iconName: 'lock-keyhole', label: 'App lock', value: 'Off' }),
                L({ iconName: 'dices', label: 'XP gambles', value: 'Off' }),
              ],
            })}</div>
            <div data-anno="3">${ui.listGroup({ title: 'Privacy', rows: [L({ iconName: 'database', label: 'Privacy & data', sub: 'What’s stored, consent, download, delete', tone: 'accent' })] })}</div>
            ${ui.listGroup({ title: 'Support', rows: [L({ iconName: 'circle-help', label: 'Help & feedback' }), L({ iconName: 'info', label: 'About Questline', value: 'Version 1.0' })] })}
            ${button({ label: 'Sign out', variant: 'secondary', block: true, iconName: 'log-out' })}
          </div>
        </div>
        ${ui.tabBar('profile', { label: `Main, ${ctx.label}` })}
      </div>`,
    };
  };

  S.account = (ctx) =>
    page(ctx, {
      title: 'Account',
      content: [
        ui.listGroup({
          rows: [
            L({ label: 'Nickname', value: 'Lena' }),
            L({ label: 'Email', value: esc(data.user.email), sub: 'Changing it needs your passkey or password.' }),
            L({ label: 'Password', value: 'Change' }),
          ],
        }),
        `<div data-anno="4">${ui.listGroup({
          title: 'Dates and time',
          rows: [L({ iconName: 'globe', label: 'Time zone', value: 'Europe/Zurich' }), L({ iconName: 'calendar', label: 'Week starts on', value: 'Monday' }), L({ iconName: 'languages', label: 'Language', value: 'English (phone)' })],
          footer: 'Dates and numbers follow your phone’s region: 05.11.2026, 18:40, 6’000. “Today” follows the time zone above — update it when you travel.',
        })}</div>`,
      ].join(''),
    });

  S.security = (ctx) => {
    const signOut = button({ label: 'Sign out', variant: 'secondary', size: 'sm' });
    return page(ctx, {
      title: 'Security',
      lead: 'Changes here ask for your passkey or password first.',
      content: [
        `<div data-anno="5">${ui.listGroup({
          title: 'Passkeys',
          rows: [
            L({ iconName: 'key-round', label: data.passkeys[0].name, sub: `Added ${fmt.date(data.passkeys[0].created)} · used ${data.passkeys[0].lastUsed.toLowerCase()}`, tone: 'done' }),
            L({ kind: 'button', iconName: 'circle-plus', label: 'Add a passkey' }),
          ],
          footer: 'Sign in with Face ID or your fingerprint. Passkeys can’t be phished or guessed.',
        })}</div>`,
        `<div data-anno="6">${ui.listGroup({
          title: 'Two-step verification',
          rows: [L({ iconName: 'smartphone', label: 'Authenticator app', value: 'On' }), L({ iconName: 'list-checks', label: 'Recovery codes', value: `${data.user.recoveryCodesLeft} left` })],
          footer: 'Keep your recovery codes somewhere safe: without them and your phone, nobody can get back into the account — not even Questline support.',
        })}</div>`,
        `<div data-anno="7">${ui.listGroup({
          title: 'Devices signed in',
          rows: data.sessions.map((s) =>
            L({
              kind: 'static',
              iconName: s.platform === 'android' ? 'smartphone' : s.label === 'iPad' ? 'tablet-smartphone' : 'smartphone',
              label: s.label,
              sub: `${s.current ? 'This device · ' : ''}${s.platform === 'ios' ? 'iOS' : 'Android'} · ${s.current ? 'active now' : `last active ${s.lastUsed}`}`,
              value: s.current ? ui.tag('This device', 'done', 'check') : signOut,
            }),
          ),
        })}</div>`,
        button({ label: 'Sign out of all other devices', variant: 'danger', block: true, iconName: 'log-out' }),
      ].join(''),
    });
  };

  S.notifications = (ctx) =>
    page(ctx, {
      title: 'Notifications',
      content: [
        `<div data-anno="8">${ui.listGroup({
          rows: [L({ kind: 'toggle', iconName: 'smartphone', label: 'Reminders on this phone', sub: 'Reminder times sync to all your devices. Each phone decides whether it reminds you.', on: true })],
        })}</div>`,
        ui.listGroup({ title: 'Daily summary', rows: [L({ kind: 'toggle', iconName: 'bell', label: 'Morning summary', on: true }), L({ iconName: 'clock', label: 'Time', value: '<span class="tnum">08:00</span>' })] }),
        `<div data-anno="9">${ui.listGroup({
          title: 'What notifications say',
          rows: [
            ui.radioRow({ label: 'Generic', hint: '“2 quests today” — nothing about your goals.', checked: true, name: 'n' }),
            ui.radioRow({ label: 'Quest names', hint: '“Study 30 min · 3 of 5 this week”. Private achievements always stay generic.', checked: false, name: 'n' }),
          ],
          footer: 'On the lock screen, previews follow your phone’s notification settings.',
        }).replace('<ul class="lgroup__list">', '<ul class="lgroup__list" role="radiogroup" aria-label="What notifications say">')}</div>`,
      ].join(''),
    });

  /* No in-app theme or text-size setting: light/dark and text size follow the phone (HIG dark-mode.md,
     settings.md). Celebrations stays — it is about this app's confetti, not a system setting. */
  S.celebrations = (ctx) =>
    page(ctx, {
      title: 'Celebrations',
      content: [
        `<div data-anno="10">${ui.listGroup({
          rows: [ui.radioRow({ label: 'Full', hint: 'Confetti, pops and a little bounce.', checked: true, name: 'c' }), ui.radioRow({ label: 'Calm', hint: 'Short fades, no confetti.', checked: false, name: 'c' })],
          footer: 'Calm is used automatically when your phone reduces motion. Light or dark mode and text size follow your phone’s settings.',
        }).replace('<ul class="lgroup__list">', '<ul class="lgroup__list" role="radiogroup" aria-label="Celebrations">')}</div>`,
      ].join(''),
    });

  S.appLock = (ctx) =>
    page(ctx, {
      title: 'App lock',
      lead: `Lock Questline with ${bio(ctx)}, so what’s private stays private — even on an unlocked phone.`,
      content: [
        `<div data-anno="11">${ui.listGroup({
          rows: [
            L({ kind: 'toggle', iconName: bio(ctx) === 'Face ID' ? 'scan-face' : 'fingerprint', label: 'Lock Questline', sub: `Unlock with ${bio(ctx)}, or your PIN if that doesn’t work.`, on: true }),
            L({ label: 'Change PIN' }),
          ],
        })}</div>`,
        ui.listGroup({
          title: 'Lock',
          rows: [ui.radioRow({ label: 'Immediately', checked: true, name: 'l' }), ui.radioRow({ label: 'After 1 minute', checked: false, name: 'l' }), ui.radioRow({ label: 'After 5 minutes', checked: false, name: 'l' })],
        }).replace('<ul class="lgroup__list">', '<ul class="lgroup__list" role="radiogroup" aria-label="Lock">'),
        `<div data-anno="12">${ui.listGroup({
          title: 'Privacy',
          rows: [
            L({ kind: 'toggle', iconName: 'eye-off', label: 'Hide content in the app switcher', sub: 'Always on while App lock is on.', on: true }),
            L({ kind: 'toggle', iconName: 'lock', label: `Ask for ${bio(ctx)} to show private content`, on: true }),
          ],
        })}</div>`,
      ].join(''),
    });

  /* ───────── Privacy & data centre ───────── */
  const STORE = [
    ['user-round', 'Your account', 'Email address and a scrambled password.', 'To sign you in and send security notices.'],
    ['flag', 'Your goals', 'Achievements, quests, check-ins, notes and numbers.', 'So the app works on all your devices. Encrypted, and possibly health information — that’s why Questline asks first.'],
    ['shield-check', 'Security records', 'Sign-ins and account changes, kept 90 days.', 'To protect your account.'],
  ];

  S.privacy = (ctx) => {
    const overlay =
      ctx.dialog === 'withdraw'
        ? `<div class="scrim"></div>${ui.confirm({
            platform: ctx.platform,
            iconName: 'trash-2',
            title: 'Withdraw consent?',
            message: 'All goals are deleted right away: every achievement with its quests, check-ins and notes, and the XP, levels and badges they earned. The account stays — agree again any time to start fresh.',
            action: 'Withdraw and delete goals',
          })}`
        : ctx.dialog === 'reauth'
          ? S.reauthSheet(ctx, 'Downloading your data needs your passkey or password.', 'You can download your data twice a day. Keep the file somewhere safe — it contains everything.')
          : '';
    return {
      ...page(ctx, {
        title: 'Privacy & data',
        lead: 'What Questline keeps, why — and how to take it with you or delete it.',
        anno: 1,
        content: [
          `<section><h2 class="t-title-3" style="margin-bottom:12px">What’s stored</h2><ul class="store-list" data-anno="2">${STORE.map(
            ([ic, t, what, why]) => `<li class="card store-item"><span class="lrow__icon" aria-hidden="true">${icon(ic)}</span><div><p class="t-headline">${t}</p><p class="t-subhead">${what}</p><p class="t-footnote why">${why}</p></div></li>`,
          ).join('')}
          <li class="card store-item store-item--never"><span class="lrow__icon" aria-hidden="true">${icon('ban')}</span><div><p class="t-headline">Never</p><p class="t-subhead">No ads, no trackers, no analytics, no selling.</p></div></li></ul></section>`,
          `<section data-anno="3"><h2 class="t-title-3" style="margin-bottom:12px">Your consent</h2><div class="card"><p class="t-headline">Store my goals</p><p class="t-footnote c-secondary">Agreed on ${fmt.date(data.user.consentOn)}. They may include health information.</p><div style="margin-top:12px">${button({ label: 'Withdraw…', variant: 'secondary', size: 'sm' })}</div></div></section>`,
          `<div data-anno="4">${ui.listGroup({
            title: 'Your data',
            rows: [
              L({ iconName: 'file-down', label: 'Download data', sub: 'Everything, as a JSON file. Asks for your passkey or password.' }),
              L({ iconName: 'user-x', label: 'Delete account', sub: 'Signs you out everywhere; deleted for good after 30 days.', tone: 'danger', danger: true }),
            ],
            footer: '<a href="#" class="link">Full privacy policy</a> · <a href="#" class="link">Contact support</a>',
          })}</div>`,
        ].join(''),
      }),
      overlay,
    };
  };

  S.reauthSheet = (ctx, why, note) =>
    `<div class="scrim"></div><div class="sheet sheet--docked" role="dialog" aria-modal="true" aria-labelledby="${ctx.ids}-ra">
      <div class="sheet__grabber" aria-hidden="true"></div>
      <div class="sheet__header"><h2 class="t-title-3" id="${ctx.ids}-ra">Confirm it’s you</h2>${ui.iconButton({ iconName: 'x', label: 'Close' })}</div>
      <p class="t-callout c-secondary">${why}</p>
      <div class="stack" style="--gap:16px;margin-top:20px" data-anno="5">
        ${button({ label: 'Continue with passkey', size: 'lg', block: true, iconName: 'key-round' })}
        ${ui.orDivider()}
        ${ui.passwordField({ label: 'Password' })}
        ${button({ label: 'Confirm with password', variant: 'secondary', size: 'lg', block: true })}
      </div>
      <p class="t-footnote c-tertiary" style="margin-top:16px">${note}</p>
    </div>`;

  const DELETE_STEPS = [
    ['log-out', 'You’re signed out on all your devices right away.'],
    ['calendar-clock', 'On 05.12.2026 — 30 days from today — your account and everything in it is deleted for good.'],
    ['rotate-ccw', 'Changed your mind? Sign in before then, or reset your password, and everything comes back.'],
    ['mail', 'One email confirms the request and another says when deletion is complete. No reminders, no “come back” messages.'],
  ];

  S.deleteExplain = (ctx) => ({
    body: `<div class="screen">${ui.navBar({ back: 'Privacy & data' })}<div class="screen__content">
      <h1 class="t-large-title" style="margin-top:4px">Delete your account</h1>
      <p class="t-callout c-secondary" style="margin-top:8px">Here’s exactly what happens.</p>
      <ul class="steps-list" style="margin-top:24px" data-anno="6">${DELETE_STEPS.map(([ic, t]) => `<li><span class="lrow__icon" aria-hidden="true">${icon(ic)}</span><span class="t-callout">${t}</span></li>`).join('')}</ul>
      <div class="card card--muted row" style="--gap:12px;margin-top:24px">${icon('file-down', 'c-secondary')}<span class="t-subhead" style="flex:1">Want a copy first?</span>${button({ label: 'Download data', variant: 'text', size: 'sm' })}</div>
    </div>
    ${ui.footer(`<div class="stack" style="--gap:8px" data-anno="7">${button({ label: 'Continue', variant: 'danger', size: 'lg', block: true })}${button({ label: 'Keep account', variant: 'secondary', size: 'lg', block: true })}</div>`)}
    </div>`,
    overlay:
      ctx.dialog === 'confirm'
        ? `<div class="scrim"></div>${ui.confirm({
            platform: ctx.platform,
            iconName: 'user-x',
            anno: 8,
            title: 'Delete your account?',
            message: 'It’s deleted for good on <strong>05.12.2026</strong>. Until then, signing in brings it back.',
            action: 'Delete account',
          })}`
        : ctx.dialog === 'reauth'
          ? S.reauthSheet(ctx, 'Deleting your account needs your passkey or password.', 'After this, one last confirmation.')
          : '',
  });

  S.deleted = () => ({
    body: `<div class="screen"><div class="auth" style="padding-top:72px;text-align:center" data-anno="9">
      <span class="mail-art" style="background:var(--bg-muted);color:var(--text-secondary)" aria-hidden="true">${icon('calendar-clock')}</span>
      <h1 class="t-title-1">Your account is scheduled for deletion</h1>
      <p class="t-body c-secondary">On 05.12.2026 Questline deletes your account and everything in it. You’ve been signed out on all devices.</p>
      <p class="t-body c-secondary">Until then, signing in cancels the deletion. An email confirms when it’s done.</p>
      <div class="stack" style="--gap:8px;margin-top:auto">${button({ label: 'Done', variant: 'secondary', size: 'lg', block: true })}${button({ label: 'Sign in to cancel', variant: 'secondary', size: 'lg', block: true })}</div>
    </div></div>`,
  });

  /* ───────── System surfaces ───────── */
  S.lockScreen = (ctx) => {
    const detailed = !!ctx.detailed;
    const items = detailed
      ? [
          ui.notification({ body: 'Study 30 min · 3 of 5 this week', time: '18:30', actions: ['Check In'] }),
          ui.notification({ body: '1 private quest today', time: '18:30' }),
          ui.notification({ body: 'Morning: 4 quests today', time: '08:00' }),
        ]
      : [ui.notification({ body: '2 quests today', time: '18:30' }), ui.notification({ body: '4 quests today', time: '08:00' })];
    return {
      body: `<div class="lockscreen" data-anno="${detailed ? 2 : 1}">
        ${icon('lock', 'icon--md')}
        <p class="lockscreen__date">Thursday 5 November</p>
        <p class="lockscreen__time tnum">18:30</p>
        <ul class="notifs" aria-label="Notifications">${items.join('')}</ul>
        <p class="lock-caption">${detailed ? 'Opted in to quest names: private achievements still say only “1 private quest today”.' : 'Default: generic text — nothing about the goals themselves.'}</p>
      </div>`,
    };
  };

  /* Widget content, computed the way the widget extension would: the same “Today” rules as the app. */
  const widgetData = (ctx) => {
    const { user, achievements } = ctx.state;
    const { due, upNext, done } = QL.screens.todaySections(achievements);
    const open = due.filter((i) => !i.a.isPrivate);
    const privateLeft = due.filter((i) => i.a.isPrivate).length;
    const rows = open.slice(0, 2).map((i) => ({ kind: 'check', title: i.q.title, meta: i.q.type === 'habit' ? ui.habitProgressText(i.q) : data.TYPE_LABEL[i.q.type] }));
    if (privateLeft) rows.push({ kind: 'private', title: `${privateLeft} private quest${privateLeft === 1 ? '' : 's'}`, meta: 'Names stay in the app' });
    const next = upNext.find((i) => !i.a.isPrivate);
    if (next && rows.length < 3) rows.push({ kind: next.q.type === 'target' ? 'log' : 'check', title: next.q.title, meta: next.q.type === 'target' ? ui.targetProgressText(next.q) : 'Up next' });
    // The longest streak that is still running: habits of active achievements only.
    const days = (st) => st.current * (st.unit === 'week' ? 7 : 1);
    const best = achievements
      .filter((a) => a.status === 'active')
      .flatMap((a) => a.quests.filter((q) => q.type === 'habit' && q.streak && q.streak.current > 0).map((q) => q.streak))
      .reduce((top, st) => (!top || days(st) > days(top) ? st : top), null);
    return {
      left: due.length,
      done: done.length,
      total: due.length + done.length,
      level: user.level,
      levelP: (user.xp - user.levelFloor) / (user.nextLevelAt - user.levelFloor),
      streakText: best ? `${best.current}-${best.unit} streak` : '',
      rows,
    };
  };

  S.homeWidgets = (ctx) => {
    const d = widgetData(ctx);
    return {
      body: `<div class="homescreen">
        <div class="hs-grid">
          <div data-anno="4">${ui.widgetSmall(d)}</div>
          <div class="hs-apps" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
        </div>
        <div class="hs-medium" data-anno="${ctx.appLock ? 6 : 5}">${ui.widgetMedium({ ...d, locked: !!ctx.appLock })}</div>
        <p class="hs-caption">${ctx.appLock ? 'App lock is on: counts only, no names, no buttons.' : 'Habits check in right from the widget; private quests stay unnamed.'}</p>
        <div class="hs-dock" aria-hidden="true">${ui.appIcon(60)}<span></span><span></span><span></span></div>
      </div>`,
    };
  };

  S.lockWidgets = (ctx) => {
    const d = widgetData(ctx);
    return {
      body: `<div class="lockscreen" data-anno="7">
        <p class="lockscreen__date">Thursday 5 <span class="lw-inline">${icon('circle-check', 'icon--sm')}${d.left} quests left today</span></p>
        <p class="lockscreen__time tnum">18:40</p>
        ${ui.lockWidgets(d)}
        <p class="lock-caption">Anyone can see the Lock Screen: counts and streaks only, never names.</p>
      </div>`,
    };
  };

  S.appSwitcher = () => ({
    body: `<div class="switcher" data-anno="3">
      <p class="switcher__label">${ui.appIcon(26)} Questline</p>
      <div class="switcher__card">
        <div class="switcher__privacy"><div class="switcher__privacy-inner">${ui.appIcon(72)}<p class="t-headline">Questline</p><p class="t-footnote">${icon('lock', 'icon--sm')} Locked</p></div></div>
      </div>
      <p class="lock-caption">With App lock on, the app switcher shows this cover instead of the last screen.</p>
    </div>`,
  });

  QL.annotations.profile = [
    ['Profile', 'Nickname (optional, A-01), email and level; the hub for every setting. One tap from the tab bar.'],
    ['Settings', 'Grouped rows with the current value on the right, so most settings can be checked without opening them.'],
    ['Privacy & data', 'A section of its own, never buried under “More”.'],
    ['Time zone', '“Today”, streaks and undo follow the account’s time zone (GET /me), not the phone’s; when the phone’s zone differs, a banner offers to update it.'],
    ['Passkeys', 'Name, when it was added and last used, whether it syncs. Adding or removing needs a fresh confirmation (R-AUTH-06).'],
    ['Two-step', 'Authenticator app and the number of recovery codes left; the warning about lost codes is plain, not alarming.'],
    ['Devices', 'Every signed-in device with platform and last activity (no location — the API keeps none); sign out per device or all others.'],
    ['Reminders on this phone', 'Reminder times sync (API field requested); this switch is per device, so a tablet can stay quiet.'],
    ['Notification text', 'Generic by default; quest names only on opt-in and never for private achievements (answer 5).'],
    ['Celebrations', 'Full or Calm; Calm is forced while the phone reduces motion. There is no theme or text-size setting: both follow the phone, as HIG dark-mode.md and settings.md ask (decided 05.11.2026).'],
    ['App lock', 'Face ID / fingerprint with PIN fallback; lock immediately or after 1 or 5 minutes.'],
    ['Privacy switches', 'App-switcher cover (always on with App lock) and biometrics for revealing private content.'],
  ];

  QL.annotations.privacy = [
    ['Privacy & data', 'Plain language first; the legal policy is one link away. Reached from Profile and from every consent text.'],
    ['What’s stored', 'Three groups that match the data inventory (account, goal content, security records), each with its reason — plus what never happens.'],
    ['Consent', 'The goal-content consent with its date. Withdrawing explains the consequences (all goal content and the XP, levels and badges it produced deleted at once, account stays — Q-10) with equal buttons and Cancel focused.'],
    ['Download and delete', 'Download asks for re-authentication (10 minutes, R-AUTH-06), at most twice a day, then hands the file to the share sheet without keeping a copy.'],
    ['Re-authentication', 'Passkey first, password as the alternative; with two-step on, the password is followed by the code.'],
    ['What deletion means', 'Every consequence in plain words, including the 30-day window and that signing in or a password reset brings the account back (R-PRIV-06, Q-48).'],
    ['No guilt', 'Continue and Keep account have the same size; no “we’ll miss you”, no extra steps beyond re-authentication and one confirmation.'],
    ['Final confirmation', 'Platform-native: an iOS action sheet (“Delete Account” in the destructive style on top, Cancel apart below) or a Material dialog (Cancel, then the red text button). States the date; Cancel has initial focus; no extra friction.'],
    ['After deletion', 'Signed out everywhere (all sessions end, the app clears its cache and tokens); the date and how to cancel are repeated. A second email confirms when deletion is complete (HIG managing-accounts.md; needs a backend job, see README).'],
  ];

  QL.annotations.system = [
    ['Generic by default', 'Local notifications (no server push in v1) say only how many quests are due. Lock-screen previews follow the phone’s settings.'],
    ['Quest names, opted in', 'Non-private quests may show their name and progress, plus one action, “Check In” (long-press; HIG notifications.md › beneficial actions) that checks in without opening the app — Android shows it as a notification button. Private achievements always stay generic and get no action.'],
    ['App-switcher cover', 'With App lock on, the snapshot is covered before the app goes to the background (iOS: overlay on scenePhase inactive; Android: FLAG_SECURE). Screenshots are blocked on Android; iOS hides content while the screen is recorded.'],
    ['Home Screen widgets', 'Small: quests left today, level ring and the best running streak — a Fraunces numeral for the large text and the system font for the rest (HIG widgets.md › Displaying text). Medium: up to three of today’s quests. Light and dark use the app’s colours; tinted and clear appearances desaturate everything, so meaning never depends on colour. Tapping a row opens that quest, anywhere else opens Today. Refreshes after each check-in and at midnight in the account’s time zone. Android: the same content as Glance widgets (2 × 2 and 4 × 2 cells) with Material You colours.'],
    ['Check in from the widget', 'Habits and one-time quests check in with one tap (iOS App Intent, Android Glance action) — the same API call, Idempotency-Key and same-day undo as in the app. Target quests need a value, so “+” opens the check-in sheet. Private achievements appear only as “2 private quests”, with no names and no buttons.'],
    ['App lock on', 'Widgets sit outside App lock, so with App lock on they show counts only — no names, no check-in buttons — and say why. Tapping opens the app, which asks for Face ID, fingerprint or PIN.'],
    ['Lock Screen widgets', 'Anyone can see the Lock Screen, so these never show names: the inline widget above the clock, a circular gauge of today’s check-ins and a rectangular summary with the best streak. Rendered monochrome and vibrant by the system and legible on the Always-On display (widgets.md › Rendering modes). Android phones have no Lock Screen widgets.'],
  ];
})(window.QL);
