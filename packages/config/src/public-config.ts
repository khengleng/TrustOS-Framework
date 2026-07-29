import type { AppConfig } from './config';

/**
 * The subset of configuration that may be sent to a browser.
 *
 * This is an allow-list, not a deny-list. Adding a field here is a deliberate
 * act; forgetting to redact a newly added secret is not possible, because
 * nothing is included unless it is named below.
 */
export interface PublicConfig {
  serviceName: string;
  serviceVersion: string;
  environment: AppConfig['env'];
}

export function toPublicConfig(config: AppConfig): PublicConfig {
  return {
    serviceName: config.serviceName,
    serviceVersion: config.serviceVersion,
    environment: config.env,
  };
}

const SECRET_KEY_PATTERN = /(secret|password|token|key|credential|authorization|url)/i;

/**
 * Redacts secret-looking values from an arbitrary object for safe logging.
 *
 * Used for the startup "effective configuration" log line. `DATABASE_URL` is
 * caught by the `url` term because connection strings embed credentials.
 */
export function redactSecrets<T>(value: T, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactSecrets(entry, depth + 1),
    ]),
  );
}
