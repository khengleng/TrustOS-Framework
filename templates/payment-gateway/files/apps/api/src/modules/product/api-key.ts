import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API key generation and verification.
 *
 * The rules, and why:
 *
 *   * The key is **shown once** and never stored. Only a SHA-256 hash is
 *     persisted, so a database leak does not hand anyone live credentials.
 *   * SHA-256 rather than bcrypt. The key is 256 bits of server-generated
 *     entropy, so it is not brute-forcible and does not need a slow KDF — and
 *     the gateway would otherwise pay bcrypt's cost on every authenticated
 *     request.
 *   * The prefix is stored separately so a UI can say *which* key without
 *     being able to reconstruct it.
 *   * Comparison is constant-time. A fast `===` on a credential leaks its
 *     content one byte at a time to an attacker who can measure.
 */

/** Environment marker, so a test key cannot be mistaken for a live one. */
export type ApiKeyEnvironment = 'test' | 'live';

export interface GeneratedApiKey {
  /** Shown to the caller exactly once. Never persisted, never logged. */
  key: string;
  keyHash: string;
  /** Safe to display and to store alongside the hash. */
  keyPrefix: string;
}

const KEY_BYTES = 32;
const PREFIX_LENGTH = 12;

export function generateApiKey(environment: ApiKeyEnvironment = 'test'): GeneratedApiKey {
  const secret = randomBytes(KEY_BYTES).toString('base64url');
  const key = `tos_${environment}_${secret}`;

  return {
    key,
    keyHash: hashApiKey(key),
    keyPrefix: key.slice(0, PREFIX_LENGTH),
  };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Constant-time comparison of a presented key against a stored hash.
 *
 * Both sides are hashed first, so the buffers are always the same length and
 * `timingSafeEqual` cannot throw on a length mismatch — which would itself be
 * an observable signal.
 */
export function verifyApiKey(presentedKey: string, storedHash: string): boolean {
  const presented = Buffer.from(hashApiKey(presentedKey), 'hex');
  const stored = Buffer.from(storedHash, 'hex');

  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}

/**
 * A webhook signing secret.
 *
 * Same treatment as an API key: generated server-side, shown once, stored as a
 * hash. The receiving end keeps the plaintext; the gateway only needs to prove
 * it issued it.
 */
export function generateWebhookSecret(): { secret: string; secretHash: string } {
  const secret = `whsec_${randomBytes(KEY_BYTES).toString('base64url')}`;
  return { secret, secretHash: hashApiKey(secret) };
}
