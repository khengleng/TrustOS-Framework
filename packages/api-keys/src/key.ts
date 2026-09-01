import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@trustsystem/errors';

/**
 * API key generation, hashing and format.
 *
 * The format is `tos_<environment>_<32 base32 characters>`:
 *
 *   tos_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
 *
 * Four decisions, each with a reason:
 *
 *   **A recognisable prefix.** `tos_live_` is greppable. A key that leaks into a
 *   commit, a log or a support ticket can be found by a secret scanner, and that is
 *   worth more than the bytes it costs. GitHub's secret-scanning partner programme
 *   exists precisely for keys with a fixed prefix.
 *
 *   **The environment in the key.** A test key cannot be mistaken for a live one by
 *   a person reading a configuration file, and a service can refuse a `tos_test_`
 *   key in production without a database lookup.
 *
 *   **160 bits of entropy, base32.** Base32 rather than base64url so a key is
 *   case-insensitive to transcribe, contains no characters that need escaping in a
 *   URL or a shell, and survives being read down a phone line. The alphabet excludes
 *   `0/O` and `1/l/I`.
 *
 *   **SHA-256, not bcrypt.** A key is 160 bits of server-generated randomness, so it
 *   is not brute-forcible and does not need a slow KDF — and API-key verification
 *   happens on every request, where bcrypt's cost would be a self-inflicted rate
 *   limit. A password is different, and `@trustsystem/identity` uses scrypt for those.
 */

export const KEY_PREFIX = 'tos';
export const KEY_ENVIRONMENTS = ['live', 'test'] as const;
export type KeyEnvironment = (typeof KEY_ENVIRONMENTS)[number];

/** Crockford-style base32: no `0`, `1`, `l`, `I`, `O`, `U`. */
const ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';
const SECRET_LENGTH = 32;

/** Characters kept as the stored prefix: `tos_live_ab`. */
export const STORED_PREFIX_LENGTH = 11;

export interface GeneratedKey {
  /** The whole key. Returned once, at creation, and never stored. */
  key: string;
  /** Identifies the key without granting anything. Safe to display and log. */
  keyPrefix: string;
  /** SHA-256 of the whole key, lowercase hex. What is stored. */
  keyHash: string;
  environment: KeyEnvironment;
}

/**
 * Generates a key.
 *
 * Rejection sampling rather than `% alphabet.length`: the modulo of a uniform byte
 * over a 30-character alphabet is biased towards the first six characters, which
 * costs entropy for no reason.
 */
export function generateApiKey(environment: KeyEnvironment = 'live'): GeneratedKey {
  let secret = '';

  while (secret.length < SECRET_LENGTH) {
    for (const byte of randomBytes(SECRET_LENGTH)) {
      if (secret.length >= SECRET_LENGTH) break;
      // 256 is not a multiple of 30; values in the biased tail are discarded.
      if (byte >= 240) continue;
      secret += ALPHABET[byte % ALPHABET.length];
    }
  }

  const key = `${KEY_PREFIX}_${environment}_${secret}`;

  return {
    key,
    keyPrefix: key.slice(0, STORED_PREFIX_LENGTH),
    keyHash: hashApiKey(key),
    environment,
  };
}

/** SHA-256 of a key, lowercase hex. Deterministic, so a lookup is by hash. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Compares a presented key against a stored hash, in constant time.
 *
 * The hash of the candidate is computed and compared rather than the key being
 * looked up by prefix and then compared: a prefix lookup narrows to one row, and a
 * non-constant-time comparison then leaks how much of the key matched.
 */
export function verifyApiKey(presented: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashApiKey(presented), 'hex');
  const stored = Buffer.from(storedHash, 'hex');

  if (candidate.length !== stored.length || stored.length === 0) return false;
  return timingSafeEqual(candidate, stored);
}

export interface ParsedKey {
  environment: KeyEnvironment;
  prefix: string;
}

/**
 * Parses a key's shape without verifying it.
 *
 * Used to reject something that is not a key at all before a database round trip,
 * and to refuse a `tos_test_` key in a production deployment. It proves nothing
 * about validity.
 */
export function parseApiKey(key: string): ParsedKey | null {
  const match = new RegExp(`^${KEY_PREFIX}_(live|test)_([${ALPHABET}]{${SECRET_LENGTH}})$`).exec(
    key,
  );
  if (!match) return null;

  return {
    environment: match[1] as KeyEnvironment,
    prefix: key.slice(0, STORED_PREFIX_LENGTH),
  };
}

/**
 * Refuses a key that does not belong in this environment.
 *
 * A `tos_test_` key reaching production means either a misconfigured client or a
 * developer key that escaped, and both are worth failing loudly.
 */
export function assertKeyEnvironment(
  parsed: ParsedKey,
  environment: 'development' | 'test' | 'production',
): void {
  if (environment !== 'production') return;
  if (parsed.environment === 'live') return;

  throw ApiError.unauthorized(undefined, {
    reason: 'test_key_in_production',
    keyPrefix: parsed.prefix,
  });
}
