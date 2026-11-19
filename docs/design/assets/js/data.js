/* Example data for the Questline design package. Every number follows the backend's rules
   (docs/requirements.md): effective XP = size XP × duration factor (R-XP-02), achievement progress =
   XP-weighted mean of the required quests (R-ACH-03), level thresholds 100 × 3^(L−2) (R-XP-03).
   "Now" is Thursday 05.11.2026, 18:40, account time zone Europe/Zurich, week starts on Monday.
   Formatting uses the en-CH locale: 24-hour time, DD.MM.YYYY, 6’000. */
window.QL = window.QL || {};

(function (QL) {
  const LOCALE = 'en-CH';
  const TODAY = '2026-11-05';

  const toUtc = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };

  const fmt = {
    date: (iso) => new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(toUtc(iso)),
    dayMonth: (iso) => {
      const [, m, d] = iso.split('-');
      return `${d}.${m}.`;
    },
    weekdayDate: (iso) =>
      new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(toUtc(iso)),
    num: (n, digits = 0) => new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n),
    pct: (p) => new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 0 }).format(p),
    daysBetween: (fromIso, toIso) => Math.round((toUtc(toIso) - toUtc(fromIso)) / 86400000),
  };

  /** "85 days left", neutral wording when the date has passed. */
  fmt.daysLeft = (iso) => {
    const n = fmt.daysBetween(TODAY, iso);
    if (n > 1) return `${n} days left`;
    if (n === 1) return '1 day left';
    if (n === 0) return 'Target date is today';
    return `Target date was ${fmt.date(iso)}`;
  };

  const CATEGORIES = {
    study: { label: 'Study', icon: 'graduation-cap' },
    health: { label: 'Health & Fitness', icon: 'heart-pulse' },
    independence: { label: 'Independence', icon: 'key-round' },
    career: { label: 'Career', icon: 'briefcase-business' },
    finance: { label: 'Finance', icon: 'piggy-bank' },
    custom: { label: 'Custom', icon: 'compass' },
  };

  const TYPE_LABEL = { one_time: 'One-time', habit: 'Habit', target: 'Target' };
  const TYPE_ICON = { one_time: 'circle-check', habit: 'repeat', target: 'target' };
  const SIZE_XP = { S: 10, M: 25, L: 50 };

  const user = {
    nickname: 'Lena',
    level: 3,
    xp: 465,
    levelFloor: 300,
    nextLevelAt: 900,
    email: 'lena.m@example.ch',
    timeZone: 'Europe/Zurich',
    weekStart: 'Monday',
    consentOn: '2026-03-01',
    twoFactor: true,
    recoveryCodesLeft: 8,
  };

  /* Sign-in methods and devices (GET /me/passkeys, GET /me/sessions). No locations: the API stores none. */
  const passkeys = [{ name: 'iCloud Keychain', created: '2026-03-01', lastUsed: 'Today, 07:58', synced: true }];
  const sessions = [
    { label: 'Lena’s iPhone', platform: 'ios', current: true, lastUsed: 'Active now', method: 'Passkey' },
    { label: 'iPad', platform: 'ios', lastUsed: '03.11.2026', method: 'Password + code' },
    { label: 'Pixel 8', platform: 'android', lastUsed: '12.10.2026', method: 'Password + code' },
  ];

  /* XP per month in 2026 (GET /stats xp_by_day, summed in the app). Sums to the 465 XP above:
     Mar first aid 10 + theory 25 · May booking 10 + parking 75 + 20 h 25 · Jun driving test 25 + Silver bonus 255
     · Sep budget 10 · Oct check-up 10 + study plan 10 · Nov exam registration 10. */
  const xpByMonth = [0, 0, 35, 0, 110, 280, 0, 0, 10, 20, 10, 0];

  /* Check-in history. Study 30 min: 5× a week since Monday 12.10; this week Mon–Wed so far. */
  const studyDays = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-17', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-23', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-02', '2026-11-03', '2026-11-04'];
  const studyLog = [
    { date: '2026-11-04', time: '19:12', note: 'Summarised chapter 7. Statistics finally makes sense.' },
    { date: '2026-11-03', time: '18:40', note: '' },
    { date: '2026-11-02', time: '20:05', note: 'Library, with Mia.' },
    { date: '2026-10-31', time: '10:30', note: '' },
    { date: '2026-10-30', time: '17:45', note: '' },
  ];
  /* Save CHF 6’000: every value check-in (the latest one counts, R-QST-05). */
  const savingsLog = [
    { date: '2026-09-22', value: 1500, note: 'Moved my savings to a separate account.' },
    { date: '2026-09-30', value: 2400, note: '' },
    { date: '2026-10-15', value: 3100, note: '' },
    { date: '2026-10-25', value: 4300, note: 'Sold my old bike.' },
    { date: '2026-10-31', value: 5200, note: 'Side job at the café.' },
  ];

  /* Templates ship with the app (the backend has none); they only pre-fill the wizard. */
  const templates = [
    {
      id: 'running', title: 'Start running', category: 'health', blurb: 'From the couch to your first race.',
      quests: [
        { id: 'shoes', title: 'Buy running shoes', type: 'one_time', size: 'S', on: true },
        { id: 'runs', title: 'Run 3× a week', type: 'habit', size: 'M', on: true, habit: { times: 3, period: 'week', count: 4 } },
        { id: 'eightk', title: 'Run 8 km without stopping', type: 'target', size: 'M', on: true, target: { start: 0, goal: 8, unit: 'km' } },
        { id: 'buddy', title: 'Find a running buddy', type: 'one_time', size: 'S', on: true, bonus: true },
        { id: 'stretch', title: 'Stretch after every run', type: 'habit', size: 'S', on: false, habit: { times: 3, period: 'week', count: 4 } },
      ],
    },
    { id: 'exam', title: 'Ace an exam', category: 'study', blurb: 'Plan, practise, pass.', quests: [] },
    { id: 'move', title: 'Move out', category: 'independence', blurb: 'Budget, flat hunt, keys.', quests: [] },
    { id: 'fund', title: 'Build an emergency fund', category: 'finance', blurb: 'Three months of rent, step by step.', quests: [] },
    { id: 'job', title: 'Land a new job', category: 'career', blurb: 'CV, applications, interviews.', quests: [] },
  ];

  const achievements = [
    {
      id: 'exams',
      title: 'Pass my final exams',
      category: 'study',
      why: 'Finish my Bachelor and start my first job in spring.',
      targetDate: '2027-01-29',
      createdAt: '2026-10-12',
      status: 'active',
      isPrivate: false,
      attempt: 1,
      quests: [
        { id: 'plan', title: 'Make a study plan', type: 'one_time', size: 'S', xp: 10, state: 'completed', completedOn: '2026-10-14' },
        { id: 'register', title: 'Register for the exams', type: 'one_time', size: 'S', xp: 10, state: 'completed', completedOn: TODAY, completedAt: '10:20' },
        {
          id: 'study', title: 'Study 30 min', type: 'habit', size: 'L', xp: 75, durationFactor: 1.5, state: 'available',
          habit: { times: 5, period: 'week', count: 8, start: '2026-10-12', periodIndex: 4, doneThisPeriod: 3 },
          streak: { current: 3, best: 3, unit: 'week' },
          progress: 3 / 8,
          week: ['done', 'done', 'done', 'today', 'upcoming', 'upcoming', 'upcoming'],
        },
        { id: 'chapters', title: 'Read all 12 chapters', type: 'target', size: 'M', xp: 25, state: 'available', target: { start: 0, goal: 12, unit: 'chapters', current: 7, lastOn: '2026-11-04' }, progress: 7 / 12 },
        { id: 'group', title: 'Form a study group', type: 'one_time', size: 'S', xp: 10, bonus: true, state: 'available' },
        { id: 'mocks', title: 'Do 3 mock exams', type: 'target', size: 'M', xp: 25, state: 'locked', after: 'chapters', target: { start: 0, goal: 3, unit: 'mock exams', current: 0 }, progress: 0 },
        { id: 'sit', title: 'Sit all 4 exams', type: 'target', size: 'L', xp: 50, state: 'locked', after: 'mocks', target: { start: 0, goal: 4, unit: 'exams', current: 0 }, progress: 0 },
      ],
    },
    {
      id: 'weight',
      title: 'Lose 10 kg',
      category: 'health',
      why: 'Feel strong on my hiking trip in the Alps next summer.',
      targetDate: '2027-04-30',
      createdAt: '2026-10-01',
      status: 'active',
      isPrivate: true,
      hideNumbers: true,
      attempt: 1,
      quests: [
        { id: 'checkup', title: 'Book a check-up with my doctor', type: 'one_time', size: 'S', xp: 10, state: 'completed', completedOn: '2026-10-03' },
        { id: 'reach80', title: 'Reach 80 kg', type: 'target', size: 'L', xp: 50, state: 'available', target: { start: 90, goal: 80, unit: 'kg', current: 86.4, digits: 1, step: 0.1, trend: 'down', lastOn: '2026-11-03' }, progress: 0.36 },
        {
          id: 'steps', title: 'Walk 8’000 steps', type: 'habit', size: 'M', xp: 38, durationFactor: 1.5, state: 'available', doneToday: true, doneAt: '17:55',
          habit: { times: 1, period: 'day', count: 30, start: '2026-10-25', periodIndex: 12, doneThisPeriod: 1 },
          streak: { current: 12, best: 12, unit: 'day' },
          progress: 12 / 30,
          week: ['done', 'done', 'done', 'today-done', 'upcoming', 'upcoming', 'upcoming'],
        },
        {
          id: 'cook', title: 'Cook at home', type: 'habit', size: 'M', xp: 50, durationFactor: 2, state: 'available',
          habit: { times: 4, period: 'week', count: 12, start: '2026-10-19', periodIndex: 3, doneThisPeriod: 2 },
          streak: { current: 2, best: 2, unit: 'week' },
          progress: 2 / 12,
          week: ['done', 'none', 'done', 'today', 'upcoming', 'upcoming', 'upcoming'],
        },
        { id: 'run', title: 'Run 5 km without stopping', type: 'one_time', size: 'M', xp: 25, bonus: true, state: 'available' },
      ],
    },
    {
      id: 'flat',
      title: 'Move into my own flat',
      category: 'independence',
      why: 'My own space, my own rules.',
      targetDate: '2027-03-31',
      createdAt: '2026-09-20',
      status: 'active',
      isPrivate: false,
      attempt: 1,
      quests: [
        { id: 'budget', title: 'Set a monthly budget', type: 'one_time', size: 'S', xp: 10, state: 'completed', completedOn: '2026-09-22' },
        { id: 'extract', title: 'Order my debt collection extract', type: 'one_time', size: 'S', xp: 10, state: 'available' },
        { id: 'save', title: 'Save CHF 6’000 for the deposit', type: 'target', size: 'L', xp: 50, state: 'available', target: { start: 0, goal: 6000, unit: 'CHF', current: 5200, step: 100, lastOn: '2026-10-31' }, progress: 5200 / 6000 },
        { id: 'visit', title: 'Visit 5 flats', type: 'target', size: 'M', xp: 25, state: 'available', target: { start: 0, goal: 5, unit: 'flats', current: 3, lastOn: '2026-11-01' }, progress: 3 / 5 },
        { id: 'lease', title: 'Sign the lease', type: 'one_time', size: 'L', xp: 50, state: 'locked', after: 'visit' },
        { id: 'utilities', title: 'Set up internet and electricity', type: 'one_time', size: 'S', xp: 10, state: 'locked', after: 'lease' },
        { id: 'party', title: 'Host a housewarming', type: 'one_time', size: 'S', xp: 10, bonus: true, state: 'locked', after: 'lease' },
      ],
    },
    /* Unlocked in June: explains the XP total. Required XP 170 + Silver rank bonus round(170 × 1.5) = 255 → 425 XP;
       with the 40 XP of the quests completed above, 465 XP. Score: XP-weighted quest execution
       (95 XP × 100 + 75 XP × 100 / (1 + 1 reset)) / 170 = 77.94, unlocked 3 days after the deadline → × (1 − 3/30)
       = 70.15 → Silver (R-RANK-01/02). */
    {
      id: 'licence',
      title: 'Get my driving licence',
      category: 'independence',
      why: 'Visit my grandparents without asking anyone for a lift.',
      targetDate: '2026-06-15',
      createdAt: '2026-03-02',
      completedOn: '2026-06-18',
      status: 'completed',
      rank: 'silver',
      score: 70.15,
      rankBonus: 255,
      isPrivate: false,
      attempt: 1,
      quests: [
        { id: 'firstaid', title: 'Take the first-aid course', type: 'one_time', size: 'S', xp: 10, state: 'completed', completedOn: '2026-03-14' },
        { id: 'theory', title: 'Pass the theory test', type: 'one_time', size: 'M', xp: 25, state: 'completed', completedOn: '2026-03-27' },
        { id: 'hours', title: 'Drive 20 practice hours', type: 'target', size: 'M', xp: 25, state: 'completed', completedOn: '2026-05-30', target: { start: 0, goal: 20, unit: 'hours', current: 20 } },
        {
          id: 'parking', title: 'Practise parking', type: 'habit', size: 'L', xp: 75, durationFactor: 1.5, state: 'completed', completedOn: '2026-05-24', resetCount: 1,
          habit: { times: 3, period: 'week', count: 6, start: '2026-04-13', periodIndex: 6, doneThisPeriod: 3 },
          streak: { current: 6, best: 6, unit: 'week' },
        },
        { id: 'book', title: 'Book the driving test', type: 'one_time', size: 'S', xp: 10, state: 'completed', completedOn: '2026-05-08' },
        { id: 'exam', title: 'Pass the driving test', type: 'one_time', size: 'M', xp: 25, state: 'completed', completedOn: '2026-06-18' },
      ],
    },
  ];

  /** Derived values the API returns (progress, XP earned and required); computed here only to keep the example consistent. */
  const questProgress = (q) => (q.state === 'completed' ? 1 : (q.progress ?? 0));
  const derive = (list) => {
    list.forEach((a) => {
      const required = a.quests.filter((q) => !q.bonus);
      a.xpTotal = required.reduce((s, q) => s + q.xp, 0);
      a.xpEarned = a.quests.filter((q) => q.state === 'completed').reduce((s, q) => s + q.xp, 0);
      a.progress = required.reduce((s, q) => s + questProgress(q) * q.xp, 0) / a.xpTotal;
      a.requiredDone = required.filter((q) => q.state === 'completed').length;
      a.requiredCount = required.length;
      a.bonusDone = a.quests.filter((q) => q.bonus && q.state === 'completed').length;
      a.bonusCount = a.quests.filter((q) => q.bonus).length;
      a.next = required.find((q) => q.state === 'available');
      a.quests.forEach((q) => {
        q.achievementId = a.id;
      });
    });
    return list;
  };

  const seedAchievements = JSON.stringify(achievements);
  const seedUser = JSON.stringify(user);

  /** Fresh, independent copies for one interactive frame. */
  const seed = () => ({ user: JSON.parse(seedUser), achievements: derive(JSON.parse(seedAchievements)) });

  derive(achievements);
  const byId = (id, list = achievements) => list.find((a) => a.id === id);
  const quest = (achievementId, questId, list = achievements) => byId(achievementId, list).quests.find((q) => q.id === questId);

  QL.data = {
    LOCALE,
    TODAY,
    NOW_TIME: '18:40',
    user,
    achievements,
    byId,
    quest,
    derive,
    seed,
    passkeys,
    sessions,
    xpByMonth,
    studyDays,
    studyLog,
    savingsLog,
    templates,
    CATEGORIES,
    TYPE_LABEL,
    TYPE_ICON,
    SIZE_XP,
  };
  QL.fmt = fmt;
})(window.QL);
