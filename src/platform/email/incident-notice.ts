import { z } from 'zod';

/**
 * The incident notice (Q-61, ADR-0021): the one email whose text an operator writes, for an incident that must be told
 * to the people concerned. The text is plain: a subject on one line, a body of lines, no control characters but line
 * breaks, nothing that reorders text for display. The command checks it before queuing it, and the worker again
 * before sending it.
 */

export const NOTICE_SUBJECT_MAX = 150;
export const NOTICE_BODY_MAX = 3000;

export interface NoticeText {
  readonly subject: string;
  readonly body: string;
}

/** Unicode's bidirectional controls (U+202A–U+202E, U+2066–U+2069): they can disguise what a text says. */
const REORDERING = /[\u202A-\u202E\u2066-\u2069]/u;
/** Control characters; the body keeps its line breaks. */
const CONTROL = /\p{Cc}/u;
const CONTROL_BUT_LINE_BREAK = /[^\P{Cc}\n]/u;

const plain = (text: string, allowed: RegExp) => !allowed.test(text) && !REORDERING.test(text);

const SUBJECT_RULE = `must be 1 to ${String(NOTICE_SUBJECT_MAX)} characters on one line, without control characters`;
const BODY_RULE = `must be 1 to ${String(NOTICE_BODY_MAX)} characters of plain text, without control characters`;

const schema = z.strictObject(
  {
    subject: z
      .string({ error: SUBJECT_RULE })
      .transform((text) => text.trim())
      .refine((text) => text.length > 0 && text.length <= NOTICE_SUBJECT_MAX && plain(text, CONTROL), {
        error: SUBJECT_RULE,
      }),
    body: z
      .string({ error: BODY_RULE })
      .transform((text) => text.replaceAll(/\r\n?/g, '\n').trim())
      .refine((text) => text.length > 0 && text.length <= NOTICE_BODY_MAX && plain(text, CONTROL_BUT_LINE_BREAK), {
        error: BODY_RULE,
      }),
  },
  { error: 'must be an object with a subject and a body' },
);

/**
 * What is wrong with a notice text, by field (under `path`, e.g. `notices.de`): never the text itself, which may not
 * be logged (R-LOG-02).
 */
export function noticeTextIssues(value: unknown, path = ''): string[] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  const at = (field: string) => [path, field].filter((part) => part !== '').join('.');
  return result.error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') return issue.keys.map((key) => `${at(key)}: is not allowed`);
    const where = at(issue.path.join('.'));
    return [where === '' ? issue.message : `${where}: ${issue.message}`];
  });
}

/** The notice text, trimmed and with LF line breaks; a `TypeError` naming the fields at fault otherwise. */
export function parseNoticeText(value: unknown): NoticeText {
  const result = schema.safeParse(value);
  if (!result.success) throw new TypeError(`invalid notice text (${noticeTextIssues(value).join('; ')})`);
  return result.data;
}
