/* Pass 2 boards: every other screen and state, annotated. Frames reuse the screens; `pinsOnly` / `pinMap` pick the
   notes that belong to each board. */
(function (QL) {
  const { data } = QL;
  const mount = (id, specs, annotations) => QL.board.mount(document.getElementById(id), specs, { annotations });
  // Long screens (settings, stats, detail) are easier to review whole; overlays still show in a phone viewport.
  QL.board.settings.length = 'full';

  /* State helpers (frame-local copies; the seed data never changes). */
  const reset = (a, extra = {}) => {
    a.quests.forEach((q) => {
      if (q.state === 'completed' || q.state === 'available') q.state = 'available';
      delete q.completedOn;
      delete q.doneToday;
      q.progress = 0;
      if (q.target) q.target.current = q.target.start;
      if (q.habit) {
        q.habit.doneThisPeriod = 0;
        q.streak = { ...q.streak, current: 0 };
      }
    });
    Object.assign(a, extra);
  };
  const pause = (id) => (ctx) => {
    reset(data.byId(id, ctx.state.achievements), { status: 'paused', pausedOn: '2026-11-01' });
    data.derive(ctx.state.achievements);
  };
  const nothingDue = (ctx) => {
    const list = ctx.state.achievements;
    const study = data.quest('exams', 'study', list);
    study.habit.doneThisPeriod = 5;
    study.streak = { ...study.streak, current: 4, best: 4 };
    reset(data.byId('weight', list), { status: 'paused', pausedOn: '2026-11-07' });
    data.derive(list);
  };
  const offline = (ctx) => {
    const q = data.quest('exams', 'study', ctx.state.achievements);
    Object.assign(q, { doneToday: true, doneAt: '18:36', syncing: true });
    data.derive(ctx.state.achievements);
  };

  QL.annotations.todayStates = [
    ['First launch', 'No achievements yet: Level 1 at 0 XP and one clear next step. “Browse templates” opens the wizard on its template list.'],
    ['Nothing due today', 'All habits met for their period (here: a Sunday with the week done and one achievement paused). A calm card instead of an empty list; Up next stays as an offer, not a duty.'],
    ['Loading', 'Skeletons in the shape of the real content (no spinner); text that is already known — date, greeting — shows at once. Announced once to screen readers; shimmer stops with Reduce Motion.'],
    ['Offline', 'Banner at the top; check-ins are queued with their Idempotency-Key and the card says “Waiting to sync”. Nothing is disabled. Conflicts after reconnecting reload the current state (409, client guide §4).'],
    ['Error', 'Calm wording, no codes or stack traces; Try again keeps the user on the screen. Problems are matched by type, never by the server’s text (RFC 9457).'],
  ];

  mount('board-auth', [
    { id: 'onb-1', title: 'Onboarding 1 · How it works', meta: 'Light', theme: 'light', screen: 'onboarding1' },
    { id: 'onb-2', title: 'Onboarding 2 · Privacy promise', meta: 'Light', theme: 'light', screen: 'onboarding2' },
    { id: 'onb-3', title: 'Onboarding 3 · First achievement', meta: 'Dark', theme: 'dark', screen: 'onboarding3' },
  ], 'auth');

  mount('board-signin', [
    { id: 'sign-up', title: 'Sign up', meta: 'Light', theme: 'light', screen: 'signUp' },
    { id: 'check-email', title: 'Check your email', meta: 'Light', theme: 'light', screen: 'checkEmail' },
    { id: 'sign-in', title: 'Sign in · error', meta: 'Dark', theme: 'dark', screen: 'signIn' },
    { id: 'two-step', title: 'Two-step code', meta: 'Light', theme: 'light', screen: 'twoFactor' },
  ], 'signin');

  mount('board-consent', [
    { id: 'consent-screen', title: 'Consent', meta: 'Light', theme: 'light', screen: 'consent' },
    { id: 'consent-summary', title: 'Privacy summary', meta: 'Light', theme: 'light', screen: 'consent', ctx: { summary: true }, pins: false },
    { id: 'passkey-offer', title: 'Passkey offer', meta: 'Dark', theme: 'dark', screen: 'passkeyOffer' },
  ], 'consent');

  mount('board-today-states', [
    { id: 'today-empty', title: 'Today · first launch', meta: 'Light', theme: 'light', screen: 'today', ctx: { variant: 'empty' }, pinsOnly: [2], pinMap: { 2: 1 } },
    { id: 'today-nothing', title: 'Today · nothing due', meta: 'Light · Sunday 08.11.', theme: 'light', screen: 'today', time: '09:30', ctx: { dateIso: '2026-11-08', greet: 'morning' }, before: nothingDue, pinsOnly: [3], pinMap: { 3: 2 } },
    { id: 'today-loading', title: 'Today · loading', meta: 'Dark', theme: 'dark', screen: 'today', ctx: { variant: 'loading' }, pinsOnly: [2], pinMap: { 2: 3 } },
    { id: 'today-offline', title: 'Today · offline', meta: 'Dark', theme: 'dark', screen: 'today', ctx: { variant: 'offline' }, before: offline, pinsOnly: [2], pinMap: { 2: 4 } },
    { id: 'today-error', title: 'Today · error', meta: 'Light', theme: 'light', screen: 'today', ctx: { variant: 'error' }, pinsOnly: [2], pinMap: { 2: 5 } },
  ], 'todayStates');

  mount('board-achievements', [
    { id: 'list-active', title: 'Achievements · active', meta: 'Light', theme: 'light', screen: 'achievements', pinsOnly: [1, 2, 7] },
    { id: 'list-paused', title: 'Achievements · paused (empty)', meta: 'Dark', theme: 'dark', screen: 'achievements', ctx: { filter: 'paused' }, pins: false },
    { id: 'list-completed', title: 'Achievements · completed', meta: 'Light', theme: 'light', screen: 'achievements', ctx: { filter: 'completed' }, pinsOnly: [3] },
    { id: 'list-swipe', title: 'Achievements · swipe actions', meta: 'Light · iOS', theme: 'light', screen: 'achievements', ctx: { swiped: 'flat' }, fixed: { platform: 'ios' }, pinsOnly: [8] },
    { id: 'list-press', title: 'Achievements · long-press menu', meta: 'Dark · Android', theme: 'dark', screen: 'achievements', ctx: { pressed: 'flat' }, fixed: { platform: 'android' }, pinsOnly: [8] },
    { id: 'detail-paused', title: 'Detail · paused', meta: 'Light', theme: 'light', screen: 'detail', ctx: { achievementId: 'flat' }, before: pause('flat'), pinsOnly: [4] },
    { id: 'detail-private', title: 'Detail · private, App lock on', meta: 'Dark', theme: 'dark', screen: 'detail', ctx: { achievementId: 'weight', privateLocked: true }, pinsOnly: [2], pinMap: { 2: 5 } },
    { id: 'detail-completed', title: 'Detail · completed (read-only)', meta: 'Light', theme: 'light', screen: 'detail', ctx: { achievementId: 'licence' }, pinsOnly: [3], pinMap: { 3: 6 } },
  ], 'achievements');

  const runningTemplate = () => JSON.parse(JSON.stringify(data.templates[0].quests));
  const wiz = (extra = {}) => ({
    template: 'running',
    title: 'Run the Silvesterlauf',
    category: 'health',
    why: 'Run through the old town with my sister.',
    date: '2026-12-13',
    quests: runningTemplate(),
    ...extra,
  });
  const ownQuest = { id: 'final', title: 'Run the Silvesterlauf', type: 'one_time', size: 'L', on: true, own: true, after: 'eightk' };

  mount('board-wizard', [
    { id: 'wiz-1', title: 'Create · 1 Goal', meta: 'Light · template picked', theme: 'light', screen: 'wizard1', ctx: { wiz: wiz() } },
    { id: 'wiz-2', title: 'Create · 2 Why and when', meta: 'Light', theme: 'light', screen: 'wizard2', ctx: { wiz: wiz() } },
    { id: 'wiz-3', title: 'Create · 3 Quests', meta: 'Light · own quest added', theme: 'light', screen: 'wizard3', ctx: { wiz: wiz({ quests: [...runningTemplate(), ownQuest] }) } },
    { id: 'wiz-4', title: 'Create · 4 Privacy & reminders', meta: 'Dark', theme: 'dark', screen: 'wizard4', ctx: { wiz: wiz() } },
  ], 'wizard');

  const tpl = runningTemplate();
  mount('board-quest-sheets', [
    { id: 'sheet-habit', title: 'Add quest · habit', meta: 'Light', theme: 'light', screen: 'questSheet', ctx: { wiz: wiz(), sheetQuest: { mode: 'add', quest: tpl[1], reminder: true } }, pinsOnly: [1, 2, 3, 4] },
    { id: 'sheet-target', title: 'Add quest · target', meta: 'Dark', theme: 'dark', screen: 'questSheet', ctx: { wiz: wiz(), sheetQuest: { mode: 'add', quest: tpl[2] } }, pinsOnly: [2] },
    { id: 'sheet-edit', title: 'Edit quest · one-time, unlocks after', meta: 'Light', theme: 'light', screen: 'questSheet', ctx: { wiz: wiz(), sheetQuest: { mode: 'edit', quest: { ...ownQuest, notes: 'Start block C, 11:20. Meet Sara at the Grossmünster.' }, prereqTitle: 'Run 8 km without stopping', reminder: true } }, pinsOnly: [4] },
  ], 'quests');

  mount('board-quest-detail', [
    { id: 'qd-habit', title: 'Quest detail · habit', meta: 'Light', theme: 'light', screen: 'questDetail', ctx: { questKey: 'exams/study' } },
    { id: 'qd-target', title: 'Quest detail · target', meta: 'Dark', theme: 'dark', screen: 'questDetail', ctx: { questKey: 'flat/save' } },
    { id: 'qd-locked', title: 'Quest detail · locked', meta: 'Light', theme: 'light', screen: 'questDetail', ctx: { questKey: 'exams/mocks' }, pinsOnly: [2], pinMap: { 2: 5 } },
  ], 'questDetail');

  mount('board-celebrations', [
    { id: 'cel-quest', title: 'Quest complete (small)', meta: 'Light · 05.11.', theme: 'light', screen: 'celebrateQuest', time: '18:44', pinsOnly: [1] },
    { id: 'cel-unlock', title: 'Achievement unlocked (full)', meta: 'Dark · race day', theme: 'dark', screen: 'unlockedScreen', time: '13:20', pinsOnly: [2] },
    { id: 'cel-unlock-calm', title: 'Achievement unlocked', meta: 'Light · reduced motion', theme: 'light', screen: 'unlockedScreen', time: '13:20', ctx: { reduced: true }, fixed: { motion: 'reduced' }, pins: false },
    { id: 'cel-level', title: 'Level up (medium)', meta: 'Light', theme: 'light', screen: 'levelUpScreen', time: '13:21', pinsOnly: [3] },
    { id: 'cel-share', title: 'Share card', meta: 'Light', theme: 'light', screen: 'share', time: '13:22', pinsOnly: [4, 5] },
  ], 'celebrations');

  mount('board-stats', [
    { id: 'stats-light', title: 'Stats', meta: 'Light', theme: 'light', screen: 'stats' },
    { id: 'stats-dark', title: 'Stats', meta: 'Dark · private shown', theme: 'dark', screen: 'stats', ctx: { revealed: true }, pins: false },
    { id: 'trophy', title: 'Trophy room', meta: 'Light', theme: 'light', screen: 'trophy' },
  ], 'stats');

  mount('board-gambles', [
    { id: 'gm-settings', title: 'XP gambles · settings', meta: 'Light · off', theme: 'light', screen: 'gambleSettings', pinsOnly: [1] },
    { id: 'gm-confirm', title: 'Turning gambles on', meta: 'Light', theme: 'light', screen: 'gambleSettings', ctx: { confirm: true }, pinsOnly: [2] },
    { id: 'gm-place', title: 'Placing a gamble', meta: 'Dark', theme: 'dark', screen: 'gamblePlace', pinsOnly: [3, 4, 5] },
    { id: 'gm-running', title: 'Gamble running', meta: 'Light', theme: 'light', screen: 'detail', ctx: { achievementId: 'exams', gamble: 'pending', gambleAnno: 6 }, pinsOnly: [6] },
    { id: 'gm-lost', title: 'Gamble ended', meta: 'Light · 30.01.2027', theme: 'light', screen: 'gambleLost', time: '08:05', pinsOnly: [7] },
  ], 'gambles');

  mount('board-profile', [
    { id: 'profile-screen', title: 'Profile', meta: 'Light', theme: 'light', screen: 'profile' },
    { id: 'account', title: 'Account', meta: 'Light', theme: 'light', screen: 'account' },
    { id: 'security', title: 'Security', meta: 'Dark', theme: 'dark', screen: 'security' },
    { id: 'notifications', title: 'Notifications', meta: 'Light', theme: 'light', screen: 'notifications' },
    { id: 'celebrations', title: 'Celebrations', meta: 'Light · no theme setting', theme: 'light', screen: 'celebrations' },
    { id: 'app-lock', title: 'App lock', meta: 'Dark', theme: 'dark', screen: 'appLock' },
  ], 'profile');

  mount('board-privacy', [
    { id: 'privacy-screen', title: 'Privacy & data', meta: 'Light', theme: 'light', screen: 'privacy', pinsOnly: [1, 2, 3, 4] },
    { id: 'withdraw', title: 'Withdraw consent', meta: 'Light · iOS action sheet', theme: 'light', screen: 'privacy', ctx: { dialog: 'withdraw' }, pins: false, fixed: { platform: 'ios' } },
    { id: 'withdraw-android', title: 'Withdraw consent', meta: 'Dark · Android dialog', theme: 'dark', screen: 'privacy', ctx: { dialog: 'withdraw' }, pins: false, fixed: { platform: 'android' } },
    { id: 'download', title: 'Download · confirm it’s you', meta: 'Dark', theme: 'dark', screen: 'privacy', ctx: { dialog: 'reauth' }, pinsOnly: [5] },
    { id: 'delete-explain', title: 'Delete account · 1 Explain', meta: 'Light', theme: 'light', screen: 'deleteExplain' },
    { id: 'delete-confirm', title: 'Delete account · 3 Final', meta: 'Dark · after re-auth', theme: 'dark', screen: 'deleteExplain', ctx: { dialog: 'confirm' }, pinsOnly: [8] },
    { id: 'deleted', title: 'Delete account · 4 Done', meta: 'Light', theme: 'light', screen: 'deleted' },
  ], 'privacy');

  mount('board-system', [
    { id: 'lock-generic', title: 'Lock screen · default', meta: 'Generic text', theme: 'dark', screen: 'lockScreen', time: '18:30' },
    { id: 'lock-detailed', title: 'Lock screen · opted in', meta: 'Private stays generic', theme: 'dark', screen: 'lockScreen', time: '18:30', ctx: { detailed: true } },
    { id: 'switcher', title: 'App switcher', meta: 'App lock on', theme: 'dark', screen: 'appSwitcher' },
    { id: 'widgets-home', title: 'Home Screen widgets', meta: 'Light · small and medium', theme: 'light', screen: 'homeWidgets', pinsOnly: [4, 5] },
    { id: 'widgets-applock', title: 'Widget · App lock on', meta: 'Dark · counts only', theme: 'dark', screen: 'homeWidgets', ctx: { appLock: true }, pinsOnly: [6] },
    { id: 'widgets-lock', title: 'Lock Screen widgets', meta: 'iOS · never names', theme: 'dark', screen: 'lockWidgets', fixed: { platform: 'ios' }, pinsOnly: [7] },
  ], 'system');

  QL.board.toolbar(document.getElementById('toolbar'));
})(window.QL);
