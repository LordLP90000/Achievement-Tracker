/* Pass 2 screens: onboarding, sign-up / sign-in, email check, two-step code, consent, passkey offer. */
(function (QL) {
  const { ui, data, fmt } = QL;
  const { icon, esc, button } = ui;
  const S = QL.screens;

  const dots = (n) => `<div class="onb__dots" role="img" aria-label="Step ${n} of 3">${[1, 2, 3].map((i) => `<span class="${i === n ? 'is-on' : ''}"></span>`).join('')}</div>`;

  const onbTop = (back) =>
    `<div class="navbar">${back ? `<a href="#" class="navbar__back" data-action="back">${icon('chevron-left')}<span class="navbar__back-label t-callout">Back</span><span class="sr-only">Back</span></a>` : ''}<span class="navbar__actions">${button({ label: 'Sign in', variant: 'text', size: 'sm' })}</span></div>`;

  S.onboarding1 = () => ({
    body: `<div class="screen">${onbTop(false)}<div class="onb">
      <div class="onb__art" data-anno="1">
        <div class="flow-art" aria-hidden="true">
          <div class="flow-art__item">${ui.ring({ p: 0.45, size: 'sm', center: icon('flag', 'icon--sm') })}<span class="t-headline">Run the Silvesterlauf</span></div>
          <div class="flow-art__item flow-art__item--quest"><span class="check check--done" style="width:28px;height:28px">${icon('check')}</span><span class="t-subhead">Buy running shoes</span><span class="flow-art__xp">${ui.xpTag(10)}</span></div>
          <div class="flow-art__item flow-art__item--quest"><span class="check" style="width:28px;height:28px"></span><span class="t-subhead">Run 3× a week</span><span class="flow-art__xp">${ui.xpTag(25)}</span></div>
          <div class="flow-art__item flow-art__item--quest"><span class="pnode pnode--locked" style="width:28px;height:28px">${icon('lock', 'icon--sm')}</span><span class="t-subhead c-secondary">Run the race</span><span class="flow-art__xp">${ui.xpTag(50)}</span></div>
        </div>
      </div>
      ${dots(1)}
      <h1 class="t-brand-large">Turn a big goal into a quest line</h1>
      <p class="t-body c-secondary" style="margin-top:12px" data-anno="2">Set an <strong>achievement</strong>. Break it into small <strong>quests</strong>. Check them off, earn <strong>XP</strong>, and watch the achievement fill up until it’s unlocked.</p>
      <div class="onb__actions">${button({ label: 'Continue', size: 'lg', block: true })}</div>
    </div></div>`,
  });

  const PROMISES = [
    ['lock', 'Encrypted on Questline’s servers', 'Your titles, notes and numbers are encrypted for you alone.'],
    ['eye-off', 'Private stays private', 'Mark an achievement private and it’s hidden on Today, in notifications and on share cards.'],
    ['ban', 'No ads. No trackers.', 'Nothing is sold, shared or analysed — not for advertisers, not for anyone.'],
    ['download', 'Yours to take or delete', 'Download everything or delete your account, any time.'],
  ];

  S.onboarding2 = () => ({
    body: `<div class="screen">${onbTop(true)}<div class="onb">
      <div class="onb__art" style="min-height:330px" data-anno="3">
        <ul class="promise">${PROMISES.map(([ic, t, d]) => `<li><span class="lrow__icon lrow__icon--done" aria-hidden="true">${icon(ic)}</span><span><span class="t-headline" style="display:block">${t}</span><span class="t-footnote c-secondary">${d}</span></span></li>`).join('')}</ul>
      </div>
      ${dots(2)}
      <h1 class="t-brand-large">Your goals stay yours</h1>
      <p class="t-body c-secondary" style="margin-top:12px">Goals can be personal — health, money, family. Questline is built to keep them that way.</p>
      <div class="onb__actions">${button({ label: 'Continue', size: 'lg', block: true })}</div>
    </div></div>`,
  });

  S.onboarding3 = () => ({
    body: `<div class="screen">${onbTop(true)}<div class="onb">
      ${dots(3)}
      <h1 class="t-brand-large">What’s one big goal for you?</h1>
      <p class="t-body c-secondary" style="margin-top:12px">Say it in your own words. You’ll break it into quests next.</p>
      <div style="margin-top:24px" data-anno="4">${ui.field({ label: 'Achievement', placeholder: 'e.g. Run my first 10 km' })}</div>
      <p class="t-subhead" style="margin:20px 0 10px;font-weight:600">Or pick an idea</p>
      <div class="chip-wrap" data-anno="5">${['Pass my final exams', 'Run my first 10 km', 'Move into my own flat', 'Save CHF 3’000'].map((t) => `<button type="button" class="chip" aria-pressed="false">${t}</button>`).join('')}</div>
      <p class="t-footnote c-tertiary" style="margin-top:20px">${icon('smartphone', 'icon--sm')} It stays on this phone until you’ve created your account.</p>
      <div class="onb__actions">${button({ label: 'Continue', size: 'lg', block: true })}${button({ label: 'Skip for now', variant: 'text', block: true })}</div>
    </div></div>`,
  });

  const authTop = () => `<div class="navbar"><a href="#" class="navbar__back" data-action="back">${icon('chevron-left')}<span class="navbar__back-label t-callout">Back</span><span class="sr-only">Back</span></a></div>`;

  S.signUp = () => ({
    body: `<div class="screen">${authTop()}<div class="auth">
      <h1 class="t-large-title">Create your account</h1>
      <p class="t-callout c-secondary">So your quest line is safe and on all your devices.</p>
      <div data-anno="1">${ui.field({ label: 'Email', value: 'lena.m@example.ch' })}</div>
      <div>${ui.passwordField({ label: 'Password', value: 'correct horse battery', helper: 'At least 12 characters. A short sentence works well.' })}</div>
      <div>${ui.checkboxRow({ html: 'I’m 13 or older.' })}</div>
      <p class="t-footnote c-secondary">By creating an account you accept the <a href="#" class="link">terms</a> and the <a href="#" class="link">privacy policy</a>. You’ll decide about storing your goals in a separate step.</p>
      <div class="stack" style="--gap:8px;margin-top:auto">
        ${button({ label: 'Create account', size: 'lg', block: true })}
        <p class="t-footnote c-tertiary" style="text-align:center" data-anno="2">${icon('key-round', 'icon--sm')} You can add a passkey once you’re in.</p>
        ${button({ label: 'I have an account — sign in', variant: 'text', block: true })}
      </div>
    </div></div>`,
  });

  S.checkEmail = () => ({
    body: `<div class="screen">${authTop()}<div class="auth" style="text-align:center">
      <span class="mail-art" aria-hidden="true">${icon('mail-check')}</span>
      <h1 class="t-title-1">Check your email</h1>
      <p class="t-body c-secondary">A link is on its way to <strong class="c-accent" style="color:var(--text-primary)">${esc(data.user.email)}</strong>. Open it on this phone to confirm your address — it works for 30 minutes.</p>
      <div class="stack" style="--gap:8px;margin-top:8px" data-anno="3">
        ${button({ label: 'Open mail app', size: 'lg', block: true, iconName: 'mail' })}
        ${button({ label: 'Send it again in 0:45', variant: 'secondary', size: 'lg', block: true, state: 'is-disabled' })}
      </div>
      <p class="t-footnote c-secondary">Nothing there? Check the spam folder, or <a href="#" class="link">use a different address</a>.</p>
    </div></div>`,
  });

  S.signIn = (ctx) => {
    const bio = ctx.platform === 'android' ? 'fingerprint' : 'Face ID';
    return {
      body: `<div class="screen">${authTop()}<div class="auth">
        <h1 class="t-large-title">Welcome back</h1>
        <div data-anno="2">${button({ label: 'Continue with passkey', size: 'lg', block: true, iconName: 'key-round' })}<p class="t-footnote c-tertiary" style="margin-top:8px;text-align:center">Sign in with ${bio} — no password needed.</p></div>
        ${ui.orDivider()}
        <div class="stack" style="--gap:16px" data-anno="4">
          ${ui.field({ label: 'Email', value: data.user.email })}
          ${ui.passwordField({ label: 'Password', value: '', error: 'Email or password doesn’t match. Try again, or reset your password.' })}
          ${button({ label: 'Sign in', variant: 'secondary', size: 'lg', block: true })}
          ${button({ label: 'Forgot password?', variant: 'text', block: true })}
        </div>
        <p class="t-footnote c-secondary" style="text-align:center;margin-top:auto">New here? <a href="#" class="link">Create an account</a></p>
      </div></div>`,
    };
  };

  S.twoFactor = () => ({
    body: `<div class="screen">${authTop()}<div class="auth">
      <h1 class="t-title-1">Enter your code</h1>
      <p class="t-body c-secondary">Open your authenticator app and type the 6-digit code for Questline.</p>
      <div data-anno="5"><div class="code-boxes" role="group" aria-label="6-digit code, 3 of 6 entered">${['4', '8', '1', '', '', ''].map((d, i) => `<span class="${i === 3 ? 'is-active' : ''}" aria-hidden="true">${d}</span>`).join('')}</div>
      <p class="t-footnote c-tertiary" style="margin-top:8px">The code changes every 30 seconds. Paste works too.</p></div>
      <div class="stack" style="--gap:8px;margin-top:auto">
        ${button({ label: 'Verify', size: 'lg', block: true })}
        ${button({ label: 'Use a recovery code instead', variant: 'text', block: true })}
      </div>
    </div></div>`,
  });

  const SUMMARY = [
    ['database', 'What', 'Your achievements, quests, check-ins, notes and numbers — and your email address to sign you in.'],
    ['heart-pulse', 'Why this question', 'Goals can include health information, like a weight goal. That needs your explicit OK.'],
    ['lock', 'How', 'Encrypted on Questline’s servers, used only to run the app. Never sold, never used for ads.'],
    ['rotate-ccw', 'Your choice', 'Withdraw any time in Profile → Privacy & data. Your goals are then deleted right away; your account stays.'],
  ];

  S.consent = (ctx) => {
    const summarySheet = ctx.summary
      ? `<div class="scrim" data-action="close-overlay"></div><div class="sheet sheet--docked" role="dialog" aria-modal="true" aria-labelledby="${ctx.ids}-ps">
          <div class="sheet__grabber" aria-hidden="true"></div>
          <div class="sheet__header"><h2 class="t-title-3" id="${ctx.ids}-ps">Privacy in plain words</h2>${ui.iconButton({ iconName: 'x', label: 'Close', extra: { 'data-action': 'close-overlay' } })}</div>
          <ul class="steps-list">${SUMMARY.map(([ic, t, d]) => `<li><span class="lrow__icon" aria-hidden="true">${icon(ic)}</span><span><span class="t-headline" style="display:block">${t}</span><span class="t-subhead c-secondary">${d}</span></span></li>`).join('')}</ul>
          <p class="t-footnote c-secondary" style="margin-top:16px">Full details: <a href="#" class="link">privacy policy</a>. Questions: privacy@questline.example</p>
          <div class="sheet__footer">${button({ label: 'Got it', variant: 'secondary', size: 'lg', block: true, extra: { 'data-action': 'close-overlay' } })}</div>
        </div>`
      : '';
    return {
      body: `<div class="screen">${authTop()}<div class="auth">
        <h1 class="t-title-1">One question before you start</h1>
        <p class="t-body c-secondary">Questline saves your achievements, quests, check-ins and notes so it can show your progress on all your devices.</p>
        <ul class="steps-list" data-anno="1">
          <li><span class="lrow__icon" aria-hidden="true">${icon('heart-pulse')}</span><span class="t-subhead">Goals can include health information — like a weight goal — so storing them needs your explicit OK.</span></li>
          <li><span class="lrow__icon" aria-hidden="true">${icon('lock')}</span><span class="t-subhead">Encrypted, and only used to run the app.</span></li>
          <li><span class="lrow__icon" aria-hidden="true">${icon('rotate-ccw')}</span><span class="t-subhead">Change your mind any time in Privacy &amp; data.</span></li>
        </ul>
        <div data-anno="2">${ui.checkboxRow({ html: 'Store my goals – they may include health information – so the app can work.', checked: !!ctx.ticked })}</div>
        <a href="#" class="link t-subhead" data-anno="3" data-action="summary">Read the privacy summary</a>
        <div class="stack" style="--gap:8px;margin-top:auto" data-anno="4">
          ${button({ label: 'Continue', size: 'lg', block: true })}
          ${button({ label: 'Not now', variant: 'secondary', size: 'lg', block: true })}
        </div>
      </div></div>`,
      overlay: summarySheet,
    };
  };

  S.passkeyOffer = (ctx) => {
    const bio = ctx.platform === 'android' ? 'your fingerprint' : 'Face ID';
    return {
      body: `<div class="screen"><div class="auth" style="padding-top:48px;text-align:center">
        <span class="mail-art" aria-hidden="true">${icon('key-round')}</span>
        <h1 class="t-title-1">Sign in faster next time</h1>
        <p class="t-body c-secondary">Add a passkey and sign in with ${bio} instead of your password. It stays on your devices and can’t be phished.</p>
        <div class="stack" style="--gap:8px;margin-top:auto" data-anno="5">
          ${button({ label: 'Add a passkey', size: 'lg', block: true, iconName: 'key-round' })}
          ${button({ label: 'Not now', variant: 'secondary', size: 'lg', block: true })}
        </div>
        <p class="t-footnote c-tertiary">You can add one later in Profile → Security.</p>
      </div></div>`,
    };
  };

  QL.annotations.auth = [
    ['How it works', 'Three onboarding screens at most; “Sign in” is always one tap away. The illustration is built from real components (ring, check circles, locked node, XP tags) so it teaches the UI it shows.'],
    ['Plain words', 'The three terms of the app — achievement, quest, XP — appear once, in bold, with their meaning. Nothing else to learn up front.'],
    ['Privacy promise', 'Every promise matches the backend: application-level encryption, private achievements, no third-party analytics or trackers (R-PRIV-02), export and deletion (R-PRIV-05/06).'],
    ['First achievement', 'The goal is typed before the account exists and stays on the phone (nothing is sent before consent). After sign-up and consent it becomes step 1 of the create wizard, pre-filled.'],
    ['Ideas', 'Suggestions are single-select chips; picking one fills the field. Skipping leads to an empty Today with a “Create your first achievement” card.'],
  ];

  QL.annotations.signin = [
    ['Sign up', 'Email + password (12–128 characters, no composition rules, checked against breached passwords — R-AUTH-02). The age line is required by the backend (≥ 13, R-AUTH-11) and is never pre-ticked. Errors appear under the field after leaving it.'],
    ['Passkeys', 'The API registers accounts with a password; passkeys are added once signed in (Settings → Security and the offer after consent). Sign-in offers “Continue with passkey” first, as the client security guide recommends.'],
    ['Check your email', 'Sign-in works only after the address is confirmed (R-AUTH-09). Resending is limited (3 per hour, A-31), so the button counts down. The link opens the app (universal / app link, A-32).'],
    ['Sign-in errors', 'One message for every failure — no hint whether the address exists (R-AUTH-07). After repeated wrong passwords the wait time is shown instead of an error.'],
    ['Two-step code', 'Shown only when two-step verification is on. Six boxes, numeric keyboard, auto-submit on the 6th digit, paste supported; recovery codes as the fallback.'],
  ];

  QL.annotations.consent = [
    ['Why this question', 'Plain-language reasons before the question: what is stored, that it may include health data, and how to change one’s mind.'],
    ['The consent', 'Unticked by default and never pre-ticked (R-PRIV-04). “Continue” with the box unticked shows: “Tick the box to store your goals, or choose Not now.” — the button is never disabled, so screen-reader users can always reach the explanation.'],
    ['Privacy summary', 'Opens a sheet in plain words (what, why, how, your choice); the full policy is one link further.'],
    ['Equal choices', 'Continue and Not now have the same size and weight. “Not now” lets the user look around; creating an achievement asks again.'],
    ['Passkey offer', 'One calm offer after the first sign-in; “Not now” is as prominent as “Add a passkey”.'],
  ];
})(window.QL);
