/* Pass 1 boards: Today and Achievement detail in light and dark, interaction states, large text and Android. */
(function (QL) {
  const mount = (id, specs, annotations) => QL.board.mount(document.getElementById(id), specs, { annotations });

  mount(
    'board-today',
    [
      { id: 'today-light', title: 'Today', meta: 'Light', theme: 'light', screen: 'today' },
      { id: 'today-dark', title: 'Today', meta: 'Dark', theme: 'dark', screen: 'today' },
      { id: 'today-revealed', title: 'Today · private shown', meta: 'Light', theme: 'light', screen: 'today', ctx: { revealed: true }, pins: false },
    ],
    'today',
  );

  mount(
    'board-detail',
    [
      { id: 'detail-light', title: 'Achievement detail', meta: 'Light · path', theme: 'light', screen: 'detail', ctx: { achievementId: 'exams' } },
      { id: 'detail-dark', title: 'Achievement detail', meta: 'Dark · path', theme: 'dark', screen: 'detail', ctx: { achievementId: 'exams' } },
      { id: 'detail-list', title: 'Achievement detail', meta: 'Light · list', theme: 'light', screen: 'detail', ctx: { achievementId: 'exams', view: 'list' }, pins: false },
    ],
    'detail',
  );

  mount('board-states', [
    { id: 'state-sheet', title: 'Check-in sheet', meta: 'Light · target quest', theme: 'light', screen: 'today', ctx: { revealed: true, sheet: 'weight/reach80' }, pins: false },
    {
      id: 'state-checked',
      title: 'Right after a check-in',
      meta: 'Dark · +10 XP, undo',
      theme: 'dark',
      screen: 'today',
      pins: false,
      before: (ctx) => QL.actions.checkIn(ctx, 'flat/extract'),
    },
    { id: 'state-pause', title: 'Pause confirmation', meta: 'Light', theme: 'light', screen: 'detail', ctx: { achievementId: 'exams', dialog: 'pause' }, pins: false },
  ]);

  mount('board-access', [
    { id: 'today-200', title: 'Today', meta: 'Light', theme: 'light', screen: 'today', fixed: { ts: 2 }, pins: false },
    { id: 'detail-200', title: 'Achievement detail', meta: 'Dark', theme: 'dark', screen: 'detail', ctx: { achievementId: 'exams' }, fixed: { ts: 2 }, pins: false },
    { id: 'today-android', title: 'Today', meta: 'Dark', theme: 'dark', screen: 'today', fixed: { platform: 'android' }, pins: false },
  ]);

  QL.board.toolbar(document.getElementById('toolbar'));
})(window.QL);
