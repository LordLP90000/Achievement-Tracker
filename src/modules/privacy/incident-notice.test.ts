import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../platform/config/config.ts';
import { NOTICE_FILE_MAX_BYTES, parseIncidentNotice, readIncidentNotice } from './incident-notice.ts';

const text = (language: string) => ({ subject: `Subject ${language}`, body: `Body ${language}` });
const FILE = {
  incident: '2026-11-database-copy',
  notices: { de: text('de'), fr: text('fr'), it: text('it'), en: text('en') },
};

const issuesOf = (run: () => unknown): readonly string[] => {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected a ConfigError');
};

describe('the incident notice file (Q-61, ADR-0021) [S-20, R-LOG-02]', () => {
  let directory: string;
  const write = (content: string | Buffer) => {
    const path = join(directory, 'notice.json');
    writeFileSync(path, content);
    return { INCIDENT_NOTICE_FILE: path };
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'questline-notice-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('reads the incident and a subject and body in each of de, fr, it and en, trimmed', () => {
    const notice = readIncidentNotice(
      write(JSON.stringify({ ...FILE, notices: { ...FILE.notices, en: { subject: ' Hi ', body: 'Body\r\n' } } })),
    );

    expect(notice).toEqual({
      incident: FILE.incident,
      texts: { ...FILE.notices, en: { subject: 'Hi', body: 'Body' } },
    });
    expect(Object.isFrozen(notice) && Object.isFrozen(notice.texts) && Object.isFrozen(notice.texts.de)).toBe(true);
  });

  it.each([
    ['without the variable', {}, 'INCIDENT_NOTICE_FILE: is required'],
    ['with a blank variable', { INCIDENT_NOTICE_FILE: ' ' }, 'INCIDENT_NOTICE_FILE: is required'],
    [
      'when the file does not exist',
      { INCIDENT_NOTICE_FILE: join(tmpdir(), 'no-such-notice.json') },
      'INCIDENT_NOTICE_FILE: cannot be read',
    ],
  ])('refuses to start %s', (_name, env, issue) => {
    expect(issuesOf(() => readIncidentNotice(env))).toEqual([issue]);
  });

  it('refuses a file over 64 KiB before reading it', () => {
    expect(issuesOf(() => readIncidentNotice(write(Buffer.alloc(NOTICE_FILE_MAX_BYTES + 1, 32))))).toEqual([
      'INCIDENT_NOTICE_FILE: must be at most 64 KiB',
    ]);
  });

  it('refuses a file that is not JSON without quoting it', () => {
    const issues = issuesOf(() => readIncidentNotice(write('{ "incident": "Secret text that is not JSON')));

    expect(issues).toEqual(['INCIDENT_NOTICE_FILE: must be JSON']);
  });

  it.each([
    ['an incident name with capitals', { ...FILE, incident: 'Leak' }, ['incident: must be']],
    ['an incident name with a space', { ...FILE, incident: 'db leak' }, ['incident: must be']],
    [
      'a language missing',
      { ...FILE, notices: { de: text('de'), fr: text('fr'), en: text('en') } },
      ['notices.it: is required'],
    ],
    ['a language too many', { ...FILE, notices: { ...FILE.notices, es: text('es') } }, ['notices.es: is not allowed']],
    [
      'a subject on two lines',
      { ...FILE, notices: { ...FILE.notices, fr: { subject: 'A\nB', body: 'C' } } },
      ['notices.fr.subject: must be'],
    ],
    ['a field too many', { ...FILE, link: 'https://example.test' }, ['link: is not allowed']],
    ['no notices', { incident: FILE.incident }, ['notices: must be']],
    ['a list', [FILE], ['must be an object']],
  ])('names every field at fault in %s', (_name, value, starts) => {
    const issues = issuesOf(() => parseIncidentNotice(value));

    expect(issues).toHaveLength(starts.length);
    issues.forEach((issue, index) => {
      expect(issue.startsWith(`INCIDENT_NOTICE_FILE: ${starts[index] ?? ''}`)).toBe(true);
    });
  });

  it('never quotes the text of the notice in what it reports', () => {
    const secret = { subject: 'Secret subject\u0007', body: 'Secret body\u202E' };
    const issues = issuesOf(() => parseIncidentNotice({ ...FILE, notices: { ...FILE.notices, de: secret } }));

    expect(issues).toHaveLength(2);
    expect(issues.join(' ')).not.toContain('Secret');
  });
});
