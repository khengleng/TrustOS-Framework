import { createHash } from 'node:crypto';
import { ApiError } from '@trustsystem/errors';

/**
 * Where secrets come from.
 *
 * The framework's position is that a secret arrives from the environment or from
 * an approved secret source, and never from source control. This file is the
 * seam for the second half of that sentence — a port a deployment implements
 * against Railway variables, a cloud secret manager or Vault — plus the two
 * helpers that keep a secret from leaking once it has arrived.
 *
 * No external secret manager is integrated here. That is a deliberate boundary:
 * integrating one means adopting its client, its auth model and its failure
 * modes, and the interface below is what makes doing it later a new class rather
 * than a refactor.
 */

export interface SecretReference {
  /** Logical name, e.g. `JWT_SECRET`. Never the value. */
  name: string;
  /** Optional version or path, for sources that have one. */
  version?: string;
}

export interface SecretSource {
  readonly id: string;
  /** Resolves a secret, or null when this source does not hold it. */
  read(reference: SecretReference): Promise<string | null>;
  /** Whether the source is reachable. Contributes to readiness. */
  health(): Promise<{ ok: boolean; detail: string }>;
}

/**
 * The environment as a secret source.
 *
 * The only implementation the framework ships, and the reason it is so thin:
 * `process.env` is read in exactly one place in this repository
 * (`@trustsystem/config`), and this class exists so a *different* source can be
 * substituted without every caller learning where secrets live.
 */
export class EnvironmentSecretSource implements SecretSource {
  readonly id = 'environment';

  constructor(private readonly env: Record<string, string | undefined>) {}

  async read(reference: SecretReference): Promise<string | null> {
    const value = this.env[reference.name];
    return value === undefined || value === '' ? null : value;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'process environment' };
  }
}

/**
 * Reads a secret from the first source that has it.
 *
 * Ordered rather than merged: a chain where a later source can override an
 * earlier one is a chain where the effective value depends on evaluation order,
 * and that is not something anyone should have to reason about for a signing key.
 */
export class ChainedSecretSource implements SecretSource {
  readonly id: string;

  constructor(private readonly sources: SecretSource[]) {
    this.id = `chain(${sources.map((source) => source.id).join(' -> ')})`;
  }

  async read(reference: SecretReference): Promise<string | null> {
    for (const source of this.sources) {
      const value = await source.read(reference);
      if (value !== null) return value;
    }
    return null;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    const results = await Promise.all(this.sources.map((source) => source.health()));
    const failed = results.filter((result) => !result.ok);

    return failed.length === 0
      ? { ok: true, detail: `${results.length} source(s) reachable` }
      : { ok: false, detail: `${failed.length} of ${results.length} source(s) unreachable` };
  }
}

/**
 * Resolves a required secret, or throws.
 *
 * The error names the secret and never carries its value — including when the
 * value is present but empty, which is the case a naive check misses.
 */
export async function requireSecret(
  source: SecretSource,
  reference: SecretReference,
): Promise<string> {
  const value = await source.read(reference);

  if (value === null) {
    throw new ApiError('internal_error', {
      message: 'The service is not fully configured.',
      context: {
        reason: 'secret_missing',
        secretName: reference.name,
        secretSource: source.id,
      },
    });
  }

  return value;
}

/**
 * Field names whose values must never appear in a log, an error or an event.
 *
 * Matched case-insensitively as a substring, so `X-Api-Key`, `apiKeyHash` and
 * `refresh_token` are all caught by three entries. `@trustsystem/logging` has its own
 * redaction list for Pino; this one is for the security packages, which redact
 * before a value ever reaches a logger.
 */
export const SECRET_FIELD_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'api-key',
  'credential',
  'privatekey',
  'private_key',
  'client_secret',
  'clientsecret',
  'refresh',
  'assertion',
  'otp',
  'pin',
  'signature',
  'jwt',
  'session',
];

export const REDACTED = '[redacted]';

/**
 * Fields that *look* secret by name but are safe, and must survive redaction.
 *
 * A small, explicitly reviewed allow-list, checked before the pattern match. Every
 * entry is an identifier **derived from** a credential rather than the credential
 * itself, and each one is needed for the thing security events exist for:
 *
 *   `sessionId`        — what an administrator revokes. A trail of revocable sessions
 *                        with the ids stripped out is a trail nobody can act on.
 *   `keyPrefix`,
 *   `credentialPrefix` — identifies which credential, without being usable as one.
 *   `credentialType`   — `local` or `oidc_client_credentials`. Not a secret at all.
 *   `tokenId`          — a `jti`. Identifies a token; cannot reconstruct it.
 *   `familyId`         — the rotation family, which is how reuse is traced.
 *
 * The allow-list exists because the alternative is worse in both directions: a
 * pattern list loose enough to let `sessionId` through would also let
 * `sessionToken` through, and one tight enough to catch the token strips the id.
 *
 * Adding an entry here is a security decision. The rule is that the value must be
 * useless to an attacker who holds it.
 */
export const SAFE_IDENTIFIER_FIELDS = [
  'sessionid',
  'keyprefix',
  'credentialprefix',
  'previouskeyprefix',
  'previouscredentialprefix',
  'credentialtype',
  'tokenid',
  'familyid',
  'apikeyid',
  'previousapikeyid',
  'serviceaccountid',
  'securityeventid',
];

export function isSafeIdentifierField(name: string): boolean {
  return SAFE_IDENTIFIER_FIELDS.includes(name.toLowerCase());
}

export function isSecretFieldName(name: string): boolean {
  const lowered = name.toLowerCase();
  if (isSafeIdentifierField(lowered)) return false;
  return SECRET_FIELD_PATTERNS.some((pattern) => lowered.includes(pattern));
}

/**
 * Replaces secret-looking values anywhere in a structure.
 *
 * Applied to every context object the security packages attach to an error or an
 * event. Three properties worth stating:
 *
 *   * It redacts by *field name*, not by value shape. A token that happens to
 *     look like a UUID is still redacted, because the field it sits in says what
 *     it is.
 *   * It recurses, so a nested `{ auth: { token } }` is covered.
 *   * It is depth-limited and cycle-safe, because the thing being redacted is
 *     frequently an error's `context` assembled from untrusted input, and a
 *     redactor that can be made to recurse forever is a denial of service in the
 *     error path — the one path that has to work.
 */
export function redactSecrets(value: unknown, maxDepth = 8): unknown {
  return redact(value, maxDepth, new WeakSet());
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth <= 0) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth - 1, seen));
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSecretFieldName(key) ? REDACTED : redact(entry, depth - 1, seen);
  }
  return output;
}

/**
 * A stable, non-reversible label for a sensitive identifier.
 *
 * Used where an event needs to correlate occurrences without holding the value:
 * "the same email failed ten times" is answerable from a hash, and the hash is
 * not a mailing list if the event store leaks.
 *
 * Truncated to 16 hex characters. Not a security boundary — an email address has
 * little entropy and a determined party can confirm a guess — so it is
 * correlation-safe rather than anonymous, and the documentation says so.
 */
export function correlationHash(value: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${value.toLowerCase()}`).digest('hex').slice(0, 16);
}
