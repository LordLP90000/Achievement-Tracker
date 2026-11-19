# Breach-notification runbook: personal data breaches (FADP Art. 24, GDPR Art. 33 and 34)

Status: M6, 2026-11-05; the incident notice (§7, ADR-0021) since 2026-11-19, rehearsed on every CI run (§8). Not
rehearsed yet: a tabletop exercise with the PM is proposed for the M6 review (§8). The legal statements are for the
data-protection expert to confirm (M6 review package); the controller's contact person and an EU representative are
still open (DPIA open item 5). Controls: DPIA R-1, R-3, R-7, R-8; threats RR-1, RR-3, E-11, S-20; R-LOG-02.

## 1. What counts

- A breach of security that leads to personal data being destroyed, lost, altered, disclosed or accessed without
  authorisation, by accident or unlawfully (GDPR Art. 4(12); FADP Art. 5 let. h). Losing availability counts too: a
  lost or corrupted database is a breach (restore runbook).
- For Questline, for example: a copy of the database or a backup outside our control; the KEK, the blind-index key
  or the Connect token exposed; the app server compromised (RR-1); accounts taken over at scale; an incident at the
  host or the SMTP relay; the database lost or corrupted; personal data in a log despite R-LOG-02.

## 2. Roles

- **Controller**: Questline, represented by the PM. Decides whether to notify and signs the notifications.
- **Incident lead**: the lead engineer. Contains, assesses, keeps the record and drafts the notifications.
- **Processors** (the host, the SMTP relay; 1Password holds no personal data) report a breach to us without undue
  delay (their DPA; FADP Art. 24 para. 3, GDPR Art. 33(2)).
- **Contact person** for the authorities and the users: to be named (DPIA open item 5).

## 3. The clock

- **T0** is the moment we are reasonably certain that an incident has compromised personal data. Write it down first:
  every deadline counts from it.
- **EU** (GDPR Art. 33): the supervisory authority within **72 hours** of T0, unless the breach is unlikely to result
  in a risk to the people concerned. Details may follow in phases; a later notification gives the reasons for the
  delay.
- **Switzerland** (FADP Art. 24): the FDPIC **as soon as possible** when the breach is likely to result in a **high
  risk** to the people concerned; missing details follow as quickly as possible (DPO Art. 15 para. 2).
- **The people concerned**: without undue delay when the risk is high (GDPR Art. 34), or when it is needed for their
  protection or the FDPIC asks for it (FADP Art. 24 para. 4).

## 4. Steps

1. **Open the incident record**: T0, who noticed what and how. Add every later step with its time.
2. **Contain**, and keep the evidence (logs, the affected database, images):
   - A key may be exposed: the key-rotation runbook (`docs/runbooks/key-rotation.md`); the KEK together with a new
     Connect token.
   - Sessions or accounts compromised: end every session. Stop the API and the worker, then run
     `replay-after-restore` without `REPLACED_DATABASE_URL`. It replays only the database's own tombstones, which
     deletes nothing more, and deletes every session with its tokens: every user signs in again.
   - A database or a backup exposed: close the way in (host credentials, the database roles' passwords), and rotate
     the KEK if it could have been reached as well.
   - Data lost or corrupted: the restore runbook (`docs/runbooks/restore.md`).
3. **Assess** with §5: which data, about how many people, which keys, how likely and how severe the harm is. Record
   the reasoning, also when the result is "no notification".
4. **Decide with the PM**: notify the authorities? Inform the people concerned?
5. **Notify the authorities** (§6): the EU authorities within 72 hours of T0.
6. **Inform the people concerned** (§7: the incident notice) where required.
7. **Close**: what we learned; the threat model and the DPIA updated. Keep the record for at least two years from the
   notification (DPO Art. 15 para. 4); the GDPR asks for every breach to be documented, notified or not (Art. 33(5)).

## 5. What each leak exposes

Encrypted with each user's data key: addresses, nicknames, goal content (titles, target values and units, check-in
values and notes), device labels and TOTP secrets. Passwords are Argon2id hashes; tokens are stored hashed. Readable
in the database: user IDs, account settings (locale, time zone), XP, levels and streaks, timestamps of activity,
consent records and the truncated network prefixes in the audit events (IPv4 /24, IPv6 /48; C8).

| What leaked | What it gives away | Typical outcome |
|-------------|--------------------|-----------------|
| A database copy or a backup, without any key | The readable data above; ciphertext that stays unreadable; offline guessing of passwords against Argon2id, slow by design | Risk (pseudonymous activity data): EU notification within 72 h; FDPIC only if the risk is high; the people concerned need not be told about the encrypted data (GDPR Art. 34(3)(a)) |
| A database copy **and** the blind-index key | Whether a guessed address has an account (RR-3) | Risk; high if the attacker holds address lists: rotate the key, notify |
| A database copy **and** the KEK, or the app server (RR-1) | Everything: addresses and goal content, which may include health data | High risk: notify the FDPIC and the EU authorities, inform everyone concerned |
| The SMTP relay | Addresses and short-lived one-time links | Risk of phishing; high if links were still valid: invalidate them, inform |
| One account taken over | That user's data | Inform that user; the authorities usually only if many accounts are affected |
| Logs | Nothing personal by design (R-LOG-02) | Check what was logged; usually no notification |
| The database lost or corrupted | Availability: data after the restore point is lost (restore runbook §6) | Assess like the others; record what the lost period contained |

Users are 13 or older (R-AUTH-11): a breach may concern children, and goal content may hold health data (C6). Both
raise the severity.

## 6. Notifying the authorities

- **Switzerland, when the risk is high**: the FDPIC, through its online reporting portal (linked from
  www.edoeb.admin.ch). Contents (DPO Art. 15 para. 1): (a) the nature of the breach; (b) its time and duration if
  possible; (c) the categories and approximate amount of personal data; (d) the categories and approximate number of
  people concerned; (e) the consequences, including the risks, for them; (f) the measures taken or planned to remedy
  the breach and mitigate its consequences; (g) the name and contact details of a contact person.
- **EU, unless the breach is unlikely to result in a risk**: the GDPR applies because the app is offered to people
  in the EU (requirements §4). Questline has no establishment in the EU, so there is no lead authority: notify the
  supervisory authority of every member state whose residents are concerned (EDPB Guidelines 9/2022). Contents
  (GDPR Art. 33(3)): the nature of the breach with the categories and approximate numbers of people and records; the
  contact point; the likely consequences; the measures taken or proposed. Whether an EU representative (GDPR Art. 27)
  is needed: a question for the DP expert.
- Approximate numbers come from counts in the database, run as the migrator; never copy personal data into the
  record or the notification.

## 7. Informing the people concerned

- **When**: the risk is high (both laws). Not needed (GDPR Art. 34(3)) when the data was unintelligible to the
  attacker (encrypted, and the key not compromised), when later measures removed the high risk, or when telling each
  person would take a disproportionate effort; a public announcement then takes its place.
- **What**, in plain language and in the user's language (`users.locale`: de, fr, it or en): what happened, the likely
  consequences, what we did, what they can do (change the password, review their sessions, turn on two-step sign-in,
  beware of phishing), and the contact person (DPO Art. 15 para. 3).
- **How**: by email to every account, with the incident notice (Q-61, ADR-0021): one email per account in its
  language, also to accounts that are unverified or pending deletion. It only adds rows, so the API and the worker
  keep running.
  1. The incident lead drafts the notice as a JSON file: `incident`, a name for the incident of 3 to 64 lower-case
     letters, digits and hyphens that holds no personal data (`2026-11-database-copy`), and under `notices` a
     `subject` (one line, at most 150 characters) and a `body` (plain text, at most 3 000 characters) in each of
     `de`, `fr`, `it` and `en`; `test/e2e/fixtures/incident-notice.json` shows the shape. Every notice opens with the
     fixed greeting and closes with a fixed warning — Questline never asks for a password or a code by email; open
     the app rather than follow a link — so the text needs no link. The PM approves the texts (§2).
  2. Put the file where the maintenance job can read it, mounted read-only, and set `INCIDENT_NOTICE_FILE` to its
     path. The commands run like every maintenance command, with the migrator's role (`DATABASE_URL_MIGRATOR`):
     `node dist/maintenance.js <command>`.
  3. `preview-incident-notice`: checks the file and logs `incident notice previewed` with the accounts per language
     (`recipients`) and those already told (`alreadyNotified`); nothing is queued. A faulty file stops it, naming each
     field at fault but never the text.
  4. `send-incident-notice`, with the worker's KEK settings as well: logs `incident notice queued` with `queued`,
     `alreadyNotified` and `unreadable`. The worker sends the notices at its usual pace (`email sent`); watch for
     `email dead-lettered` (operations runbook §3).
  5. Stopped or failed: run it again; it skips every account already told about this incident. `unreadable` above 0
     (exit 1): those accounts' data keys do not open with the KEK, so they got nothing. Find out why (key-rotation
     runbook) and record it.
  6. Record the time, the counts and the texts in the incident record. Each account told keeps an
     `incident_notified` audit event for 90 days.

  On the local stack: `compose run --rm --no-deps -T -v <file>:/incident/notice.json:ro
  -e INCIDENT_NOTICE_FILE=/incident/notice.json -e KEK_SOURCE=env -e LOCAL_KEK=… migrate dist/maintenance.js
  send-incident-notice` (`compose` as in the key-rotation runbook §2).

## 8. Exercise record

| Date | Where | Result |
|------|-------|--------|
| – | Tabletop exercise with the PM: a database copy without keys, then the same copy with the KEK | Proposed for the M6 review |
| 2026-11-19 | Local Compose stack, automated in the e2e suite (every CI run) | The incident notice (§7) with `test/e2e/fixtures/incident-notice.json`, while the API and the worker ran: the preview counted every account by language and none told; the send queued one notice per account, none unreadable, and a second run queued none; an account in French and one in English got their language's text between the fixed greeting and the fixed warning; no text of the notice, address or ID in any output or container log |