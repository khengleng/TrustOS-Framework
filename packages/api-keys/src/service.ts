import { ApiError } from '@trustos/errors';
import type { SecurityEventEmitter } from '@trustos/security-events';
import type { ApiKeyPolicy } from '@trustos/security-policy';
import type { ActorContext } from '@trustos/shared-types';
import {
  assertKeyEnvironment,
  generateApiKey,
  hashApiKey,
  parseApiKey,
  verifyApiKey,
  type KeyEnvironment,
} from './key';
import { addressAllowed, assertValidAllowlist } from './ip-allowlist';
import { assertValidScopes } from './scopes';

/**
 * API key lifecycle.
 *
 * The one rule everything else follows from: **the plaintext key exists for the
 * duration of one response.** It is generated, hashed, the hash is stored, the
 * plaintext is returned to the caller, and no code path can produce it again. A
 * "show key" endpoint would require storing it, and a key that can be read from the
 * database is a key that leaks with the database.
 *
 * Rotation therefore means "issue a new key and retire the old one on a schedule",
 * not "change the value of this key". The grace period exists so a client can be
 * redeployed without a synchronised cutover — the alternative is a rotation that
 * causes an outage, which is a rotation that does not happen.
 */

export interface ApiKeyRecord {
  id: string;
  organizationId: string;
  keyPrefix: string;
  keyHash: string;
  name: string;
  description: string | null;
  scopes: string[];
  ipAllowlist: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  usageCount: number;
  revokedAt: Date | null;
  revokedReason: string | null;
  rotatedFromId: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** What a caller may see. Never the hash, never anything key-shaped. */
export type ApiKeyMetadata = Omit<ApiKeyRecord, 'keyHash' | 'deletedAt'>;

export function toMetadata(record: ApiKeyRecord): ApiKeyMetadata {
  const { keyHash: _keyHash, deletedAt: _deletedAt, ...metadata } = record;
  return metadata;
}

export interface CreateApiKeyInput {
  organizationId: string;
  name: string;
  description?: string | null;
  scopes: string[];
  ipAllowlist?: string[];
  /** Lifetime in seconds. Bounded by policy; required when policy says so. */
  lifetimeSeconds?: number;
  environment?: KeyEnvironment;
  createdById?: string | null;
}

export interface CreatedApiKey {
  /** The only time this is ever available. */
  key: string;
  metadata: ApiKeyMetadata;
}

export interface ApiKeyStore {
  findByHash(keyHash: string): Promise<ApiKeyRecord | null>;
  findById(id: string, organizationId: string): Promise<ApiKeyRecord | null>;
  findByName(organizationId: string, name: string): Promise<ApiKeyRecord | null>;
  listForOrganization(organizationId: string): Promise<ApiKeyRecord[]>;
  countActive(organizationId: string): Promise<number>;
  create(
    input: Omit<ApiKeyRecord, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'usageCount'>,
  ): Promise<ApiKeyRecord>;
  update(id: string, patch: Partial<ApiKeyRecord>): Promise<ApiKeyRecord>;
  /** Records a use. Separate from `update` because it happens on every request. */
  recordUse(id: string, at: Date, ipAddress: string | null): Promise<void>;
}

export interface ApiKeyServiceOptions {
  store: ApiKeyStore;
  policy: ApiKeyPolicy;
  events?: SecurityEventEmitter;
  /** Scopes this application offers. A key cannot ask for one outside it. */
  allowedScopes?: readonly string[];
  environment?: 'development' | 'test' | 'production';
  now?: () => Date;
}

export interface VerifiedApiKey {
  record: ApiKeyRecord;
  actor: ActorContext;
}

export class ApiKeyService {
  private readonly now: () => Date;

  constructor(private readonly options: ApiKeyServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  // --- creation -------------------------------------------------------------

  async create(input: CreateApiKeyInput): Promise<CreatedApiKey> {
    const scopes = assertValidScopes(input.scopes, this.options.allowedScopes);
    const ipAllowlist = assertValidAllowlist(input.ipAllowlist ?? []);
    const expiresAt = this.resolveExpiry(input.lifetimeSeconds);

    if (await this.options.store.findByName(input.organizationId, input.name)) {
      // Names are how a person identifies a key they are about to revoke, so two
      // keys sharing one is a revocation aimed at the wrong credential.
      throw ApiError.conflict(`An API key named "${input.name}" already exists.`);
    }

    const active = await this.options.store.countActive(input.organizationId);
    if (active >= this.options.policy.maxKeysPerOrganization) {
      // A ceiling bounds the blast radius of a leak and makes an unusual number of
      // keys something an administrator has to notice.
      throw ApiError.conflict(
        `This organization already has ${active} active API keys, which is the limit.`,
        { reason: 'api_key_limit_reached', limit: this.options.policy.maxKeysPerOrganization },
      );
    }

    const generated = generateApiKey(input.environment ?? this.defaultEnvironment());

    const record = await this.options.store.create({
      organizationId: input.organizationId,
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      name: input.name,
      description: input.description ?? null,
      scopes,
      ipAllowlist,
      expiresAt,
      lastUsedAt: null,
      lastUsedIp: null,
      revokedAt: null,
      revokedReason: null,
      rotatedFromId: null,
      createdById: input.createdById ?? null,
    });

    await this.options.events?.emit({
      type: 'api_key.created',
      result: 'success',
      organizationId: input.organizationId,
      actorId: input.createdById ?? null,
      actorType: 'user',
      context: {
        apiKeyId: record.id,
        // The prefix identifies the key without granting anything. The key itself
        // never reaches an event, a log or an audit record.
        keyPrefix: record.keyPrefix,
        name: record.name,
        scopes: record.scopes,
        expiresAt: record.expiresAt?.toISOString() ?? null,
        ipAllowlistSize: record.ipAllowlist.length,
      },
    });

    return { key: generated.key, metadata: toMetadata(record) };
  }

  // --- reads ----------------------------------------------------------------

  async list(organizationId: string): Promise<ApiKeyMetadata[]> {
    const records = await this.options.store.listForOrganization(organizationId);
    return records.map(toMetadata);
  }

  async find(id: string, organizationId: string): Promise<ApiKeyMetadata> {
    const record = await this.options.store.findById(id, organizationId);
    if (!record) throw ApiError.notFound();
    return toMetadata(record);
  }

  /** Usage facts an administrator needs during a leak investigation. */
  async usage(
    id: string,
    organizationId: string,
  ): Promise<{ lastUsedAt: Date | null; lastUsedIp: string | null; usageCount: number }> {
    const record = await this.options.store.findById(id, organizationId);
    if (!record) throw ApiError.notFound();

    return {
      lastUsedAt: record.lastUsedAt,
      lastUsedIp: record.lastUsedIp,
      usageCount: record.usageCount,
    };
  }

  // --- lifecycle ------------------------------------------------------------

  async revoke(
    id: string,
    organizationId: string,
    reason: string,
    actorId: string | null = null,
  ): Promise<ApiKeyMetadata> {
    const record = await this.options.store.findById(id, organizationId);
    if (!record) throw ApiError.notFound();

    // Idempotent. A revocation is what somebody does during an incident, and the
    // second click must not produce an error that looks like a failure.
    if (record.revokedAt) return toMetadata(record);

    const revoked = await this.options.store.update(id, {
      revokedAt: this.now(),
      revokedReason: reason,
    });

    await this.options.events?.emit({
      type: 'api_key.revoked',
      result: 'success',
      reason,
      organizationId,
      actorId,
      actorType: 'user',
      context: { apiKeyId: id, keyPrefix: record.keyPrefix, name: record.name },
    });

    return toMetadata(revoked);
  }

  /**
   * Rotates a key.
   *
   * Issues a new key and schedules the old one to expire after the grace period,
   * rather than revoking it immediately. A rotation that breaks the client until it
   * is redeployed is a rotation nobody performs, and a credential nobody rotates is
   * worse than one that overlapped for a day.
   *
   * The grace period is policy, and a deployment responding to a *leak* sets it to
   * zero — or calls `revoke`, which is the honest way to say "now".
   */
  async rotate(
    id: string,
    organizationId: string,
    actorId: string | null = null,
  ): Promise<CreatedApiKey> {
    const existing = await this.options.store.findById(id, organizationId);
    if (!existing) throw ApiError.notFound();
    if (existing.revokedAt) {
      throw ApiError.conflict('This key is revoked and cannot be rotated. Create a new one.');
    }

    const now = this.now();
    const generated = generateApiKey(
      existing.keyPrefix.includes('_test_') ? 'test' : this.defaultEnvironment(),
    );

    const replacement = await this.options.store.create({
      organizationId,
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      name: `${existing.name} (rotated ${now.toISOString().slice(0, 10)})`,
      description: existing.description,
      scopes: existing.scopes,
      ipAllowlist: existing.ipAllowlist,
      expiresAt: this.resolveExpiry(
        existing.expiresAt
          ? Math.max(1, Math.floor((existing.expiresAt.getTime() - now.getTime()) / 1000))
          : undefined,
      ),
      lastUsedAt: null,
      lastUsedIp: null,
      revokedAt: null,
      revokedReason: null,
      rotatedFromId: existing.id,
      createdById: actorId,
    });

    const graceEnds = new Date(now.getTime() + this.options.policy.rotationGraceSeconds * 1000);
    await this.options.store.update(existing.id, {
      // Expiry rather than revocation, so the old key keeps working for the grace
      // period and then stops on its own.
      expiresAt:
        existing.expiresAt && existing.expiresAt.getTime() < graceEnds.getTime()
          ? existing.expiresAt
          : graceEnds,
    });

    await this.options.events?.emit({
      type: 'api_key.rotated',
      result: 'success',
      organizationId,
      actorId,
      actorType: 'user',
      context: {
        previousApiKeyId: existing.id,
        previousKeyPrefix: existing.keyPrefix,
        apiKeyId: replacement.id,
        keyPrefix: replacement.keyPrefix,
        graceEndsAt: graceEnds.toISOString(),
      },
    });

    return { key: generated.key, metadata: toMetadata(replacement) };
  }

  // --- verification ---------------------------------------------------------

  /**
   * Verifies a presented key and returns the actor it authenticates.
   *
   * The order of checks is deliberate. Shape first, because it costs nothing and
   * rejects noise. Then the hash lookup. Then revocation, expiry and the address
   * allowlist — each of which is a reason a *valid* key must not work right now, and
   * each of which produces its own security event, because "a revoked key is still
   * being used" and "a key is being used from an address nobody authorised" are
   * different investigations.
   */
  async verify(input: {
    key: string;
    ipAddress: string | null;
    userAgent?: string | null;
    requestId?: string | null;
    /** Resolves the organization's roles and permissions for the key's actor. */
    resolveAccess: (
      organizationId: string,
    ) => Promise<{ roles: string[]; permissions: string[] } | null>;
  }): Promise<VerifiedApiKey> {
    const parsed = parseApiKey(input.key);

    if (!parsed) {
      await this.failed('malformed_key', null, input);
      throw invalidApiKey();
    }

    assertKeyEnvironment(parsed, this.options.environment ?? 'development');

    const record = await this.options.store.findByHash(hashApiKey(input.key));

    if (!record || record.deletedAt !== null) {
      await this.failed('unknown_key', parsed.prefix, input);
      throw invalidApiKey();
    }

    // Constant-time, even though the row was found by hash. Defence in depth
    // against a store that matches loosely.
    if (!verifyApiKey(input.key, record.keyHash)) {
      await this.failed('hash_mismatch', record.keyPrefix, input);
      throw invalidApiKey();
    }

    if (record.revokedAt) {
      await this.failed('key_revoked', record.keyPrefix, input, {
        apiKeyId: record.id,
        revokedAt: record.revokedAt.toISOString(),
      });
      throw invalidApiKey();
    }

    const now = this.now();
    if (record.expiresAt && record.expiresAt.getTime() <= now.getTime()) {
      await this.options.events?.emit({
        type: 'api_key.expired',
        result: 'blocked',
        reason: 'key_expired',
        organizationId: record.organizationId,
        actorType: 'api_key',
        actorId: record.id,
        ipAddress: input.ipAddress,
        requestId: input.requestId ?? null,
        context: { apiKeyId: record.id, keyPrefix: record.keyPrefix },
      });
      throw invalidApiKey();
    }

    if (!addressAllowed(input.ipAddress, record.ipAllowlist)) {
      await this.options.events?.emit({
        type: 'api_key.ip_denied',
        result: 'blocked',
        reason: 'address_not_allowlisted',
        organizationId: record.organizationId,
        actorType: 'api_key',
        actorId: record.id,
        ipAddress: input.ipAddress,
        requestId: input.requestId ?? null,
        context: { apiKeyId: record.id, keyPrefix: record.keyPrefix },
      });
      throw invalidApiKey();
    }

    const access = await input.resolveAccess(record.organizationId);
    if (!access) {
      // The organization is gone or inactive. The key is valid and there is nothing
      // for it to act on.
      await this.failed('organization_unavailable', record.keyPrefix, input, {
        apiKeyId: record.id,
      });
      throw invalidApiKey();
    }

    // Recorded before the request is served, so a key that is being used shows a
    // recent timestamp even if the request then fails.
    await this.options.store.recordUse(record.id, now, input.ipAddress);

    await this.options.events?.emit({
      type: 'api_key.auth_succeeded',
      result: 'success',
      organizationId: record.organizationId,
      actorType: 'api_key',
      actorId: record.id,
      ipAddress: input.ipAddress,
      requestId: input.requestId ?? null,
      context: { apiKeyId: record.id, keyPrefix: record.keyPrefix, scopes: record.scopes },
    });

    return {
      record,
      actor: {
        actorType: 'api_key',
        // The key's id, not a user's. An audit record for this request must not
        // name the person who created the key months ago.
        userId: record.id,
        email: '',
        organizationId: record.organizationId,
        roles: access.roles,
        permissions: access.permissions,
        // A key never carries platform-wide power, whatever its organization's
        // members hold.
        isSuperAdmin: false,
        tokenId: record.keyPrefix,
        scopes: record.scopes,
        provider: 'api-key',
      },
    };
  }

  // --- internals ------------------------------------------------------------

  private defaultEnvironment(): KeyEnvironment {
    return this.options.environment === 'production' ? 'live' : 'test';
  }

  private resolveExpiry(lifetimeSeconds: number | undefined): Date | null {
    const { maxLifetimeSeconds, requireExpiry } = this.options.policy;

    if (lifetimeSeconds === undefined) {
      if (!requireExpiry) return null;
      // Defaulting to the maximum rather than refusing: an expiry is required, and
      // a caller who did not think about it gets the longest permitted rather than
      // an error they will work around by asking for the longest permitted.
      return new Date(this.now().getTime() + maxLifetimeSeconds * 1000);
    }

    if (lifetimeSeconds > maxLifetimeSeconds) {
      throw ApiError.validation(
        [
          {
            path: 'lifetimeSeconds',
            message: `At most ${maxLifetimeSeconds} seconds is permitted by policy.`,
          },
        ],
        'The requested key lifetime exceeds the policy maximum.',
      );
    }

    return new Date(this.now().getTime() + lifetimeSeconds * 1000);
  }

  private async failed(
    reason: string,
    keyPrefix: string | null,
    input: { ipAddress: string | null; userAgent?: string | null; requestId?: string | null },
    context: Record<string, unknown> = {},
  ): Promise<void> {
    await this.options.events?.emit({
      type: 'api_key.auth_failed',
      result: 'failure',
      reason,
      actorType: 'api_key',
      ipAddress: input.ipAddress,
      userAgent: input.userAgent ?? null,
      requestId: input.requestId ?? null,
      context: { keyPrefix, ...context },
    });
  }
}

/**
 * The one error every API-key failure produces.
 *
 * Same code and message whether the key is malformed, unknown, revoked, expired or
 * used from a disallowed address. Anything more specific tells a holder of a stolen
 * key which of those to fix, and the distinction is in the security event where it
 * is useful and not visible.
 */
export function invalidApiKey(): ApiError {
  return ApiError.unauthorized('The API key is not valid.', { reason: 'invalid_api_key' });
}
