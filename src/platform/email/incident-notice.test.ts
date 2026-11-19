import { describe, expect, it } from 'vitest';
import { NOTICE_BODY_MAX, NOTICE_SUBJECT_MAX, noticeTextIssues, parseNoticeText } from './incident-notice.ts';

const valid = { subject: 'A security incident at Questline', body: 'What happened.\n\nWhat we did.' };

describe('the incident notice text (Q-61, ADR-0021) [S-20]', () => {
  it('takes a subject and a plain-text body, trimmed, with line breaks as LF', () => {
    expect(parseNoticeText({ subject: '  A subject  ', body: '\r\n First line\r\nSecond line \r\n' })).toEqual({
      subject: 'A subject',
      body: 'First line\nSecond line',
    });
  });

  it.each([
    ['an empty subject', { ...valid, subject: '   ' }, 'subject'],
    ['a subject over the limit', { ...valid, subject: 'x'.repeat(NOTICE_SUBJECT_MAX + 1) }, 'subject'],
    ['a subject on two lines, which could break the header open', { ...valid, subject: 'One\nTwo' }, 'subject'],
    ['a subject with a control character', { ...valid, subject: 'Bell\u0007' }, 'subject'],
    ['a subject that reorders its text for display', { ...valid, subject: 'Pay\u202Egnp.exe' }, 'subject'],
    ['an empty body', { ...valid, body: '\n\n' }, 'body'],
    ['a body over the limit', { ...valid, body: 'x'.repeat(NOTICE_BODY_MAX + 1) }, 'body'],
    ['a body with a control character other than a line break', { ...valid, body: 'Tab\there' }, 'body'],
    ['a body that reorders its text for display', { ...valid, body: 'Open \u2066evil\u2069 now' }, 'body'],
  ])('refuses %s', (_name, text, field) => {
    expect(noticeTextIssues(text).map((issue) => issue.split(':')[0])).toEqual([field]);
    expect(() => parseNoticeText(text)).toThrow(TypeError);
  });

  it('accepts a subject and a body of exactly the maximum length', () => {
    const longest = { subject: 's'.repeat(NOTICE_SUBJECT_MAX), body: 'b'.repeat(NOTICE_BODY_MAX) };

    expect(noticeTextIssues(longest)).toEqual([]);
  });

  it('refuses anything but a subject and a body', () => {
    expect(noticeTextIssues({ ...valid, link: 'https://example.test' })).toEqual(['link: is not allowed']);
    expect(noticeTextIssues('text')).toEqual(['must be an object with a subject and a body']);
  });

  it('names the field at fault, never the text it holds [R-LOG-02]', () => {
    const issues = noticeTextIssues({ subject: 'Secret\nsubject', body: 'Secret body\u0000' });

    expect(issues).toHaveLength(2);
    expect(issues.join(' ')).not.toMatch(/Secret/);
  });
});
