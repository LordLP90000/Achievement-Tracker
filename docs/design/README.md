# Questline — app design

Design package for the Questline mobile app (iOS and Android, phone, portrait): the design system and the
screens, built from shared components with realistic example data that follows the backend's rules
([requirements](../requirements.md)).

| Page | What it holds | Status |
|------|---------------|--------|
| [`index.html`](index.html) | Overview | — |
| [`design-system.html`](design-system.html) | Tokens (colour light + dark with every contrast pair, type, spacing, radius, elevation, icons, motion) and every component in every state | Updated after the HIG review |
| [`pass-1.html`](pass-1.html) | Today and Achievement detail in light and dark, live and annotated; interaction states; 200 % text; Android | Pass 1 · **approved 05.11.2026** |
| [`pass-2.html`](pass-2.html) | Every other screen and state, annotated: 65 frames on 14 boards, including widgets and the screens around the app | Pass 2 · **for review** |
| [`prototype.html`](prototype.html) | Clickable main flow: create achievement → add quests → check in → quest complete → achievement unlocked → level up → share card | Pass 2 · **for review** |

**Viewing:** open the pages in Chrome, Edge or Safari (double-click works; no build, no server, no network).
The toolbar switches every frame to 150 % / 200 % text, Android, reduced motion, increased contrast, reduced
transparency, phone viewport or full length, and turns the annotation pins on and off. Frames are live: check in, undo, show private quests, switch Path/List,
open ⋯ → Pause….

## Files

```
docs/design/
├── tokens.json              source of truth (W3C design-token format), light + dark
├── tools/tokens.mjs         generates assets/css/tokens.css + assets/js/tokens.js, checks contrast
├── assets/css/              tokens (generated) · base (fonts, type styles) · components · screens · screens-2 · board (doc pages only)
├── assets/js/
│   ├── data.js              example data (Lena, Thursday 05.11.2026, 18:40, Europe/Zurich)
│   ├── ui.js, ui-more.js    the components (HTML renderers with their accessibility semantics)
│   ├── screens.js           Today and Achievement detail + developer annotations
│   ├── screens-*.js         pass 2: auth, goals (list, wizard, quests), rewards (celebrations, stats, gambles), settings (profile, privacy, system surfaces, widgets)
│   ├── pass-1.js, pass-2.js, prototype.js, design-system.js   the review pages
│   ├── board.js             device frames, toolbar, interactions of the review pages
│   └── icons.js             Lucide subset
├── assets/fonts/            Fraunces; Inter + Roboto (preview only) (woff2) · assets/licenses/ (OFL 1.1, ISC)
└── *.html                   the review pages
```

Change a token in `tokens.json`, then run `node docs/design/tools/tokens.mjs` from the repository root: it
rewrites the generated CSS/JS and exits with 1 if any listed colour pair falls below WCAG AA (text 4.5:1,
non-text 3:1; 7:1 and 4.5:1 for the Increase Contrast variants). All 176 checks pass (44 pairs × light, dark and
both Increase Contrast variants). `docs/` is outside the lint, format and Semgrep
scope.

## Handoff notes for the app team

- **Tokens:** `tokens.json` follows the W3C design-token format, so a transformer (e.g. Style Dictionary) can
  emit Swift asset catalogs and a Compose theme. Components use semantic tokens only (`--state-done-fg`, never
  `moss-600`); each type style names its iOS text style and Android type role in `$extensions`.
- **Fonts:** UI text is the system font (SF Pro / Roboto — see HIG review); bundle only Fraunces (brand moments; axes `SOFT` 100, `WONK` 0) and scale it with the
  system: `UIFontMetrics(forTextStyle:)` on iOS, `sp` on Android. Counters use tabular figures.
- **Numbers come from the API.** XP, levels, progress, streaks, ranks: show what the server returns
  ([client security guide](../client-security.md) §4); the example data only mirrors those rules so that the
  numbers are consistent.
- **Screen readers:** the HTML components carry the intended names, roles and values (see the design system's
  accessibility section). Native equivalents: section titles are headers (`.isHeader` / `heading()`); the check
  circle is a toggle (`.isToggle` / `Role.Checkbox`) named “Check in: ‹quest›”; rings and bars expose their value
  (`accessibilityValue` / `progressBarRangeInfo`); custom actions offer “Check in with a note”.
- **Reduced motion:** `accessibilityReduceMotion` (iOS) / animator duration scale 0 (Android) switch every
  animation to the ≤ 150 ms fade listed in the motion table. Haptics stay.
- **Increase Contrast and Reduce Transparency:** with Increase Contrast (`colorSchemeContrast == .increased`;
  Android 14 contrast level) the app uses the `theme.light-contrast` / `theme.dark-contrast` values. System bars and
  sheets handle Reduce Transparency themselves; any custom glass needs the opaque `glass-opaque` fill.
- **Privacy:** private content is replaced by fixed-length placeholders (never a blur of the real text, which
  leaks its length and can be reversed); with app lock on, revealing asks for Face ID / fingerprint; the app
  switcher shows a privacy screen (iOS overlay on `scenePhase` inactive, Android `FLAG_SECURE`), as in the client
  security guide §3.

## Pass 1 review

### Design decisions

1. **Direction — a calm quest log.** Warm sand neutrals instead of grey, one accent (**honey**) for progress, the
   primary action and the current quest, generous whitespace, cards with quiet warm shadows. Fraunces (a soft
   serif) for brand moments gives the quest-log character; the system font for all UI text (changed after the HIG review). No pixel art, no HUD.
2. **One game motif: the hexagon** — level emblem, badges and the goal at the end of the quest path. Everything
   else stays a productivity app.
3. **Quest states have a colour, an icon and a word each:** current (honey, pin), done (moss green, tick), bonus
   (plum, star), locked (sand, dashed outline, lock + “Unlocks after …”), paused / restart (slate). Red is only
   for deleting and for form errors.
4. **Today has one job: check in.** Order: date + greeting → level and XP → today's quests (open, then done
   today) → up to three achievement rings → streaks. A quest is on Today when its habit period still needs
   check-ins, when it is the next quest of an active achievement, or when it was done today.
5. **One tap checks in** one-time and habit quests; target quests show “+” and open the sheet for the value;
   long-press (or the screen-reader action) opens the sheet for a note. The check circle is a toggle: tapping it
   again the same day undoes, and the snackbar offers Undo for 6 s.
6. **XP is paid when a quest completes** (backend rule), so a habit check-in shows progress (“3 of 5 this week”,
   the streak) and the XP chip shows what the quest pays at the end.
7. **Achievement detail:** the next quest is the screen's one primary action. The quest path is the default view:
   the line is solid gold as far as the user has come and dashed ahead; bonus quests branch off as side quests;
   the goal hexagon closes the path. The list view groups the same quests by state (In progress, Bonus, Locked,
   Done).
8. **Neutral setbacks:** a day without a check-in is a hollow outline, never red; a habit whose period was missed
   reads “Run ended on 01.11. Your history is kept.” with a Restart button.
9. **Private content** collapses to “3 private quests” with a Show button; rings show “Private · Tap to show”.
   Numbers such as body weight can be hidden per achievement: overview screens then show the trend only.
10. **Confirmations state consequences plainly** with two equal buttons, focus on Cancel (see Pause).
11. **Large text:** body to 200 %, display titles to 150 %, tab labels fixed (Large Content Viewer / tooltip on
    long-press). From 150 % the rings become a list, quest cards stack and drop their lead icon, the level card
    stacks.
12. **Dark theme** is warm near-black (`#13110E`), not pure black; raised surfaces get lighter; the honey accent
    works in both themes.
13. **One design for both platforms** with platform adaptations: status bar, back arrow on Android, system date
    pickers and sheets, haptics, “Face ID” vs “fingerprint” wording. The tab bar uses the same capsule indicator
    on both.
14. **Locale-driven formats:** example data in Swiss format (Thursday, 05.11.2026, 18:40, CHF 6’000). German
    needs ~30 % more room: layouts wrap, never truncate; long compounds get soft hyphens in translation.

### Assumptions

1. The backend in this repository is the source of truth for the rules; where the brief and the backend differ,
   the design follows the backend and the difference is an open question below.
2. Lena's numbers are consistent with the backend: Level 3 at 465 XP (Level 4 at 900) = 40 XP from quests
   completed in her current achievements + 425 XP from “Get my driving licence”, unlocked in June with Silver
   (170 XP of quests + a 255 XP rank bonus). That achievement appears in pass 2 (trophy room).
3. Achievement templates are bundled in the app (the backend has none); the wizard turns a template into an
   ordinary achievement with quests.
4. Reminders are local notifications scheduled on the phone (the backend sends no pushes in v1). *Superseded by
   answer 6:* the reminder time is stored in the API and syncs; each phone schedules its own reminders.
5. “Hide numbers on overview screens” is a setting per achievement. *Superseded by answer 6:* stored in the API.
6. The six categories are stored as stable keys in the API's free-text `category`; “Custom” stores the user's
   own name (≤ 60 characters).
7. An unlock below the lowest rank still earns a badge, labelled “Unlocked” — never “unranked”.
8. Design base: 390 × 844 pt (iPhone 15/16); Android at 412 × 915 dp uses the same layout. Weeks start on Monday
   (the account's setting).

### Answers to the open questions (05.11.2026)

| # | Question | Answer |
|---|----------|--------|
| 1 | Archive — the brief has it, the backend doesn't (R-ACH-07) | **No Archive action.** The Achievements filter offers Active, Paused, Completed; completed achievements are the archive. |
| 2 | Pausing resets the achievement (R-ACH-06) | **Keep it.** The pause dialog states the consequences plainly. |
| 3 | Ranks (Bronze … Champion, bonus XP) | **Show the rank** on the badge and in the unlock celebration. |
| 4 | Gambles (stake XP on a target date) | **Explicit opt-in in Settings**, off by default. |
| 5 | Detailed notifications vs. generic text | **Opt-in details for non-private achievements only;** private ones always stay generic. |
| 6 | Reminder times and “hide numbers” | **Add API fields so they sync** — needs an additive contract change (see pass 2 review). |
| 7 | XP only when a quest completes | **Keep it.** Progress and streaks are the daily reward. |
| 8 | A daily habit resets after one missed day (R-QST-04) | **Keep it,** shown neutrally with a one-tap Restart. |
| 9 | Visual direction | **Approved;** pass 2 builds on it. |

## Pass 2 review

Pass 2 (all other screens and states) and the clickable prototype are ready for review: `pass-2.html`, `prototype.html`.

**Decisions**
- Today lists three groups: *Today's quests* (habits still due this period), *Up next* (the first open one-time or target quest per achievement, "whenever you're ready") and *Done today*. This makes "Nothing due today" possible without anything undated looking overdue.
- XP gambles are off until switched on in Profile → XP gambles (answer 4); turning them on explains the stake rules first.
- Reminder times and "hide numbers" sync through the API (answer 6); each phone still decides whether it reminds ("Reminders on this phone").
- Completed achievements are the read-only archive; there is no Archive action (answer 1).
- Added after the HIG review: row actions (iOS swipe, Android long-press) and widgets. Widgets and notification actions use the existing check-in endpoint; they need no new API.

**Assumptions**
1. Two-step verification uses an authenticator app with recovery codes, as the API offers; passkeys are offered after sign-up, never forced.
2. "Download data" calls `GET /v1/me/export` (re-authentication, at most twice in 24 hours, R-PRIV-05) and hands the JSON file to the share sheet; the app keeps no copy.
3. Account deletion follows R-PRIV-06 and Q-48: signed out everywhere at once, deleted for good after 30 days, and signing in or resetting the password before then brings the account back.
4. Share cards are drawn on the phone; nothing is uploaded, and only what the person ticks appears on the card.
5. Celebrations (Full / Calm), "Reminders on this phone" and App lock (with its PIN) are settings of the device, not the account; they don't sync.
6. The prototype's time skip (05.11. → 13.12.2026) stands in for five weeks of check-ins; its XP numbers follow the backend's rules (Diamond rank bonus 110 × 120 = 13'200 XP).
7. Widgets and notification actions check in through the same endpoint with an Idempotency-Key, so a repeated tap never counts twice.

**Answers to the open questions (05.11.2026)**

| # | Question | Answer | Follow-up |
|---|----------|--------|-----------|
| 1 | Sync reminder times and "hide numbers": add `Quest.reminder` and `Achievement.hide_numbers` to the frozen contract? | **Approved** (additive). | Backend: contract change and data-inventory entry. |
| 2 | Rank bonus scale: Diamond ×120 → +13'200 XP, Level 3 → 6 in one unlock | **Too big — scale it down.** | Backend question; the design shows whatever the API returns, so only the prototype's example numbers change. |
| 3 | Email when account deletion is complete (HIG managing-accounts.md) | **Yes.** The retention job sends one last email, then removes the address. | Backend: retention job and data inventory (the address is kept until that email). |
| 4 | Delay sign-in further (local-first, anonymous accounts)? | **No.** The first goal stays a local draft until sign-up. | — |
| 5 | Title case for all iOS buttons? | **No.** Sentence case in the app on both platforms; title case only on iOS system surfaces (action sheets, notification actions). | — |
| 6 | First-person labels from the brief | **"Download data" and "Delete account"** (also "Keep account"). The consent checkbox "Store my goals…" stays first person, as consent statements usually are. | Done. |

## HIG review (apple-design-skill)

Reviewed against Apple's Human Interface Guidelines with [dickwu/apple-design-skill](https://github.com/dickwu/apple-design-skill) (five lenses: accessibility, platform conventions, visual craft, interaction, content). Citations: `file.md › Heading` in that repo's `references/hig/`.

**Summary — 4/5 before, aligned after the changes below.** The foundations held up (contrast checks, 48 pt targets, state never by colour alone, reduced motion, private-content handling). The gaps were platform conventions: an action in the tab bar, an in-app theme switch, a custom font for all UI text, custom alerts and frequent decorative motion.

**Your decisions (05.11.2026)**
| Brief said | HIG says | Decision |
|---|---|---|
| "+ (create)" tab | "Use a tab bar to support navigation, not to provide actions." (`tab-bars.md › Best practices`) | 4 tabs. iOS: prominent glass "+" in the top bar of Today and Achievements; Android: extended FAB "New achievement". |
| Appearance: light / dark / system | "Avoid offering an app-specific appearance setting." (`dark-mode.md › Best practices`); no redundant system settings (`settings.md`) | No theme or text-size setting; the app follows the phone. Profile → Celebrations (Full / Calm) remains. |
| Fraunces + Figtree everywhere | Custom font for headlines, system fonts for body copy and captions (`branding.md`); custom fonts must support Dynamic Type and Bold Text (`typography.md › Using custom fonts`) | System font for all UI text (SF Pro / Roboto). Fraunces only for onboarding headlines, the achievement title in its detail header, level numbers, celebrations, badges and the share card. Figtree removed. |

**Changes made**
- *Tab bar* — iOS: floating Liquid Glass capsule, filled symbols, selected tab tinted on a platter (`tab-bars.md`, `liquid-glass.md › Color on glass`). Android: Material 3 navigation bar (outlined icons, selected one filled in a pill).
- *Bars* — iOS bar items on glass capsules, no solid bar background; a scroll-edge blur/fade instead (`toolbars.md`, `liquid-glass.md › Where the material belongs`). The status bar now stays put while content scrolls under it. Android keeps an opaque top app bar.
- *Confirmations* — pause (which starts over), withdraw consent and final account deletion use an iOS action sheet: destructive button on top in the destructive style, title-case label, Cancel apart at the bottom (`action-sheets.md › Best practices`, `alerts.md`). Android: Material 3 dialog with Cancel first. New Android frame "Withdraw consent · Android dialog".
- *Increase Contrast* — every semantic colour has an increased-contrast value (`color.md › Best practices`); `tools/tokens.mjs` checks them at 7:1 text and 4.5:1 UI — 176/176 pairs pass. Toolbar: **Contrast: Increased**.
- *Reduce Transparency* — glass and the scroll edge become opaque (`liquid-glass.md › Review checklist` 5). Toolbar: **Transparency: Reduced**. Both toggles default to the computer's own setting.
- *Motion* — a check-in only fills and ticks in 160 ms; the pop and burst are reserved for completing a quest; the looping halo on the current path node is gone (`motion.md › Providing feedback`: brevity, no motion on frequent interactions).
- *Segmented controls* — text only (Path / List, quest type) (`segmented-controls.md`: text or images, not both).
- *Notifications* — opted-in, non-private reminders offer one action, "Check In" (`notifications.md › Notification actions`); private ones stay generic with no action.
- *Permissions* — notification permission is asked in context, the first time a reminder is switched on in the wizard, with no custom pre-prompt (`privacy.md › Requesting permission`).
- *Writing* — no "we" in the UI (`writing.md › Best practices`): e.g. "What's stored", "Encrypted on Questline's servers", "Contact support", "A link is on its way to …". Deletion now promises an email when it's complete (`managing-accounts.md › Deleting accounts`).

**Platform notes for developers**
- Use the system components rather than re-creating them: `TabView` / `UITabBarController`, `.toolbar` with a `.prominent` "+" button, `confirmationDialog(role: .destructive)`, `ScrollEdgeEffectStyle`; on Android `NavigationBar`, `ExtendedFloatingActionButton`, `AlertDialog`. The HTML previews only imitate them.
- Tab icons on iOS: SF Symbols `sun.max.fill`, `flag.fill`, `chart.bar.fill`, `person.crop.circle.fill`. Previews use Lucide.
- Previews show Inter where SF Pro isn't installed and bundle Roboto for Android frames (both OFL, preview only — never ship them as the UI font).
- Haptics: system patterns only — light impact on check-in, success on quest complete (`playing-haptics.md`).
- App lock stays: it gates the app and private content, which is different from the in-app biometric opt-in that `managing-accounts.md` advises against.

- Sheets: `.presentationDetents([.medium, .large])` with a visible drag indicator; widgets: WidgetKit with `Button(intent:)` for the check-in and `.privacySensitive()` on anything personal; Android: Glance.

**Added in the second round**
- *Sheets* — on iOS, partial-height sheets float inset with corners concentric to the display; Close sits on the leading edge with the title centred (`sheets.md › Platform considerations`). The large Add-quest sheet stays edge to edge, as do all Android bottom sheets.
- *Root screens* — every iOS tab keeps the bar row above its large title, so titles line up across tabs. The top scroll edge appears only once content scrolls under the bars, and a bottom one softens content under the floating tab bar (`liquid-glass.md › Review checklist` 6). On Android the FAB now sits 16 dp above the navigation bar.
- *Row actions* — swipe a card in Achievements for Pause and Delete (Resume when paused, Share when completed) (`designing-for-ios.md`: let people swipe to initiate actions in a list row). They are shortcuts: the same actions stay in the detail menu, and Pause and Delete still confirm. Android: long-press opens the same menu. Frames "Achievements · swipe actions" and "· long-press menu".
- *Widgets* (`widgets.md`) — Home Screen small (quests left, level, streak) and medium (up to three of today's quests, one-tap check-in for habits); Lock Screen inline, circular and rectangular. Private quests appear only as a count. With App lock on, widgets show counts only, with no names and no buttons. The Lock Screen never shows names. Frames on the "Around the app" board.

**Out of scope**
- iPad and landscape layouts, Live Activities, StandBy and Apple Watch.
