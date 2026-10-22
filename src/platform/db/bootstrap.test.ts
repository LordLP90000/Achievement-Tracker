import { describe, expect, it } from 'vitest';
import { databaseUrl } from './bootstrap.ts';

describe('databaseUrl', () => {
  const admin = 'postgres://admin:adminpass@db.internal:5432/postgres?sslmode=verify-full';

  it('points the URL at another database and keeps host, port and parameters', () => {
    expect(databaseUrl(admin, 'questline')).toBe(
      'postgres://admin:adminpass@db.internal:5432/questline?sslmode=verify-full',
    );
  });

  it('replaces the credentials and percent-encodes special characters', () => {
    const url = new URL(databaseUrl(admin, 'questline', { user: 'questline_app', password: 'p@ss:w/rd#1' }));

    expect(url.username).toBe('questline_app');
    expect(decodeURIComponent(url.password)).toBe('p@ss:w/rd#1');
    expect(url.pathname).toBe('/questline');
  });
});
