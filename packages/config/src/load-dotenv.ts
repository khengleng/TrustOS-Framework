import { config as loadDotenvFile } from 'dotenv';

/**
 * Loads `.env` files for local development.
 *
 * Call this once, first thing in an entrypoint — never from library code, and
 * never in production, where configuration comes from the platform (Railway
 * variables) rather than a file on disk.
 *
 * Precedence: real environment variables always win over file contents.
 */
export function loadDotenv(options: { path?: string; quiet?: boolean } = {}): void {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production') return;

  const files = options.path ? [options.path] : ['.env', `.env.${nodeEnv}`, '.env.local'];
  for (const file of files) {
    loadDotenvFile({ path: file, override: false });
  }
}
