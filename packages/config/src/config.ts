import type { ServiceEnvironment } from '@trustsystem/shared-types';
import { applyEnvDefaults, baseEnvSchema, productionInvariants, type RawEnv } from './env-schema';

/**
 * Thrown at startup when configuration is invalid. It is intentionally *not*
 * an ApiError: there is no request to answer, and the process must not serve
 * traffic. Callers should let it terminate the process.
 */
export class ConfigurationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n` +
        'Copy packages/config/.env.example to .env and fill in the required values.',
    );
    this.name = 'ConfigurationError';
    this.problems = problems;
  }
}

export interface AppConfig {
  readonly env: ServiceEnvironment;
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly port: number;

  readonly database: {
    readonly url: string;
  };

  readonly auth: {
    /** Secret. Never serialize this object wholesale. */
    readonly jwtSecret: string;
    /** Secret. Never serialize this object wholesale. */
    readonly jwtRefreshSecret: string;
    readonly issuer: string;
    readonly audience: string;
    readonly accessTokenTtl: string;
    readonly refreshTokenTtl: string;
    readonly accessTokenTtlSeconds: number;
    readonly refreshTokenTtlSeconds: number;
    readonly passwordHashRounds: number;
  };

  readonly logging: {
    readonly level: RawEnv['LOG_LEVEL'];
  };

  readonly http: {
    readonly corsOrigins: string[];
    readonly trustProxy: boolean;
    readonly requestIdHeader: string;
    readonly globalPrefix: string;
  };

  readonly observability: {
    readonly otelEnabled: boolean;
    readonly otelEndpoint: string | undefined;
    readonly openApiEnabled: boolean;
  };
}

/**
 * Configuration keys that must never leave the server. Enforced by
 * `toPublicConfig` and asserted in tests.
 */
export const SECRET_CONFIG_PATHS = [
  'auth.jwtSecret',
  'auth.jwtRefreshSecret',
  'database.url',
] as const;

export interface LoadConfigOptions {
  /** Defaults to `process.env`. Injectable so tests never mutate the real env. */
  source?: Record<string, string | undefined>;
}

/**
 * Validates the environment and returns a frozen config object, or throws.
 *
 * Every problem is reported at once — discovering six missing variables one
 * redeploy at a time is how a Friday evening disappears.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const source = options.source ?? process.env;
  const parsed = baseEnvSchema.safeParse(applyEnvDefaults(source));

  if (!parsed.success) {
    throw new ConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  const invariantProblems = productionInvariants(parsed.data);
  if (invariantProblems.length > 0) throw new ConfigurationError(invariantProblems);

  return freezeConfig(toAppConfig(parsed.data));
}

function toAppConfig(env: RawEnv): AppConfig {
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isDevelopment: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
    serviceName: env.SERVICE_NAME,
    serviceVersion: env.SERVICE_VERSION,
    port: env.PORT,
    database: { url: env.DATABASE_URL },
    auth: {
      jwtSecret: env.JWT_SECRET,
      jwtRefreshSecret: env.JWT_REFRESH_SECRET,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      accessTokenTtl: env.ACCESS_TOKEN_TTL,
      refreshTokenTtl: env.REFRESH_TOKEN_TTL,
      accessTokenTtlSeconds: durationToSeconds(env.ACCESS_TOKEN_TTL),
      refreshTokenTtlSeconds: durationToSeconds(env.REFRESH_TOKEN_TTL),
      passwordHashRounds: env.PASSWORD_HASH_ROUNDS,
    },
    logging: { level: env.LOG_LEVEL },
    http: {
      corsOrigins: env.CORS_ORIGINS,
      trustProxy: env.TRUST_PROXY,
      requestIdHeader: env.REQUEST_ID_HEADER.toLowerCase(),
      globalPrefix: env.API_GLOBAL_PREFIX.replace(/^\/+|\/+$/g, ''),
    },
    observability: {
      otelEnabled: env.OTEL_ENABLED,
      otelEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      openApiEnabled: env.OPENAPI_ENABLED,
    },
  };
}

function freezeConfig(config: AppConfig): AppConfig {
  Object.values(config).forEach((value) => {
    if (value && typeof value === 'object') Object.freeze(value);
  });
  return Object.freeze(config);
}

/** `15m` -> 900. Duration format is validated by the schema. */
export function durationToSeconds(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) throw new ConfigurationError([`Unsupported duration: ${duration}`]);
  const amount = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
  return amount * multiplier;
}

let cached: AppConfig | null = null;

/**
 * Process-wide config singleton. Load once at startup; every consumer receives
 * the same frozen object rather than re-reading the environment.
 */
export function getConfig(options?: LoadConfigOptions): AppConfig {
  cached ??= loadConfig(options);
  return cached;
}

/** Test-only escape hatch; production code must never call this. */
export function resetConfigForTesting(): void {
  cached = null;
}
