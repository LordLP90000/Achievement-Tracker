import { describe, expect, it } from 'vitest';
import { ConfigError, loadApiConfig, loadBootstrapConfig, loadMigrateConfig, loadWorkerConfig } from './config.ts';

const STRONG_PASSWORD = 'Vq7mXr2pLk9sTz4wNb6c'; // gitleaks:allow — synthetic test value
const devUrl = 'postgres://questline_app:dev@localhost:5432/questline';
const prodUrl = (user: string, password = STRONG_PASSWORD) =>
  `postgres://${user}:${password}@db.internal:5432/questline?sslmode=verify-full`;

const productionApiEnv = {
  APP_ENV: 'production',
  TRUST_PROXY_HOPS: '1',
  DATABASE_URL_APP: prodUrl('questline_app'),
};

function configErrorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadApiConfig', () => {
  it('parses a development environment and applies secure defaults [R-SUP-04]', () => {
    const config = loadApiConfig({ APP_ENV: 'development', DATABASE_URL_APP: devUrl });

    expect(config).toEqual({
      appEnv: 'development',
      logLevel: 'info',
      http: { host: '127.0.0.1', port: 3000, trustProxyHops: 0 },
      databaseUrl: devUrl,
    });
  });

  it('parses explicit values', () => {
    const config = loadApiConfig({
      APP_ENV: 'test',
      LOG_LEVEL: 'warn',
      HOST: '0.0.0.0',
      PORT: '8080',
      TRUST_PROXY_HOPS: '2',
      DATABASE_URL_APP: devUrl,
    });

    expect(config.logLevel).toBe('warn');
    expect(config.http).toEqual({ host: '0.0.0.0', port: 8080, trustProxyHops: 2 });
  });

  it('treats empty variables as unset', () => {
    const config = loadApiConfig({ APP_ENV: 'development', DATABASE_URL_APP: devUrl, LOG_LEVEL: '', PORT: '' });

    expect(config.logLevel).toBe('info');
    expect(config.http.port).toBe(3000);
  });

  it('ignores unrelated environment variables', () => {
    expect(() => loadApiConfig({ APP_ENV: 'development', DATABASE_URL_APP: devUrl, PATH: '/usr/bin' })).not.toThrow();
  });

  it('returns a deeply frozen object', () => {
    const config = loadApiConfig({ APP_ENV: 'development', DATABASE_URL_APP: devUrl });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.http)).toBe(true);
  });

  it('refuses to start without required variables and names each of them [R-SUP-04, E-08]', () => {
    const error = configErrorOf(() => loadApiConfig({}));

    expect(error.issues).toEqual(['APP_ENV: is required', 'DATABASE_URL_APP: is required']);
    expect(error.message).toContain('APP_ENV: is required');
  });

  it.each([
    ['APP_ENV', 'staging', 'APP_ENV: must be one of development, test, production'],
    ['LOG_LEVEL', 'verbose', 'LOG_LEVEL: must be one of fatal, error, warn, info, debug, trace, silent'],
    ['PORT', '0', 'PORT: must be an integer between 1 and 65535'],
    ['PORT', '70000', 'PORT: must be an integer between 1 and 65535'],
    ['PORT', '80.5', 'PORT: must be an integer between 1 and 65535'],
    ['PORT', 'http', 'PORT: must be an integer between 1 and 65535'],
    ['TRUST_PROXY_HOPS', '-1', 'TRUST_PROXY_HOPS: must be an integer between 0 and 10'],
    ['TRUST_PROXY_HOPS', '11', 'TRUST_PROXY_HOPS: must be an integer between 0 and 10'],
    ['DATABASE_URL_APP', 'mysql://u:p@h/db', 'DATABASE_URL_APP: must be a postgres:// or postgresql:// URL'],
    ['DATABASE_URL_APP', 'not a url', 'DATABASE_URL_APP: must be a postgres:// or postgresql:// URL'],
  ])('rejects an invalid %s', (name, value, expectedIssue) => {
    const env = { APP_ENV: 'development', DATABASE_URL_APP: devUrl, [name]: value };

    expect(configErrorOf(() => loadApiConfig(env)).issues).toEqual([expectedIssue]);
  });

  it('never echoes a submitted value in errors [R-LOG-02]', () => {
    const secretish = 'mysql://admin:Sup3rS3cretValue@h/db';
    const error = configErrorOf(() => loadApiConfig({ APP_ENV: 'development', DATABASE_URL_APP: secretish }));

    expect(error.message).not.toContain('Sup3rS3cretValue');
    expect(JSON.stringify(error.issues)).not.toContain('Sup3rS3cretValue');
  });

  describe('production guards [R-SUP-04, E-08]', () => {
    it('accepts a hardened production environment', () => {
      const config = loadApiConfig(productionApiEnv);

      expect(config.appEnv).toBe('production');
      expect(config.http.trustProxyHops).toBe(1);
    });

    it.each(['debug', 'trace'])('refuses LOG_LEVEL=%s', (level) => {
      const error = configErrorOf(() => loadApiConfig({ ...productionApiEnv, LOG_LEVEL: level }));

      expect(error.issues).toEqual(['LOG_LEVEL: debug and trace are not allowed in production']);
    });

    it('requires TRUST_PROXY_HOPS to be set explicitly', () => {
      const env = { APP_ENV: productionApiEnv.APP_ENV, DATABASE_URL_APP: productionApiEnv.DATABASE_URL_APP };

      expect(configErrorOf(() => loadApiConfig(env)).issues).toEqual(['TRUST_PROXY_HOPS: is required in production']);
    });

    it.each([
      ['without sslmode', `postgres://questline_app:${STRONG_PASSWORD}@db.internal:5432/questline`],
      ['with sslmode=require', `postgres://questline_app:${STRONG_PASSWORD}@db/questline?sslmode=require`],
    ])('refuses a database URL %s', (_label, url) => {
      const error = configErrorOf(() => loadApiConfig({ ...productionApiEnv, DATABASE_URL_APP: url }));

      expect(error.issues).toEqual(['DATABASE_URL_APP: must use sslmode=verify-full in production']);
    });

    it.each([
      ['missing', 'postgres://questline_app@db.internal:5432/questline?sslmode=verify-full'],
      ['shorter than 16 characters', prodUrl('questline_app', 'Short1Password')],
      ['a repeated character', prodUrl('questline_app', 'a'.repeat(20))],
      ['a placeholder', prodUrl('questline_app', 'change-me-in-production-please')],
      ['containing "password"', prodUrl('questline_app', 'MyDatabasePassword2026')],
      ['equal to the user name', prodUrl('questline_app_role_x', 'questline_app_role_x')],
    ])('refuses a database password that is %s', (_label, url) => {
      const error = configErrorOf(() => loadApiConfig({ ...productionApiEnv, DATABASE_URL_APP: url }));

      expect(error.issues).toEqual(['DATABASE_URL_APP: password is missing or too weak for production']);
    });

    it('evaluates a password with malformed percent-encoding as typed instead of crashing', () => {
      const url = prodUrl('questline_app', 'Xk9%E0%A4%Aqz7Lm2Vb5Nc');

      expect(loadApiConfig({ ...productionApiEnv, DATABASE_URL_APP: url }).databaseUrl).toBe(url);
    });

    it('reports every production problem at once', () => {
      const error = configErrorOf(() =>
        loadApiConfig({ APP_ENV: 'production', LOG_LEVEL: 'debug', DATABASE_URL_APP: devUrl }),
      );

      expect(error.issues).toEqual([
        'LOG_LEVEL: debug and trace are not allowed in production',
        'TRUST_PROXY_HOPS: is required in production',
        'DATABASE_URL_APP: must use sslmode=verify-full in production',
        'DATABASE_URL_APP: password is missing or too weak for production',
      ]);
    });
  });
});

describe('loadWorkerConfig', () => {
  const workerUrl = devUrl.replace('questline_app', 'questline_worker');
  const smtpEnv = {
    SMTP_HOST: 'smtp.relay.test',
    SMTP_USER: 'relay-user@questline.test',
    SMTP_PASSWORD: STRONG_PASSWORD,
    EMAIL_FROM: 'no-reply@questline.test',
    PUBLIC_LINK_BASE_URL: 'https://app.questline.test',
  };
  const developmentEnv = { APP_ENV: 'development', DATABASE_URL_WORKER: workerUrl };
  const productionEnv = { APP_ENV: 'production', DATABASE_URL_WORKER: prodUrl('questline_worker') };

  it('needs only the worker database URL: without SMTP settings, emails stay queued (development and tests)', () => {
    expect(loadWorkerConfig(developmentEnv)).toEqual({
      appEnv: 'development',
      logLevel: 'info',
      databaseUrl: workerUrl,
      email: undefined,
    });
    expect(loadWorkerConfig({ ...developmentEnv, APP_ENV: 'test', SMTP_HOST: '' }).email).toBeUndefined();
  });

  it('applies the production guards to its database URL', () => {
    const error = configErrorOf(() =>
      loadWorkerConfig({ ...smtpEnv, APP_ENV: 'production', DATABASE_URL_WORKER: devUrl }),
    );

    expect(error.issues).toEqual([
      'DATABASE_URL_WORKER: must use sslmode=verify-full in production',
      'DATABASE_URL_WORKER: password is missing or too weak for production',
    ]);
  });

  it('parses the SMTP settings: STARTTLS on port 587 unless configured otherwise [ADR-0014]', () => {
    expect(loadWorkerConfig({ ...developmentEnv, ...smtpEnv }).email).toEqual({
      smtp: {
        host: 'smtp.relay.test',
        port: 587,
        tls: 'starttls',
        user: 'relay-user@questline.test',
        password: STRONG_PASSWORD,
        from: 'no-reply@questline.test',
      },
      linkBaseUrl: 'https://app.questline.test',
    });
  });

  it('uses port 465 for implicit TLS and accepts an explicit port', () => {
    expect(loadWorkerConfig({ ...developmentEnv, ...smtpEnv, SMTP_TLS: 'implicit' }).email?.smtp).toMatchObject({
      tls: 'implicit',
      port: 465,
    });
    expect(loadWorkerConfig({ ...developmentEnv, ...smtpEnv, SMTP_PORT: '2525' }).email?.smtp).toMatchObject({
      tls: 'starttls',
      port: 2525,
    });
  });

  it('keeps the path of the link base and drops a trailing slash', () => {
    const email = (base: string) =>
      loadWorkerConfig({ ...developmentEnv, ...smtpEnv, PUBLIC_LINK_BASE_URL: base }).email;

    expect(email('https://questline.test/app/')?.linkBaseUrl).toBe('https://questline.test/app');
    expect(email('http://localhost:8080')?.linkBaseUrl).toBe('http://localhost:8080');
  });

  it('requires every SMTP setting once one is given, naming each missing variable', () => {
    const error = configErrorOf(() => loadWorkerConfig({ ...developmentEnv, SMTP_HOST: 'smtp.relay.test' }));

    expect(error.issues).toEqual([
      'SMTP_USER: is required',
      'SMTP_PASSWORD: is required',
      'EMAIL_FROM: is required',
      'PUBLIC_LINK_BASE_URL: is required',
    ]);
  });

  it('refuses plaintext SMTP and malformed settings without echoing them [E-12]', () => {
    const error = configErrorOf(() =>
      loadWorkerConfig({
        ...developmentEnv,
        ...smtpEnv,
        SMTP_HOST: 'smtp://relay.test',
        SMTP_PORT: '70000',
        SMTP_TLS: 'none',
        EMAIL_FROM: 'Questline <no-reply@questline.test>',
        PUBLIC_LINK_BASE_URL: 'ftp://app.questline.test',
      }),
    );

    expect(error.issues).toEqual([
      'SMTP_HOST: must be a host name or IPv4 address',
      'SMTP_PORT: must be an integer between 1 and 65535',
      'SMTP_TLS: must be one of starttls, implicit (plaintext SMTP is not supported)',
      'EMAIL_FROM: must be a plain email address',
      'PUBLIC_LINK_BASE_URL: must be an http(s) URL without credentials, query or fragment',
    ]);
    expect(error.message).not.toContain('relay.test');
  });

  it('refuses a link base with credentials, a query or a fragment', () => {
    for (const base of [
      'https://user:pw@app.questline.test',
      'https://app.questline.test/?ref=mail',
      'https://app.questline.test/#x',
      'not a url',
    ]) {
      const error = configErrorOf(() =>
        loadWorkerConfig({ ...developmentEnv, ...smtpEnv, PUBLIC_LINK_BASE_URL: base }),
      );
      expect(error.issues).toEqual([
        'PUBLIC_LINK_BASE_URL: must be an http(s) URL without credentials, query or fragment',
      ]);
    }
  });

  it('requires SMTP in production [E-12]', () => {
    const error = configErrorOf(() => loadWorkerConfig(productionEnv));

    expect(error.issues).toEqual([
      'SMTP_HOST: is required',
      'SMTP_USER: is required',
      'SMTP_PASSWORD: is required',
      'EMAIL_FROM: is required',
      'PUBLIC_LINK_BASE_URL: is required',
    ]);
  });

  it('requires a strong SMTP password and an https link base in production [E-12]', () => {
    const error = configErrorOf(() =>
      loadWorkerConfig({
        ...productionEnv,
        ...smtpEnv,
        SMTP_PASSWORD: 'change-me-please-now',
        PUBLIC_LINK_BASE_URL: 'http://app.questline.test',
      }),
    );

    expect(error.issues).toEqual([
      'SMTP_PASSWORD: is too weak for production',
      'PUBLIC_LINK_BASE_URL: must use https in production',
    ]);
    expect(error.message).not.toContain('change-me');
  });

  it('accepts a complete production configuration', () => {
    expect(loadWorkerConfig({ ...productionEnv, ...smtpEnv }).email?.smtp.host).toBe('smtp.relay.test');
  });
});

describe('loadMigrateConfig', () => {
  it('requires the migrator database URL', () => {
    expect(configErrorOf(() => loadMigrateConfig({ APP_ENV: 'test' })).issues).toEqual([
      'DATABASE_URL_MIGRATOR: is required',
    ]);
  });

  it('accepts a production migrator URL', () => {
    const config = loadMigrateConfig({ APP_ENV: 'production', DATABASE_URL_MIGRATOR: prodUrl('questline_migrator') });

    expect(config.databaseUrl).toBe(prodUrl('questline_migrator'));
  });

  it('skips the production guards outside production', () => {
    expect(loadMigrateConfig({ APP_ENV: 'development', DATABASE_URL_MIGRATOR: devUrl })).toEqual({
      appEnv: 'development',
      logLevel: 'info',
      databaseUrl: devUrl,
    });
  });
});

describe('loadBootstrapConfig', () => {
  const developmentEnv = {
    APP_ENV: 'development',
    DATABASE_ADMIN_URL: 'postgres://postgres:dev@localhost:5432/postgres',
    DB_PASSWORD_MIGRATOR: 'dev-migrator',
    DB_PASSWORD_APP: 'dev-app',
    DB_PASSWORD_WORKER: 'dev-worker',
  };

  it('parses the administrator URL, database name and role passwords', () => {
    expect(loadBootstrapConfig(developmentEnv)).toEqual({
      appEnv: 'development',
      logLevel: 'info',
      adminUrl: developmentEnv.DATABASE_ADMIN_URL,
      database: 'questline',
      passwords: { migrator: 'dev-migrator', app: 'dev-app', worker: 'dev-worker' },
    });
  });

  it('requires every role password and rejects a database name that is not an identifier', () => {
    const error = configErrorOf(() =>
      loadBootstrapConfig({ APP_ENV: 'development', DATABASE_ADMIN_URL: devUrl, DATABASE_NAME: 'Quest-Line' }),
    );

    expect(error.issues).toEqual([
      'DATABASE_NAME: must be a lower-case PostgreSQL identifier',
      'DB_PASSWORD_MIGRATOR: is required',
      'DB_PASSWORD_APP: is required',
      'DB_PASSWORD_WORKER: is required',
    ]);
  });

  it('in production requires TLS for the administrator connection and strong, distinct role passwords', () => {
    const error = configErrorOf(() =>
      loadBootstrapConfig({
        APP_ENV: 'production',
        DATABASE_ADMIN_URL: `postgres://admin:${STRONG_PASSWORD}@db.internal/postgres`,
        DB_PASSWORD_MIGRATOR: STRONG_PASSWORD,
        DB_PASSWORD_APP: STRONG_PASSWORD,
        DB_PASSWORD_WORKER: 'change-me-worker-password',
      }),
    );

    expect(error.issues).toEqual([
      'DATABASE_ADMIN_URL: must use sslmode=verify-full in production',
      'DB_PASSWORD_APP: must differ from the other role passwords',
      'DB_PASSWORD_WORKER: password is missing or too weak for production',
    ]);
  });

  it('accepts a hardened production bootstrap', () => {
    const config = loadBootstrapConfig({
      APP_ENV: 'production',
      DATABASE_ADMIN_URL: prodUrl('admin'),
      DB_PASSWORD_MIGRATOR: 'Mg7xQ2vLp9sRt4wZ', // gitleaks:allow — synthetic test value
      DB_PASSWORD_APP: 'Ap3kV8nWq5zTy2xB', // gitleaks:allow — synthetic test value
      DB_PASSWORD_WORKER: 'Wk6hJ9cXr4mPs7qD', // gitleaks:allow — synthetic test value
    });

    expect(config.database).toBe('questline');
  });

  it('never echoes a password in its errors', () => {
    const error = configErrorOf(() =>
      loadBootstrapConfig({ ...developmentEnv, APP_ENV: 'production', DB_PASSWORD_APP: 'WeakButSecretValue' }),
    );

    expect(error.message).not.toContain('WeakButSecretValue');
  });
});
