import { readFileSync, statSync } from 'node:fs';
import { ConfigError, type Env } from '../../platform/config/config.ts';
import { DecryptionError } from '../../platform/crypto/aead.ts';
import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { decryptText } from '../../platform/crypto/field-cipher.ts';
import { UnknownKekError } from '../../platform/crypto/key-wrapper.ts';
import { inTransaction, type Database, type Transaction } from '../../platform/db/database.ts';
import { transactionLock } from '../../platform/db/locks.ts';
import { noticeTextIssues, parseNoticeText, type NoticeText } from '../../platform/email/incident-notice.ts';
import { enqueueEmail } from '../../platform/email/outbox-repository.ts';
import { EMAIL_LANGUAGES, INCIDENT_TEMPLATE, languageOf, type EmailLanguage } from '../../platform/email/templates.ts';
import { DEFAULT_LOCALE, isLocale, type Locale } from '../../platform/i18n/locales.ts';
import { emailField } from '../accounts/account-mail.ts';
import { recordAuditEvent } from '../audit/repository.ts';
import {
  accountsByLocale,
  notifiedAmong,
  notifiedCount,
  recipientsAfter,
  type NoticeRecipient,
} from './incident-notice-repository.ts';

/**
 * The incident notice (Q-61, ADR-0021): after a breach that must be told to the people concerned (FADP Art. 24
 * para. 4, GDPR Art. 34), one email to every account, in its language, with the text the operator wrote for the
 * incident. An `incident_notified` audit event records each account told, so a run that stopped can simply run again.
 */

/** Accounts per transaction: each has its address decrypted and one email and one audit event written. */
export const NOTICE_BATCH_SIZE = 500;
/** Four subjects and bodies fit many times over. */
export const NOTICE_FILE_MAX_BYTES = 64 * 1024;

const INCIDENT_ID = /^[a-z\d][a-z\d-]{1,62}[a-z\d]$/;
const INCIDENT_RULE =
  'must be 3 to 64 lower-case letters, digits or hyphens, starting and ending with a letter or digit';

export interface IncidentNotice {
  /** Names the incident in the audit events: it may not hold personal data, so its alphabet is closed. */
  readonly incident: string;
  readonly texts: Readonly<Record<EmailLanguage, NoticeText>>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What is wrong with a notice file's content, by field: never the text it holds (R-LOG-02). */
export function incidentNoticeIssues(value: unknown): string[] {
  if (!isRecord(value)) return ['must be an object with an incident and its notices'];
  const { incident, notices } = value;
  const unknown = Object.keys(value).filter((key) => key !== 'incident' && key !== 'notices');
  const issues = [
    ...unknown.map((key) => `${key}: is not allowed`),
    ...(typeof incident === 'string' && INCIDENT_ID.test(incident) ? [] : [`incident: ${INCIDENT_RULE}`]),
  ];
  if (!isRecord(notices)) return [...issues, 'notices: must be an object with a notice in de, fr, it and en'];
  const languages: readonly string[] = EMAIL_LANGUAGES;
  return [
    ...issues,
    ...Object.keys(notices)
      .filter((key) => !languages.includes(key))
      .map((key) => `notices.${key}: is not allowed`),
    ...EMAIL_LANGUAGES.flatMap((language) =>
      notices[language] === undefined
        ? [`notices.${language}: is required`]
        : noticeTextIssues(notices[language], `notices.${language}`),
    ),
  ];
}

/** The notice of a parsed file, its texts trimmed; a `ConfigError` naming every field at fault otherwise. */
export function parseIncidentNotice(value: unknown): IncidentNotice {
  const issues = incidentNoticeIssues(value);
  if (!isRecord(value) || !isRecord(value['notices']) || issues.length > 0) {
    throw new ConfigError(issues.map((issue) => `INCIDENT_NOTICE_FILE: ${issue}`));
  }
  const notices = value['notices'];
  const texts = Object.fromEntries(
    EMAIL_LANGUAGES.map((language) => [language, Object.freeze(parseNoticeText(notices[language]))]),
  ) as Record<EmailLanguage, NoticeText>;
  return Object.freeze({ incident: String(value['incident']), texts: Object.freeze(texts) });
}

/** Reads the notice from the JSON file that `INCIDENT_NOTICE_FILE` names. */
export function readIncidentNotice(env: Env): IncidentNotice {
  const path = env['INCIDENT_NOTICE_FILE']?.trim();
  if (path === undefined || path === '') throw new ConfigError(['INCIDENT_NOTICE_FILE: is required']);
  let content: string;
  try {
    if (statSync(path).size > NOTICE_FILE_MAX_BYTES) {
      throw new ConfigError(['INCIDENT_NOTICE_FILE: must be at most 64 KiB']);
    }
    content = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(['INCIDENT_NOTICE_FILE: cannot be read']);
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    // A JSON syntax error quotes the text around it; the notice may not be logged before it is sent.
    throw new ConfigError(['INCIDENT_NOTICE_FILE: must be JSON']);
  }
  return parseIncidentNotice(value);
}

const localeOf = (stored: string): Locale => (isLocale(stored) ? stored : DEFAULT_LOCALE);

export interface NoticePreview {
  /** Accounts by the language their notice is written in. */
  readonly recipients: Readonly<Record<EmailLanguage, number>>;
  /** Accounts that already got this incident's notice. */
  readonly alreadyNotified: number;
}

/** Who would get the notice, by language, and who already got it: counts only, nothing queued. */
export async function previewIncidentNotice(db: Database, notice: IncidentNotice): Promise<NoticePreview> {
  const byLocale = await accountsByLocale(db);
  const recipients = Object.fromEntries(
    EMAIL_LANGUAGES.map((language) => [
      language,
      byLocale.filter((row) => languageOf(localeOf(row.locale)) === language).reduce((sum, row) => sum + row.count, 0),
    ]),
  ) as Record<EmailLanguage, number>;
  return { recipients, alreadyNotified: await notifiedCount(db, notice.incident) };
}

export interface NoticeResult {
  readonly queued: number;
  readonly alreadyNotified: number;
  /** Accounts whose address the KEK does not open: they got no notice. */
  readonly unreadable: number;
}

export interface NoticeOptions {
  readonly now: Date;
  /** Accounts per transaction (tests). */
  readonly batchSize?: number;
}

type Outcome = keyof NoticeResult;

const tally = (outcomes: readonly Outcome[]): NoticeResult => ({
  queued: outcomes.filter((outcome) => outcome === 'queued').length,
  alreadyNotified: outcomes.filter((outcome) => outcome === 'alreadyNotified').length,
  unreadable: outcomes.filter((outcome) => outcome === 'unreadable').length,
});

/** Queues the account's notice in its language and records that it was told, in the same transaction. */
async function queueNotice(
  tx: Transaction,
  dataKeys: DataKeys,
  notice: IncidentNotice,
  recipient: NoticeRecipient,
  now: Date,
): Promise<Outcome> {
  const { userId, wrapped } = recipient;
  if (wrapped === undefined) return 'unreadable';
  try {
    await dataKeys.withKey(userId, wrapped, async (dataKey) => {
      const to = decryptText(dataKey, emailField(userId), recipient.emailEnc);
      const locale = localeOf(recipient.locale);
      const payload = { to, locale, notice: notice.texts[languageOf(locale)] };
      await enqueueEmail(tx, dataKey, { userId, template: INCIDENT_TEMPLATE, payload }, now);
      await recordAuditEvent(
        tx,
        {
          userId,
          eventType: 'incident_notified',
          outcome: 'success',
          ipPrefix: null,
          client: null,
          metadata: { incident: notice.incident },
        },
        now,
      );
    });
    return 'queued';
  } catch (error) {
    if (error instanceof DecryptionError || error instanceof UnknownKekError) return 'unreadable';
    throw error;
  }
}

/**
 * Queues the notice for every account, batch by batch, verified or not and pending deletion too: each one's data may
 * be concerned. An account already told about this incident is skipped; one whose address the KEK does not open is
 * counted and left, and the walk goes on.
 */
export async function sendIncidentNotice(
  db: Database,
  dataKeys: DataKeys,
  notice: IncidentNotice,
  options: NoticeOptions,
): Promise<NoticeResult> {
  const batchSize = options.batchSize ?? NOTICE_BATCH_SIZE;
  let outcomes: Outcome[] = [];
  for (let after: string | undefined; ;) {
    const batch = await inTransaction(db, async (tx) => {
      // Overlapping runs take turns batch by batch, so each sees whom the other told: nobody gets it twice.
      await transactionLock(tx, `incident-notice:${notice.incident}`);
      const recipients = await recipientsAfter(tx, after, batchSize);
      const told = await notifiedAmong(
        tx,
        notice.incident,
        recipients.map((recipient) => recipient.userId),
      );
      let found: Outcome[] = [];
      for (const recipient of recipients) {
        const outcome = told.has(recipient.userId)
          ? 'alreadyNotified'
          : await queueNotice(tx, dataKeys, notice, recipient, options.now);
        found = [...found, outcome];
      }
      return { found, size: recipients.length, last: recipients.at(-1)?.userId };
    });
    outcomes = [...outcomes, ...batch.found];
    if (batch.size < batchSize) break;
    after = batch.last;
  }
  return tally(outcomes);
}
