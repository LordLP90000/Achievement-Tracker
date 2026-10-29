import { describe, expect, it } from 'vitest';
import { DELETION_GRACE_MS } from '../../modules/sessions/service.ts';
import { ONE_TIME_TOKEN_LIFETIME_MS } from '../crypto/tokens.ts';
import { LOCALES, type Locale } from '../i18n/locales.ts';
import type { EmailTemplate } from './outbox-repository.ts';
import {
  DELETION_GRACE_DAYS,
  isLinkTemplate,
  linkFor,
  LINK_TEMPLATES,
  NOTICE_TEMPLATES,
  renderEmail,
  type EmailContent,
} from './templates.ts';

const TEMPLATES: readonly EmailTemplate[] = [
  'verify_email',
  'registration_notice',
  'password_reset',
  'password_changed_notice',
  'email_change_verify',
  'email_change_notice',
  'account_deleted_notice',
];
const LINK = 'https://app.questline.test/verify-email#token=ql_vt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const content = (template: EmailTemplate): EmailContent =>
  isLinkTemplate(template) ? { template, link: LINK } : { template };
const URL_LIKE = /\bhttps?:\/\/|\bwww\.|[a-z\d-]+\.(?:ch|com|test|app)\b/i;

describe('email templates [A-19, S-11]', () => {
  it('splits every template into exactly one of: carries a single-use link, or is a notice', () => {
    expect([...LINK_TEMPLATES, ...NOTICE_TEMPLATES].sort()).toEqual([...TEMPLATES].sort());
    expect(LINK_TEMPLATES).toEqual(['verify_email', 'password_reset', 'email_change_verify']);
  });

  it.each(LOCALES)('renders every template in %s with a subject, a greeting, text and the signature', (locale) => {
    for (const template of TEMPLATES) {
      const email = renderEmail(content(template), locale);

      expect(email.subject.length).toBeGreaterThan(10);
      expect(email.subject).not.toMatch(/[\r\n{}]/);
      expect(email.text).toMatch(/^(?:Hello,|Guten Tag|Bonjour,|Buongiorno,)\n\n/);
      expect(email.text).toMatch(/\n\nQuestline\n$/);
      expect(email.text).not.toMatch(/[{}]/);
    }
  });

  it('puts the link alone on its own line, exactly once, into the emails that carry one', () => {
    for (const locale of LOCALES) {
      for (const template of LINK_TEMPLATES) {
        const { text } = renderEmail({ template, link: LINK }, locale);

        expect(text.split(LINK)).toHaveLength(2);
        expect(text).toContain(`\n\n${LINK}\n\n`);
      }
    }
  });

  it('puts no link and no address of any kind into notices, so they cannot be used for phishing', () => {
    for (const locale of LOCALES) {
      for (const template of NOTICE_TEMPLATES) {
        const { subject, text } = renderEmail({ template }, locale);

        expect(subject + text).not.toMatch(URL_LIKE);
        expect(subject + text).not.toContain('@');
      }
    }
  });

  it('states the link lifetime the API enforces (R-AUTH-03) and the deletion grace period', () => {
    const minutes = ONE_TIME_TOKEN_LIFETIME_MS / 60_000;

    expect(DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000).toBe(DELETION_GRACE_MS);
    for (const locale of LOCALES) {
      for (const template of LINK_TEMPLATES) {
        expect(renderEmail({ template, link: LINK }, locale).text).toContain(`${String(minutes)} `);
      }
      expect(renderEmail({ template: 'account_deleted_notice' }, locale).text).toContain(
        `${String(DELETION_GRACE_DAYS)} `,
      );
    }
  });

  it('writes Swiss locales like their language, in Swiss orthography (no ß)', () => {
    const pairs: readonly (readonly [Locale, Locale])[] = [
      ['de-CH', 'de'],
      ['fr-CH', 'fr'],
      ['it-CH', 'it'],
    ];
    for (const [swiss, language] of pairs) {
      for (const template of TEMPLATES) {
        expect(renderEmail(content(template), swiss)).toEqual(renderEmail(content(template), language));
      }
    }
    for (const template of TEMPLATES) {
      const { subject, text } = renderEmail(content(template), 'de');
      expect(subject + text).not.toContain('ß');
    }
  });

  it('writes each language in its own words', () => {
    const subjects = (['en', 'de', 'fr', 'it'] as const).map(
      (locale) => renderEmail({ template: 'verify_email', link: LINK }, locale).subject,
    );

    expect(new Set(subjects).size).toBe(4);
    expect(renderEmail({ template: 'password_reset', link: LINK }, 'de').text).toMatch(/Passwort/);
    expect(renderEmail({ template: 'password_reset', link: LINK }, 'fr').text).toMatch(/mot de passe/);
    expect(renderEmail({ template: 'password_reset', link: LINK }, 'it').text).toMatch(/password/);
    expect(renderEmail({ template: 'password_reset', link: LINK }, 'en').text).toMatch(/password/);
  });
});

describe('linkFor [A-19]', () => {
  const token = 'ql_vt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  it('builds the app link from the configured base and keeps the token in the fragment', () => {
    expect(linkFor('https://app.questline.test', 'verify_email', token)).toBe(
      `https://app.questline.test/verify-email#token=${token}`,
    );
    expect(linkFor('https://app.questline.test', 'password_reset', token)).toBe(
      `https://app.questline.test/reset-password#token=${token}`,
    );
    expect(linkFor('https://app.questline.test', 'email_change_verify', token)).toBe(
      `https://app.questline.test/confirm-email-change#token=${token}`,
    );
  });

  it('keeps a path in the base and ignores a trailing slash', () => {
    expect(linkFor('https://questline.test/app/', 'verify_email', token)).toBe(
      `https://questline.test/app/verify-email#token=${token}`,
    );
    expect(linkFor('https://questline.test/app', 'verify_email', token)).toBe(
      `https://questline.test/app/verify-email#token=${token}`,
    );
  });
});
