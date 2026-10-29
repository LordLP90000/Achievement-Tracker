import { describe, expect, it } from 'vitest';
import {
  checkPassword,
  loadBreachedPasswordFilter,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './password-policy.ts';

describe('password policy (ADR-0012, NIST SP 800-63B) [R-AUTH-02]', () => {
  const filter = loadBreachedPasswordFilter();

  it('allows 12 to 128 characters, counted as Unicode code points [Q-06]', () => {
    expect([PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]).toEqual([12, 128]);
    expect(checkPassword(filter, 'x7Kp!m2q#Lw9')).toBe('ok');
    expect(checkPassword(filter, 'x7Kp!m2q#Lw')).toBe('too_short');
    expect(checkPassword(filter, '😀'.repeat(12))).toBe('ok');
    expect(checkPassword(filter, '😀'.repeat(11))).toBe('too_short');
    expect(checkPassword(filter, 'Zq'.repeat(64))).toBe('ok');
    expect(checkPassword(filter, `${'Zq'.repeat(64)}x`)).toBe('too_long');
  });

  it('has no composition rules: a long lower-case passphrase is fine', () => {
    expect(checkPassword(filter, 'purple elephants dance quietly')).toBe('ok');
  });

  it.each(['123qweasdzxc', '1qaz2wsx3edc', 'qwerty123456', '123456654321', 'qwertyqwerty', 'q1w2e3r4t5y6'])(
    'rejects %j from the pinned list of breached passwords',
    (password) => {
      expect(checkPassword(filter, password)).toBe('breached');
    },
  );

  it('compares after NFKC, so full-width spellings of a breached password are rejected too', () => {
    expect(checkPassword(filter, 'ｑｗｅｒｔｙ１２３４５６')).toBe('breached');
  });

  it.each(['questline2026!', 'MyQuestLine-password', 'ＱＵＥＳＴＬＩＮＥ forever'])(
    'rejects %j because it contains the name of the service',
    (password) => {
      expect(checkPassword(filter, password)).toBe('breached');
    },
  );

  it('ships the filter built from the pinned list: entries of at least 12 characters only', () => {
    const { meta } = filter;

    expect(meta.entries).toBe(46_296);
    expect(meta.minLength).toBe(12);
    expect(meta.source.toString('hex')).toBe('424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51');
  });
});
