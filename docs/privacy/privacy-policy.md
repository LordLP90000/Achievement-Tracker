# Privacy policy — English draft

Status: **draft v0.1** (2026-11-25), written by engineering for the PM and the data-protection expert (Q-62). Not
approved, not published and not legal advice; O-04 stays open until the PM approves the text and names the
controller. It describes the service as built (contract 0.4.8) and the app as designed (`docs/design/`, pass 2), and
takes its facts from the data inventory (v2), the DPIA and the processors list: note B maps each section to its
source. The German, French and Italian versions follow once this one is approved (Q-62).

`[[Double brackets]]` mark what only the PM or the expert can fill in or settle; note A lists them. The policy is
the text between the two rules. Its version is the date of the approved text, `YYYY-MM-DD`: the value the app sends
as `privacy_policy_version` when an account is created (A-14).

---

# Questline privacy policy

Version [[YYYY-MM-DD]]

Questline helps you reach big goals: you set an achievement, break it into quests and check in as you go. This
policy says what Questline stores about you, why, for how long, who else sees it and what you can do about it. It
covers the Questline app and the service behind it.

## In short

- Questline stores your email address, how you sign in, and your goals with your progress. It does not ask for your
  name, your phone number, your date of birth or your location.
- Your goals may say something about your health. Questline stores them only if you agree, and deletes them at once
  if you take that back.
- Your email address and the content of your goals are encrypted with a key that belongs to your account alone.
- No advertising, no trackers, no analytics. Your data is never sold.
- In the app you can download everything Questline stores about you, correct it, and delete your account.

## 1. Who is responsible

[[Legal name of the controller]], [[street, postcode and town]], Switzerland ("Questline", "we") runs the service
and decides how your data is used.

For anything about your data, write to [[privacy contact address]] or to the postal address above.

[[Only if the data-protection expert finds that one is required (GDPR Art. 27): our representative in the European
Union is … ]]

Swiss data protection law applies: the Federal Act on Data Protection (FADP). If you are in the European Union or
the European Economic Area, the General Data Protection Regulation (GDPR) applies as well.

## 2. What we store and why

To have an account you need an email address and a password, and you must confirm that you are 13 or older.
Everything else is up to you.

### Your account

| What | Why |
|------|-----|
| Your email address | To sign you in, to check that the address is yours, and to send you the emails listed below |
| Your password, as a hash only: a scrambled form that cannot be turned back into the password | To sign you in |
| Your time zone, your language and the day your week starts | So that dates, streaks and emails are right for you |
| A nickname, if you give one | To show it in the app |
| That you confirmed being 13 or older, and the version of this policy that applied when you signed up | As a record. We do not ask for your date of birth |

### Signing in

| What | Why |
|------|-----|
| Your sessions. For each phone or tablet you are signed in on: whether it runs iOS or Android, a name for the device if you give it one, when you signed in and last used it, how you signed in and, once the session has ended, why | So that you stay signed in, can see your devices and can sign any of them out |
| Passkeys, if you add any: the public half of the key with its technical details, and a name if you give it one. The private half, and your fingerprint or face, never leave your device | To sign you in without a password |
| Two-step sign-in, if you turn it on: the secret you share with your authenticator app, and your recovery codes as hashes | To ask for a second proof that it is you |
| One-time links and codes, as hashes | To confirm your address, reset your password or complete a sign-in |

### Your goals — only if you agree (section 3)

| What | Why |
|------|-----|
| Achievements: title, description, your motivation, category, target date, and whether you marked it private | To show your goals on all your devices and work out your progress |
| Quests: title, notes, type and size, targets and units, and how often a habit is due | The same |
| Check-ins: the day, the value and your note | The same |
| Your progress, worked out from your check-ins by fixed rules: XP and level, streaks, the score and rank of a completed achievement, badges, and XP gambles with their stake and outcome | The game side of Questline. XP has no money value, and nothing here can be bought or sold |

### Security

| What | Why |
|------|-----|
| Security events: sign-ins and failed sign-ins; changes of your password, email address or sign-in methods; sessions that were ended; downloads of your data; consent given or withdrawn; a request to delete the account. With each: the time, iOS or Android, and a shortened network address — the last part of your IP address is cut off, so it shows the network you were on, not your device | To notice and investigate a takeover of your account. You find these events in your data download |
| Counters against abuse: how many sign-in attempts and requests came from a network address or for an email address. Questline keeps only a keyed fingerprint of the address, a different one every day | To stop password guessing and floods of requests |

### Emails

Questline sends only the emails your account needs: to confirm your address or a new address, to reset your
password, to tell you that your password or your sign-in methods changed, that your email address is being changed,
that someone tried to sign up with your address, or that your account is about to be deleted — and, should it ever
be necessary, to tell you about a security incident that concerns your data. No newsletters, no advertising. The
emails are plain text without tracking, and none of them contains anything from your goals.

An email waiting to be sent is stored encrypted and deleted once it is sent. The provider that delivers our emails
(section 4) sees your address, the email itself and when it was delivered.

### Behind the scenes

| What | Why |
|------|-----|
| Operating logs: the time, the kind and the result of each request. They are built to hold no email addresses, no goal content and nothing else that identifies you [[to be confirmed for the host's own logs, which may hold IP addresses: O-01]] | To run the service and find faults |
| Repeated requests: when the app sends something again after a bad connection, Questline recognises it and gives the same answer. For that it keeps the answer for a day, encrypted | So that nothing is saved twice |
| Backups: encrypted copies of the database | To recover from a failure |

### What we do not collect

No real name, phone number, postal address or date of birth. No location, contacts or photos. No advertising or
device identifiers. No analytics and no crash reports. No tokens for push notifications: reminders are set on your
phone itself. We get no data about you from anyone else.

### The legal grounds

| Why we use your data | GDPR | Swiss FADP |
|----------------------|------|------------|
| To provide the service you signed up for: your account, signing in, your goals and progress, the emails your account needs | Art. 6(1)(b): performance of a contract | Art. 31(2)(a): processing directly connected with a contract |
| Because your goals may include health or other sensitive information | Art. 9(2)(a): your explicit consent | Art. 6(7)(a): your express consent |
| To keep your account and the service secure: security events, counters against abuse, security notices | Art. 6(1)(f): our legitimate interest in security, which is yours as well | Art. 31(1): an overriding private interest |
| To keep a record of your consent, of your age confirmation and of the policy version, and to answer your requests | Art. 6(1)(c): a legal obligation | Art. 31(1) |

## 3. Your goals and your consent

Goals can be personal: a weight goal, a therapy goal or a savings goal says something about your health or your
life. So before Questline stores your first goal, the app asks you one question, on a screen of its own, with a box
that is never ticked for you. If you choose "Not now", you can look around, but Questline stores no goals.

Your consent covers storing your achievements, quests, check-ins and notes on Questline's servers and working out
your progress from them, so that the app works on all your devices. Nothing else: not advertising, not analytics,
not training of any AI, and nobody else gets them.

You can withdraw your consent at any time in Profile → Privacy & data. All your goals are then deleted at once and
for good — every achievement with its quests, check-ins and notes, completed ones too — together with the XP, levels
and badges they earned. Your account stays, and you can agree again later and start afresh. Withdrawing does not
make what happened before unlawful.

We keep a record of when you agreed and when you withdrew, and of the version of the consent text, for as long as
you have an account.

## 4. Who else receives data

Only the providers Questline needs in order to run. Each works on our instructions under a contract, and none may
use your data for its own purposes.

| Provider | What for | What it receives | Where |
|----------|----------|------------------|-------|
| [[Hosting provider: name]] | Servers, database, backups and logs | Everything in section 2, the sensitive parts encrypted (section 7) | [[Switzerland or EU country]] |
| [[Email delivery provider: name]] | Delivering our emails | Your email address, the email itself — a link or a notice, never anything from your goals — and when it was delivered | [[country]] |

1Password (AgileBits Inc., Canada) keeps the master key that protects the keys of all accounts. It receives no
personal data.

We do not sell, rent or share your data with anyone else. [[To be worded with the expert: disclosure where a law or
a court order that binds us requires it.]]

Apple and Google handle data under their own policies when you download an app from their stores and when their
password managers keep your passkeys. Questline receives no personal data from them.

## 5. Where your data is

Your data is stored on servers in [[Switzerland or EU country]].

[[To be completed once the host and the email provider are chosen (O-01, O-02). If either is in a country without
an adequate level of data protection — a provider in the USA, for example — name the country, say which data goes
there (for the email provider: addresses and emails only, never goals) and name the safeguard.]]

## 6. How long we keep it

| What | How long |
|------|----------|
| Your account, your sign-in details and your settings | Until you delete your account |
| An account whose email address was never confirmed | 7 days |
| Your goals and your progress | Until you delete them, withdraw your consent or delete your account |
| Sessions | Until 7 days after they end. A session ends when you sign out, after 30 days without use, or after 180 days at the latest |
| One-time links and codes | Valid for 30 minutes at most, or until used, and deleted within the hour after that; a sign-in step 5 minutes; a two-step sign-in you started to set up and did not finish 24 hours |
| The record of your consent | As long as you have an account |
| Security events | 90 days |
| Counters against abuse | 24 hours |
| Answers kept for repeated requests | 24 hours |
| Emails waiting to be sent | Until sent; one that cannot be delivered, 7 days |
| Delivery records at the email provider | [[30 days at most — to be set with the provider, O-02]] |
| Operating logs | [[30 days — to be confirmed with the host, O-01]] |
| Backups | 30 days |
| After you delete your account | 30 days in which you can change your mind (section 8), then everything is erased. Backups made before that expire within another 30 days. For 35 days we keep a note that an account was deleted — a random number and the time, nothing that names you — so that a deleted account is deleted again if a backup ever has to be restored |

## 7. How we protect it

- **A key of your own.** Your email address, your nickname, the names of your devices and the content of your goals
  — titles, descriptions, notes, categories, target dates and values, check-in values — are encrypted with a key
  that belongs to your account alone. That key is locked with a master key, which is kept outside the database.
- **No readable secrets.** Passwords, recovery codes, one-time links and the tokens that keep you signed in are
  stored as hashes only.
- **What stays readable.** Some things must stay readable for the service to work: your settings, the days of your
  check-ins, the status of your achievements and quests, your XP, level and ranks. They are stored in a private
  database on encrypted disks.
- **Encrypted connections** between the app and Questline, and between Questline and its database and its email
  provider.
- **No back door for staff.** Questline's servers decrypt your goals while you use the app, to show them and to work
  out your progress; this is not end-to-end encryption. But the service has no administration screen and no
  function for staff to look at an account or its goals. [[To be confirmed once the host is chosen (O-01, O-03): the
  few people who operate the servers could, with deliberate effort, reach both the database and the master key;
  that access is limited to … and logged.]]
- **Your part.** You can add a passkey or two-step sign-in, see where you are signed in and sign a device out
  (Profile → Security).

If a security incident puts your data at high risk, we tell you by email without delay, and we notify the
authorities as the law requires. [[Wording to be confirmed by the expert with the breach runbook.]] Such an email
never asks for your password or a code, and you never need to follow a link in it: open the app instead.

## 8. Your rights

In the app, at any time and without asking us:

- **See and take your data**: Profile → Privacy & data → Download data gives you everything Questline stores about
  you as one file (JSON). It asks for your passkey or password first, and works twice in 24 hours. Left out are the
  secrets that would weaken your account if they were in a file — the password hash, keys and codes — and the
  short-lived technical copies of section 2 ("Behind the scenes").
- **Correct it**: change your profile and your email address, and edit your achievements and quests. Two things
  cannot be changed afterwards, because your XP and ranks rest on them: a check-in can be undone only on the day you
  made it, and a completed achievement can no longer be edited.
- **Delete goals**: delete a quest or a whole achievement, as long as the achievement is not completed. A completed
  achievement cannot be deleted on its own: withdrawing your consent or deleting your account removes it.
- **Withdraw your consent** (section 3).
- **Delete your account**: Profile → Privacy & data → Delete account. You are signed out everywhere at once and the
  account is closed. For 30 days you can change your mind: signing in, or resetting your password, brings the
  account back. After that everything is erased for good, together with the key that could have decrypted it.
- **End a session**: Profile → Security shows where you are signed in.

By writing to us ([[privacy contact address]]):

- **Object** to the security processing in section 2, or ask us to restrict how we use your data.
- **Ask for a correction or a deletion that the app does not offer**, or for the deletion of an account you can no
  longer get into (section 10). We will first make sure that the request comes from you. [[How: O-16.]]
- **Ask anything** about this policy or your data.

We answer within 30 days, free of charge.

You can also complain to an authority: in Switzerland the Federal Data Protection and Information Commissioner
(FDPIC, www.edoeb.admin.ch); in the EU or the EEA the data protection authority of the country where you live or
work.

Questline makes no automated decision about you that has a legal or a similarly serious effect. XP, levels, ranks
and the outcome of a gamble follow fixed rules from your own check-ins. We build no profile of you for advertising
or for anyone else.

## 9. Age

Questline is for people aged 13 or older. You confirm this when you sign up; we do not ask for your date of birth.
[[To be worded with the expert (review package, question 1): what applies to users under 16, or under the age at
which the law of their country lets them agree on their own, and whether a parent or guardian must agree.]] If we
learn that a child under 13 has an account, we delete it.

## 10. Passkeys, two-step sign-in and recovery codes

All three are optional. When you turn on two-step sign-in, the app shows you 10 recovery codes, once. Keep them
somewhere safe. If you lose your authenticator app and have no recovery code and no passkey left, nobody can let you
back in, and neither can we: there is deliberately no way around the second step, because it would be the way in
for someone else. You can then ask us to delete the account (section 8).

## 11. On your phone

Some things stay on your phone and never reach Questline [[each to be confirmed by the app team]]:

- a goal you type before you have an account — until you sign up and agree to its being stored
- reminders: your phone schedules them itself; no notification service is involved
- the app lock, with Face ID, your fingerprint or a PIN
- pictures of an achievement that you share: they are made on your phone and go only where you send them
- the file with your data download: the app hands it to you and keeps no copy

## 12. Changes to this policy

Each version of this policy carries its date. If a change matters — new data, a new purpose, a new provider — we
tell you in the app before it applies. [[And by email? PM to decide.]] If a change would go beyond what you agreed to
in section 3, we ask for your consent again. [[Where earlier versions can be read.]]

## 13. Contact

[[Legal name of the controller]] · [[postal address]] · [[privacy contact address]]

---

## Notes for the PM and the data-protection expert

### A. To fill in or settle

| # | What | Where | Who | Depends on |
|---|------|-------|-----|------------|
| 1 | The controller's legal name, address and privacy contact | §1, §8, §13 | PM | O-04, DPIA open item 5 |
| 2 | An EU representative, if one is required | §1 | expert, then PM | review package question 5 |
| 3 | The hosting provider, its country, whether its own logs hold IP addresses and for how long, and who can reach both the database and the master key | §2 (Behind the scenes), §4, §5, §6, §7 | PM | O-01, O-03 |
| 4 | The email delivery provider, its country, its retention and — outside Switzerland and the EU — the safeguard | §4, §5, §6 | PM | O-02, DPIA R-9 |
| 5 | Disclosure on a legal order: the wording | §4 | expert | – |
| 6 | The breach paragraph: when users are told | §7 | expert | review package question 5, breach runbook §7 |
| 7 | Users aged 13 to 15 and parental agreement | §9 | expert | review package question 1, DPIA R-12 |
| 8 | What stays on the phone; whether the app stores receive anything | §4 (last paragraph), §11 | app team | `docs/design/` pass 2, still in review |
| 9 | How a change is announced, and where earlier versions can be read | §12 | PM | O-15 |
| 10 | The version date | top | PM | the approval |

### B. Where each statement comes from

| Section | Source |
|---------|--------|
| In short; §2 "What we do not collect" | Data inventory §1 and the last paragraph of §3; R-PRIV-01, R-PRIV-02; `processors.md` "Explicitly not used" |
| §1 | DPIA §2 (controller) and open item 5 |
| §2 Your account | C1, C2 (the password hash), C3; A-14; R-AUTH-11, Q-23 |
| §2 Signing in | C2, C4; ADR-0019; Q-09 |
| §2 Your goals | C6, C7; R-PRIV-04 |
| §2 Security | C8, C11; R-LOG-03; Q-14 |
| §2 Emails | C10, C15; A-33; ADR-0021 for the incident notice |
| §2 Behind the scenes | C9, C13, C14; R-LOG-02 |
| §2 The legal grounds | Data inventory §2 (LB-CONTRACT, LB-CONSENT-HEALTH, LB-LEGIT-SEC, LB-LEGAL) |
| §3 | R-PRIV-04, Q-10; C5; `consent-text.md` |
| §4, §5 | `processors.md`; data inventory §4; DPIA R-7 and R-9 |
| §6 | Data inventory §3, the retention column; R-PRIV-07; R-AUTH-10 for the session lifetimes |
| §7 | R-ENC-01, R-ENC-02, R-ENC-03, R-ENC-05; breach runbook §5 and §7; ADR-0021; DPIA R-1, R-3 and R-10 |
| §8 | Data inventory §5; R-PRIV-05, R-PRIV-06, Q-11, Q-48; R-AUTH-05; the limits: R-ACH-07, Q-17, Q-36 |
| §9 | R-AUTH-11, Q-23; DPIA R-12 |
| §10 | ADR-0019, Q-52; DPIA R-17 and open item 8; threat model RR-6 |
| §11 | `docs/design/README.md` (pass 2, assumptions and answers); `docs/client-security.md` §3 and §5 |
| §12 | A-14; O-15 |

### C. Found while drafting

1. **Single items cannot always be corrected or erased** (§8). A completed achievement is read-only and cannot be
   deleted on its own (R-ACH-07, Q-17), and a check-in is final after its day (Q-36); both protect XP, ranks and
   gambles against changes after the fact. An achievement that is not completed can be deleted with its quests and
   check-ins; for the rest, erasure means all goals (withdrawing the consent) or the account. The data inventory §5
   called rectification "immediate" without this limit; it now names it. For the expert: is that enough for GDPR
   Art. 16 and 17 and FADP Art. 32, and what must the controller do when a user asks to have one such item
   corrected? Review package, question 9.
2. **A new version cannot be recorded for an existing account** (§12): a second grant of the consent answers `409`,
   withdrawing first deletes the goals, and the policy version is stored at registration only. O-15.
3. **Requests by letter or email have no procedure** (§8, §9, §10): the policy promises four things by hand —
   an objection, a correction or deletion the app does not offer, the deletion of a locked-out account (Q-52, RR-6)
   and the deletion of an under-13 account. No runbook says how the person is identified, and nothing deletes one
   account for an operator. O-16.
4. **"You accept the privacy policy"** is what the sign-up screen says and what `privacy_policy_version` records
   (A-14). A policy informs; it is not agreed to. `consent-text.md` §4 proposes a footnote that accepts the terms
   only and says what the policy is for; the field keeps its name and its meaning, the version that applied. For the
   expert (review package, question 10).
5. **The terms of use do not exist.** The sign-up screen links them, and R-AUTH-11 leaves parental consent to them.
   Q-62 covers the policy and the consent text only, so who writes the terms is the PM's to decide (O-04).
6. **Approved app-design answers will change this text once built** (`docs/design/README.md`, pass 2, answers 1 and
   3): reminder times and "hide numbers" stored with the goals (§2, Your goals), and one last email when the
   deletion is complete, for which the address is kept until then (§6, §8). Neither is in the requirements or the
   contract yet.
7. **Cloudflare** is in `processors.md` for DNS only and receives nothing from the app. If it ever proxies the API,
   it receives IP addresses and belongs in §4 and §5.
8. **A data protection officer**: possible health data of many people may make one mandatory for the GDPR's scope
   (Art. 37(1)(c)). Not asked so far. Review package, question 11.
