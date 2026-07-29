/**
 * Redaction is the security boundary of the logging package.
 *
 * The framework's position is that log sinks are lower-trust than the database:
 * they are searched, exported, shipped to third parties and retained long after
 * anyone remembers what is in them. Nothing that could authenticate a user or
 * decrypt data may reach one.
 */

export const REDACTED = '[redacted]';

/**
 * Keys whose value is always replaced, at any depth, regardless of shape.
 * Matching is case-insensitive and ignores `_`/`-` so `refresh_token`,
 * `refreshToken` and `REFRESH-TOKEN` are all caught.
 */
export const SENSITIVE_KEYS = [
  'password',
  'passwordhash',
  'passwordconfirmation',
  'currentpassword',
  'newpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'jwt',
  'authorization',
  'cookie',
  'setcookie',
  'secret',
  'jwtsecret',
  'jwtrefreshsecret',
  'clientsecret',
  'apikey',
  'privatekey',
  'publickey',
  'credential',
  'credentials',
  'sessionid',
  'otp',
  'pin',
  'ssn',
  'cardnumber',
  'cvv',
  'databaseurl',
  'connectionstring',
];

/** Pino `redact.paths` entries for the well-known request/response shapes. */
export const PINO_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.body.password',
  'req.body.refreshToken',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'password',
  'accessToken',
  'refreshToken',
  'token',
  'secret',
  '*.password',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
];

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, '');
const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_SET.has(normalizeKey(key));
}

const MAX_DEPTH = 8;

/**
 * Deep-redacts a value by key name.
 *
 * Pino's own `redact` handles known paths cheaply; this catches everything
 * else — a nested `user.credentials.password`, an audit diff, a caught error's
 * `config` object. Cycles and depth are bounded so a logging call can never
 * become the slowest thing in a request.
 */
export function deepRedact<T>(value: T, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((item) => deepRedact(item, depth + 1, seen));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? REDACTED : deepRedact(entry, depth + 1, seen);
  }
  return output;
}

/**
 * Redacts a bearer token down to a fingerprint.
 *
 * Occasionally you need to correlate "which token" across log lines without
 * being able to replay it. The last four characters of a signature are not
 * enough to forge anything and are enough to match two lines.
 */
export function tokenFingerprint(token: string | undefined | null): string {
  if (!token) return REDACTED;
  return `${REDACTED}:${token.slice(-4)}`;
}
