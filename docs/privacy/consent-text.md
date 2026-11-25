# Consent text for goal content — English draft

Status: **draft v0.1** (2026-11-25), written by engineering for the PM and the data-protection expert (Q-62). Not
approved and not legal advice; O-04 stays open until the PM approves the text and sets its first version date. The
German, French and Italian versions follow once this one is approved (Q-62). The wording starts from the consent
screens of the app design (`docs/design/`, pass 2, still in review); §5 lists where this draft changes them and why.
`[[Double brackets]]` mark what the PM fills in.

## 1. What the consent is for

Goal content — achievements, quests, check-ins and their notes — may hold health data or other sensitive personal
data (data inventory C6, DPIA R-4). Storing it needs the user's explicit consent (R-PRIV-04; GDPR Art. 9(2)(a), FADP
Art. 6(7)(a)): asked on a screen of its own, with a box that is never ticked beforehand, and recorded with the
version of the text. Until it is given, every operation that creates goal content answers `403 consent-required`
(threat E-10). It is the only consent Questline asks for (`goal_content`).

## 2. The text

Version [[YYYY-MM-DD]]. The three parts below form one version.

### 2.1 The question

Shown after sign-up, and again whenever someone without the consent starts to create an achievement.

| Element | Text |
|---------|------|
| Title | One question before you start |
| Lead | Questline saves your achievements, quests, check-ins and notes on its servers, so that you see your progress on all your devices. |
| Point 1 | Goals can include health information — like a weight goal — so storing them needs your explicit OK. |
| Point 2 | They are stored encrypted and used only to run the app: no advertising, no analytics, never sold. |
| Point 3 | You can change your mind at any time in Profile → Privacy & data. Your goals are then deleted right away; your account stays. |
| Checkbox, unticked | Store my goals – they may include health information – so the app can work. |
| Link | Read the privacy summary |
| Buttons, equal in size and weight | Continue · Not now |
| "Continue" with the box unticked | Tick the box to store your goals, or choose Not now. |

"Not now" leaves the account as it is: signing in, the settings and the data download work, and no goal is stored.

### 2.2 The privacy summary

A sheet in plain words, one tap from the question; the full policy is one tap further (`privacy-policy.md`).

| Heading | Text |
|---------|------|
| Sheet title | Privacy in plain words |
| What | Your achievements, quests, check-ins, notes and numbers — and your email address to sign you in. |
| Why this question | Goals can include health information, like a weight goal. That needs your explicit OK. |
| How | Encrypted on Questline's servers, used only to run the app. Never sold, never used for ads. |
| Your choice | Withdraw any time in Profile → Privacy & data. Your goals are then deleted right away; your account stays. |
| Who | [[Legal name of the controller]], Switzerland, runs Questline. |
| Footer | Full details: privacy policy. Questions: [[privacy contact address]] |

### 2.3 Withdrawing

In Profile → Privacy & data, under "Your consent".

| Element | Text |
|---------|------|
| Card | Store my goals. Agreed on ‹date›. They may include health information. |
| Button on the card | Withdraw… |
| Dialog title | Withdraw consent? |
| Dialog text | All goals are deleted right away: every achievement with its quests, check-ins and notes, and the XP, levels and badges they earned. The account stays — agree again any time to start fresh. |
| Dialog buttons | Withdraw and delete goals · Cancel (Cancel has the focus) |

## 3. How it is recorded

- **Giving**: the app sends `POST /me/consents` with `{ "type": "goal_content", "version": "YYYY-MM-DD" }` — the
  version of §2 — when the user ticks the box and continues. The API stores the type, the version and the time, and
  writes a `consent_granted` audit event with the type and the version.
- **Withdrawing**: `DELETE /me/consents/goal_content` sets the time of withdrawal and deletes all goal content in the
  same transaction (Q-10), with a `consent_withdrawn` audit event. It needs no re-authentication: withdrawing is as
  easy as giving.
- **Proof**: every grant and withdrawal stays on record while the account exists (data inventory C5, threat R-04);
  `GET /me/consents` and the data download show them to the user.
- **Agreeing again** after a withdrawal starts a new record, with the version shown at that time.

## 4. At sign-up: two statements that are not this consent

| Statement | Recorded as | Note |
|-----------|-------------|------|
| "I'm 13 or older." — a box, never ticked beforehand, required | `age_confirmed: true` (R-AUTH-11, Q-23) | No date of birth is asked. What applies to users aged 13 to 15 is for the expert (review package, question 1) |
| Design: "By creating an account you accept the terms and the privacy policy. You'll decide about storing your goals in a separate step." | `privacy_policy_version`: the version of the policy linked there (A-14) | Proposed instead: "By creating an account you accept the terms. The privacy policy explains what Questline does with your data. You'll decide about storing your goals in a separate step." A policy informs; it is not something to agree to, and asking for agreement blurs the one real consent. For the expert (review package, question 10). The terms themselves do not exist yet (O-04) |

## 5. Changes to the design's wording

| Element | Design, pass 2 | This draft | Why |
|---------|----------------|------------|-----|
| Lead (§2.1) | "… so it can show your progress on all your devices." | "… on its servers, so that you see your progress on all your devices." | Says where the goals go |
| Point 2 (§2.1) | "Encrypted, and only used to run the app." | Adds "no advertising, no analytics, never sold" | States the limits of the purpose where the consent is given, not only in the summary |
| Point 3 (§2.1) | "Change your mind any time in Privacy & data." | Adds the full path and what withdrawing does | The right to withdraw and its effect belong to the information given before the consent (GDPR Art. 7(3)) |
| "Who" (§2.2) | – | New line with the controller | An informed consent names who asks for it |
| Sign-up footnote (§4) | "accept the terms and the privacy policy" | "accept the terms"; the policy "explains" | See §4 |

The checkbox label, the hint, the other summary lines and the withdrawal dialog are the design's, unchanged.

## 6. Versions

- The version is the date on which the PM approves a text, `YYYY-MM-DD`; the API accepts nothing else. One version
  covers §2.1 to §2.3 in all four languages (Q-55).
- Every change of the published text gets a new version, so that a record always names the exact text the user saw.
  The app ships each text together with its version, never one without the other.
- Users are asked again only when the meaning changes: what is stored, what for, who receives it, how to withdraw or
  what withdrawing does. For a correction of the wording, the old records stay valid.
- [[Where the published versions are kept so that each can be shown later — a tag per version in this repository is
  the simple way.]]
- **Not possible today**: recording a newer version for someone who has already agreed. A second grant answers
  `409`, and withdrawing first deletes the goals (O-15).

## 7. Check against the conditions for a valid consent

| Condition | How the text and the flow meet it |
|-----------|-----------------------------------|
| Freely given (GDPR Art. 4(11) and 7(4); FADP Art. 6(6)) | "Not now" is as prominent as "Continue" and costs nothing but the stored goals, which are the processing itself; the account, the settings and the data download work without it |
| Specific | One purpose: storing the goals and working out the progress, so that the app works on all devices. Nothing else rides along |
| Informed | What is stored, why the question is asked, how it is protected, who asks (new), how to withdraw and what that does; the summary one tap away, the policy two |
| Unambiguous and explicit (GDPR Art. 9(2)(a); FADP Art. 6(7)(a)) | A box that is never ticked beforehand, with a first-person statement that names health information; "Continue" does nothing without it |
| As easy to withdraw as to give (GDPR Art. 7(3)) | In the app, with one confirmation and no re-authentication |
| Demonstrable (GDPR Art. 7(1)) | The record of §3 with version and times; audit events for 90 days; both in the data download |
| Apart from other matters (GDPR Art. 7(2)) | A screen of its own after sign-up; not part of the terms or of the sign-up form |
| In the user's language | English here; German, French and Italian follow (Q-62) |

## 8. Open points

| # | Point | For |
|---|-------|-----|
| 1 | Approval of the text and its first version date; then the translations | PM |
| 2 | Is "Store my goals … so the app can work" explicit enough for storing and for working out progress from them, or should it read "Store and use my goals …"? Must the first screen name the legal entity, or is the summary enough? | expert (review package, question 10) |
| 3 | Consent of users aged 13 to 15 | expert (review package, question 1) |
| 4 | The wording changes of §5, to be taken into the app design | PM, app team |
| 5 | A newer version for existing users | PM (O-15) |
