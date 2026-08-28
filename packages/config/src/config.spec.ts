import { describe, expect, it } from 'vitest';
import { ConfigurationError, durationToSeconds, loadConfig } from './config';
import { toPublicConfig, redactSecrets } from './public-config';

const productionEnv = {
  NODE_ENV: 'production',
  PORT: '8080',
  DATABASE_URL: 'postgresql://user:pw@db.railway.internal:5432/railway',
  JWT_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  LOG_LEVEL: 'info',
};

describe('loadConfig', () => {
  it('needs nothing but NODE_ENV in development', () => {
    const config = loadConfig({ source: { NODE_ENV: 'development' } });
    expect(config.env).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.logging.level).toBe('debug');
    expect(config.auth.jwtSecret).not.toBe(config.auth.jwtRefreshSecret);
  });

  it('silences logs and cheapens hashing in test', () => {
    const config = loadConfig({ source: { NODE_ENV: 'test' } });
    expect(config.isTest).toBe(true);
    expect(config.logging.level).toBe('silent');
    expect(config.auth.passwordHashRounds).toBe(10);
  });

  it('accepts a complete production environment', () => {
    const config = loadConfig({ source: productionEnv });
    expect(config.isProduction).toBe(true);
    expect(config.port).toBe(8080);
    expect(config.auth.accessTokenTtlSeconds).toBe(900);
    expect(config.auth.refreshTokenTtlSeconds).toBe(2_592_000);
  });

  it('refuses to boot production without explicit secrets', () => {
    expect(() => loadConfig({ source: { NODE_ENV: 'production' } })).toThrow(ConfigurationError);
  });

  it('reports every problem at once rather than one per restart', () => {
    try {
      loadConfig({ source: { NODE_ENV: 'production' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      const problems = (error as ConfigurationError).problems;
      expect(problems.length).toBeGreaterThanOrEqual(4);
      expect(problems.join('\n')).toContain('DATABASE_URL');
      expect(problems.join('\n')).toContain('JWT_SECRET');
    }
  });

  it('rejects short and placeholder production secrets', () => {
    expect(() => loadConfig({ source: { ...productionEnv, JWT_SECRET: 'short' } })).toThrow(
      /at least 32 characters/,
    );
    expect(() =>
      loadConfig({
        source: {
          ...productionEnv,
          JWT_SECRET: 'development-only-jwt-secret-change-me-please',
        },
      }),
    ).toThrow(/placeholder secrets/);
  });

  it('rejects reusing one secret for both token types', () => {
    expect(() =>
      loadConfig({ source: { ...productionEnv, JWT_REFRESH_SECRET: productionEnv.JWT_SECRET } }),
    ).toThrow(/must differ from JWT_SECRET/);
  });

  it('rejects a non-PostgreSQL DATABASE_URL', () => {
    expect(() =>
      loadConfig({ source: { ...productionEnv, DATABASE_URL: 'mysql://user:pw@host/db' } }),
    ).toThrow(/PostgreSQL/);
  });

  it('rejects wildcard CORS in production', () => {
    expect(() =>
      loadConfig({ source: { ...productionEnv, CORS_ORIGINS: 'https://a.kh,*' } }),
    ).toThrow(/not permitted in production/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ source: { ...productionEnv, PORT: '99999' } })).toThrow(
      ConfigurationError,
    );
  });

  it('returns a frozen object so nothing can rewrite config at runtime', () => {
    const config = loadConfig({ source: productionEnv });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.auth)).toBe(true);
  });
});

describe('secret containment', () => {
  it('excludes every secret from the browser-facing config', () => {
    const config = loadConfig({ source: productionEnv });
    const serialized = JSON.stringify(toPublicConfig(config));

    expect(serialized).not.toContain(productionEnv.JWT_SECRET);
    expect(serialized).not.toContain(productionEnv.JWT_REFRESH_SECRET);
    expect(serialized).not.toContain('db.railway.internal');
    expect(Object.keys(toPublicConfig(config)).sort()).toEqual([
      'environment',
      'serviceName',
      'serviceVersion',
    ]);
  });

  it('redacts secrets from a loggable config snapshot', () => {
    const config = loadConfig({ source: productionEnv });
    const redacted = JSON.stringify(redactSecrets(config));

    expect(redacted).not.toContain(productionEnv.JWT_SECRET);
    expect(redacted).not.toContain('db.railway.internal');
    expect(redacted).toContain('[redacted]');
    // Non-secret values stay readable, otherwise the log line is useless.
    expect(redacted).toContain('"serviceName"');
  });
});

describe('durationToSeconds', () => {
  it.each([
    ['30s', 30],
    ['15m', 900],
    ['24h', 86400],
    ['30d', 2592000],
  ])('converts %s', (input, expected) => {
    expect(durationToSeconds(input)).toBe(expected);
  });
});
