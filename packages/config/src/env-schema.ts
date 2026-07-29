import { z } from 'zod';

/**
 * Environment contract.
 *
 * Six variables are required by the framework:
 *   NODE_ENV, PORT, DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, LOG_LEVEL
 *
 * Everything else has a defensible default so a new service starts with one
 * `.env` copy. Secrets never get a production default — see `applyEnvDefaults`.
 */

export const MIN_SECRET_LENGTH = 32;

/** Placeholder secrets that must never survive into production. */
export const FORBIDDEN_PRODUCTION_SECRETS = [
  'change-me',
  'changeme',
  'secret',
  'dev-secret',
  'development-only-jwt-secret-change-me-please',
  'development-only-refresh-secret-change-me-ok',
  'test-only-jwt-secret-not-for-any-real-usage',
  'test-only-refresh-secret-not-for-real-usage',
];

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);
export const logLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

const durationSchema = z
  .string()
  .regex(/^\d+[smhd]$/, 'Must be a duration such as 15m, 24h or 30d.');

/** Comma-separated list -> trimmed array. */
const csvSchema = z.string().transform((value) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
);

export const baseEnvSchema = z.object({
  // --- Required by the framework -------------------------------------------
  NODE_ENV: nodeEnvSchema,
  PORT: z.coerce.number().int().min(1).max(65535),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'DATABASE_URL must be a PostgreSQL connection string.',
    ),
  JWT_SECRET: z.string().min(1),
  JWT_REFRESH_SECRET: z.string().min(1),
  LOG_LEVEL: logLevelSchema,

  // --- Service identity ----------------------------------------------------
  SERVICE_NAME: z.string().min(1).default('trustos-service'),
  SERVICE_VERSION: z.string().min(1).default('0.0.0'),

  // --- Auth tuning ---------------------------------------------------------
  JWT_ISSUER: z.string().min(1).default('trustos'),
  JWT_AUDIENCE: z.string().min(1).default('trustos-api'),
  ACCESS_TOKEN_TTL: durationSchema.default('15m'),
  REFRESH_TOKEN_TTL: durationSchema.default('30d'),
  PASSWORD_HASH_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

  // --- HTTP ----------------------------------------------------------------
  CORS_ORIGINS: csvSchema.default(''),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  REQUEST_ID_HEADER: z.string().min(1).default('x-request-id'),
  API_GLOBAL_PREFIX: z.string().default('api'),

  // --- Observability -------------------------------------------------------
  OTEL_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),

  // --- Documentation -------------------------------------------------------
  OPENAPI_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export type RawEnv = z.infer<typeof baseEnvSchema>;

/**
 * Defaults that exist **only** outside production.
 *
 * Development and test must start with zero ceremony; production must fail
 * rather than boot on a value nobody chose. This is the entire "separate
 * configuration per environment" mechanism, and it is deliberately one small
 * function rather than three config files that drift.
 */
export function applyEnvDefaults(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const nodeEnv = source.NODE_ENV ?? 'development';
  const env: Record<string, string | undefined> = { ...source, NODE_ENV: nodeEnv };
  if (nodeEnv === 'production') return env;

  const devDefaults: Record<string, string> = {
    PORT: '3000',
    LOG_LEVEL: nodeEnv === 'test' ? 'silent' : 'debug',
    JWT_SECRET:
      nodeEnv === 'test'
        ? 'test-only-jwt-secret-not-for-any-real-usage'
        : 'development-only-jwt-secret-change-me-please',
    JWT_REFRESH_SECRET:
      nodeEnv === 'test'
        ? 'test-only-refresh-secret-not-for-real-usage'
        : 'development-only-refresh-secret-change-me-ok',
    DATABASE_URL:
      nodeEnv === 'test'
        ? 'postgresql://trustos:trustos@localhost:5432/trustos_test?schema=public'
        : 'postgresql://trustos:trustos@localhost:5432/trustos_dev?schema=public',
    // Hashing cost dominates test runtime; the floor of the allowed range is
    // still a real bcrypt hash, just a cheap one.
    PASSWORD_HASH_ROUNDS: nodeEnv === 'test' ? '10' : '11',
    OPENAPI_ENABLED: 'true',
  };

  for (const [key, value] of Object.entries(devDefaults)) {
    if (env[key] === undefined || env[key] === '') env[key] = value;
  }
  return env;
}

/** Production-only invariants that a type check cannot express. */
export function productionInvariants(env: RawEnv): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];

  for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    const value = env[key];
    if (value.length < MIN_SECRET_LENGTH) {
      problems.push(`${key}: must be at least ${MIN_SECRET_LENGTH} characters in production.`);
    }
    if (FORBIDDEN_PRODUCTION_SECRETS.includes(value.toLowerCase())) {
      problems.push(`${key}: placeholder secrets are not allowed in production.`);
    }
  }

  if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    problems.push(
      'JWT_REFRESH_SECRET: must differ from JWT_SECRET so a leaked access-token key cannot mint refresh tokens.',
    );
  }

  if (env.OPENAPI_ENABLED && env.CORS_ORIGINS.includes('*')) {
    problems.push('CORS_ORIGINS: "*" is not permitted in production.');
  }

  if (env.OTEL_ENABLED && !env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    problems.push('OTEL_EXPORTER_OTLP_ENDPOINT: required when OTEL_ENABLED=true.');
  }

  return problems;
}
