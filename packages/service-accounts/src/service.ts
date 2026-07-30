import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@trustos/errors';
import { assertValidScopes, scopesSatisfyAll } from '@trustos/api-keys';
import type { SecurityEventEmitter } from '@trustos/security-events';
import type { ApiKeyPolicy } from '@trustos/security-policy';
import type { ActorContext } from '@trustos/shared-types';

/**
 * Service accounts.
 *
 * A machine identity, and the reason it is a separate concept from a user account is
 * the whole point of the package: reusing a person's account for an integration means
 * the integration dies when they leave, their password rotation breaks production,
 * their MFA cannot be satisfied by a cron job, and every audit record for the
 * integration names a person who did not do it.
 *
 * So a service account has no password, no MFA, no interactive login, and an owner
 * recorded separately from the identity it acts as.
 *
 * Two ways to authenticate, matching the two identity modes:
 *
 *   **OIDC**  — the identity provider issues tokens by the client-credentials grant.
 *   The account here is the local record of roles, scopes and status, keyed by the
 *   provider's client id; the provider owns the credential. This is the mode to use in
 *   production, because credential rotation is then the provider's problem and the
 *   framework never holds a secret.
 *
 *   **Local** — the framework issues a credential of its own, hashed the same way an
 *   API key is. For development, for tests, and for a deployment with no identity
 *   provider.
 *
 * A service account is never `isSuperAdmin`. Platform-wide power belongs to a person
 * who can be asked why they used it.
 */

export type ServiceAccountStatus = 'active' | 'disabled' | 'expired';

export interface ServiceAccountRecord {
  id: string;
  /** Null for a platform-level account that belongs to no organization. */
  organizationId: string | null;
  name: string;
  description: string | null;
  status: ServiceAccountStatus;
  roles: string[];
  scopes: string[];
  /** OIDC client id, when the provider owns the credential. */
  oidcClientId: string | null;
  credentialHash: string | null;
  credentialPrefix: string | null;
  credentialExpiresAt: Date | null;
  credentialRotatedAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  expiresAt: Date | null;
  /** Who created it. Not who it acts as — that is the account itself. */
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** What a caller may see. Never a hash. */
export type ServiceAccountMetadata = Omit<ServiceAccountRecord, 'credentialHash' | 'deletedAt'>;

export function toMetadata(record: ServiceAccountRecord): ServiceAccountMetadata {
  const { credentialHash: _hash, deletedAt: _deleted, ...metadata } = record;
  return metadata;
}

export interface ServiceAccountStore {
  findById(id: string): Promise<ServiceAccountRecord | null>;
  findByCredentialHash(hash: string): Promise<ServiceAccountRecord | null>;
  findByOidcClientId(clientId: string): Promise<ServiceAccountRecord | null>;
  findByName(organizationId: string | null, name: string): Promise<ServiceAccountRecord | null>;
  list(organizationId: string | null): Promise<ServiceAccountRecord[]>;
  create(
    input: Omit<ServiceAccountRecord, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<ServiceAccountRecord>;
  update(id: string, patch: Partial<ServiceAccountRecord>): Promise<ServiceAccountRecord>;
  recordUse(id: string, at: Date, ipAddress: string | null): Promise<void>;
}

export const CREDENTIAL_PREFIX = 'tos_sa';
const CREDENTIAL_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';
const CREDENTIAL_LENGTH = 40;
const STORED_PREFIX_LENGTH = 13;

export interface GeneratedCredential {
  /** Returned once. Never stored, never recoverable. */
  credential: string;
  prefix: string;
  hash: string;
}

/**
 * Generates a local service-account credential.
 *
 * 200 bits, longer than an API key's 160, because a service credential typically
 * lives longer and is rotated less often than a key created for one integration.
 * Rejection-sampled, for the same reason as an API key: modulo over a 30-character
 * alphabet is biased.
 */
export function generateServiceCredential(): GeneratedCredential {
  let secret = '';

  while (secret.length < CREDENTIAL_LENGTH) {
    for (const byte of randomBytes(CREDENTIAL_LENGTH)) {
      if (secret.length >= CREDENTIAL_LENGTH) break;
      if (byte >= 240) continue;
      secret += CREDENTIAL_ALPHABET[byte % CREDENTIAL_ALPHABET.length];
    }
  }

  const credential = `${CREDENTIAL_PREFIX}_${secret}`;
  return {
    credential,
    prefix: credential.slice(0, STORED_PREFIX_LENGTH),
    hash: hashCredential(credential),
  };
}

export function hashCredential(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}

export function verifyCredential(presented: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashCredential(presented), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (candidate.length !== stored.length || stored.length === 0) return false;
  return timingSafeEqual(candidate, stored);
}

export interface CreateServiceAccountInput {
  organizationId: string | null;
  name: string;
  description?: string | null;
  roles?: string[];
  scopes: string[];
  /** Provider client id, for the OIDC mode. Mutually exclusive with a credential. */
  oidcClientId?: string | null;
  /** Issue a local credential. Ignored when `oidcClientId` is set. */
  issueCredential?: boolean;
  lifetimeSeconds?: number;
  createdById?: string | null;
}

export interface CreatedServiceAccount {
  metadata: ServiceAccountMetadata;
  /** Present only when a local credential was issued. Available once. */
  credential?: string;
}

export interface ServiceAccountServiceOptions {
  store: ServiceAccountStore;
  policy: ApiKeyPolicy;
  events?: SecurityEventEmitter;
  allowedScopes?: readonly string[];
  now?: () => Date;
}

export class ServiceAccountService {
  private readonly now: () => Date;

  constructor(private readonly options: ServiceAccountServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateServiceAccountInput): Promise<CreatedServiceAccount> {
    const scopes = assertValidScopes(input.scopes, this.options.allowedScopes);

    if (input.oidcClientId && input.issueCredential) {
      // Two credentials for one identity means two things to rotate and two ways in,
      // and nobody keeps both inventories.
      throw ApiError.validation(
        [
          {
            path: 'issueCredential',
            message: 'An OIDC-backed account must not also hold a local credential.',
          },
        ],
        'Choose one credential type.',
      );
    }

    if (await this.options.store.findByName(input.organizationId, input.name)) {
      throw ApiError.conflict(`A service account named "${input.name}" already exists.`);
    }

    const credential =
      input.issueCredential && !input.oidcClientId ? generateServiceCredential() : null;

    const expiresAt = input.lifetimeSeconds
      ? new Date(this.now().getTime() + input.lifetimeSeconds * 1000)
      : null;

    if (expiresAt && input.lifetimeSeconds! > this.options.policy.maxLifetimeSeconds) {
      throw ApiError.validation(
        [
          {
            path: 'lifetimeSeconds',
            message: `At most ${this.options.policy.maxLifetimeSeconds} seconds is permitted by policy.`,
          },
        ],
        'The requested lifetime exceeds the policy maximum.',
      );
    }

    const record = await this.options.store.create({
      organizationId: input.organizationId,
      name: input.name,
      description: input.description ?? null,
      status: 'active',
      roles: input.roles ?? [],
      scopes,
      oidcClientId: input.oidcClientId ?? null,
      credentialHash: credential?.hash ?? null,
      credentialPrefix: credential?.prefix ?? null,
      credentialExpiresAt: expiresAt,
      credentialRotatedAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
      expiresAt,
      createdById: input.createdById ?? null,
    });

    await this.options.events?.emit({
      type: 'service_account.created',
      result: 'success',
      organizationId: input.organizationId,
      actorId: input.createdById ?? null,
      actorType: 'user',
      context: {
        serviceAccountId: record.id,
        name: record.name,
        scopes: record.scopes,
        roles: record.roles,
        credentialType: record.oidcClientId ? 'oidc_client_credentials' : 'local',
        // The prefix, never the credential.
        credentialPrefix: record.credentialPrefix,
      },
    });

    return {
      metadata: toMetadata(record),
      ...(credential ? { credential: credential.credential } : {}),
    };
  }

  list(organizationId: string | null): Promise<ServiceAccountMetadata[]> {
    return this.options.store.list(organizationId).then((records) => records.map(toMetadata));
  }

  async find(id: string): Promise<ServiceAccountMetadata> {
    const record = await this.options.store.findById(id);
    if (!record || record.deletedAt) throw ApiError.notFound();
    return toMetadata(record);
  }

  /**
   * Disables an account.
   *
   * Disable rather than delete. An account that acted on data has to remain
   * resolvable, or every audit record naming it becomes an orphaned id.
   */
  async disable(
    id: string,
    reason: string,
    actorId: string | null = null,
  ): Promise<ServiceAccountMetadata> {
    const record = await this.options.store.findById(id);
    if (!record || record.deletedAt) throw ApiError.notFound();
    if (record.status === 'disabled') return toMetadata(record);

    const disabled = await this.options.store.update(id, { status: 'disabled' });

    await this.options.events?.emit({
      type: 'service_account.disabled',
      result: 'success',
      reason,
      organizationId: record.organizationId,
      actorId,
      actorType: 'user',
      context: { serviceAccountId: id, name: record.name },
    });

    return toMetadata(disabled);
  }

  /**
   * Rotates a local credential.
   *
   * No grace period, unlike an API key. A service account is a single integration
   * under the operator's control, so the new credential can be deployed
   * deliberately — and an overlap on a long-lived machine credential is a second
   * valid secret for as long as the window lasts.
   */
  async rotateCredential(
    id: string,
    actorId: string | null = null,
  ): Promise<{ credential: string; metadata: ServiceAccountMetadata }> {
    const record = await this.options.store.findById(id);
    if (!record || record.deletedAt) throw ApiError.notFound();

    if (record.oidcClientId) {
      throw ApiError.conflict(
        'This account authenticates through the identity provider. Rotate the client secret there.',
        { reason: 'oidc_backed_account' },
      );
    }

    const generated = generateServiceCredential();
    const updated = await this.options.store.update(id, {
      credentialHash: generated.hash,
      credentialPrefix: generated.prefix,
      credentialRotatedAt: this.now(),
    });

    await this.options.events?.emit({
      type: 'service_account.created',
      result: 'success',
      reason: 'credential_rotated',
      organizationId: record.organizationId,
      actorId,
      actorType: 'user',
      context: {
        serviceAccountId: id,
        name: record.name,
        credentialPrefix: generated.prefix,
        previousCredentialPrefix: record.credentialPrefix,
      },
    });

    return { credential: generated.credential, metadata: toMetadata(updated) };
  }

  // --- authentication -------------------------------------------------------

  /** Verifies a local credential and returns the actor it authenticates. */
  async verifyCredential(input: {
    credential: string;
    ipAddress: string | null;
    requestId?: string | null;
    resolveAccess: (
      organizationId: string | null,
      roles: string[],
    ) => Promise<{ permissions: string[] } | null>;
  }): Promise<{ record: ServiceAccountRecord; actor: ActorContext }> {
    if (!input.credential.startsWith(`${CREDENTIAL_PREFIX}_`)) {
      await this.failed('malformed_credential', null, input);
      throw invalidServiceCredential();
    }

    const record = await this.options.store.findByCredentialHash(hashCredential(input.credential));

    if (!record || record.deletedAt || !record.credentialHash) {
      await this.failed('unknown_credential', null, input);
      throw invalidServiceCredential();
    }

    if (!verifyCredential(input.credential, record.credentialHash)) {
      await this.failed('hash_mismatch', record.credentialPrefix, input);
      throw invalidServiceCredential();
    }

    return this.completeAuthentication(record, input);
  }

  /**
   * Resolves an actor for a subject the identity provider already authenticated by
   * the client-credentials grant.
   *
   * The token was verified by `@trustos/identity`; this maps the provider's client id
   * onto the local record that says what the account may do. The framework holds no
   * secret in this mode, which is why it is the production recommendation.
   */
  async resolveOidcClient(input: {
    clientId: string;
    ipAddress: string | null;
    requestId?: string | null;
    resolveAccess: (
      organizationId: string | null,
      roles: string[],
    ) => Promise<{ permissions: string[] } | null>;
  }): Promise<{ record: ServiceAccountRecord; actor: ActorContext }> {
    const record = await this.options.store.findByOidcClientId(input.clientId);

    if (!record || record.deletedAt) {
      await this.failed('unknown_oidc_client', input.clientId, input);
      throw invalidServiceCredential();
    }

    return this.completeAuthentication(record, input);
  }

  /** Whether an authenticated service account's scopes cover a requirement. */
  hasScopes(record: ServiceAccountRecord, required: string[]): boolean {
    return scopesSatisfyAll(record.scopes, required);
  }

  // --- internals ------------------------------------------------------------

  private async completeAuthentication(
    record: ServiceAccountRecord,
    input: {
      ipAddress: string | null;
      requestId?: string | null;
      resolveAccess: (
        organizationId: string | null,
        roles: string[],
      ) => Promise<{ permissions: string[] } | null>;
    },
  ): Promise<{ record: ServiceAccountRecord; actor: ActorContext }> {
    const now = this.now();

    if (record.status !== 'active') {
      await this.failed('account_not_active', record.credentialPrefix, input, {
        serviceAccountId: record.id,
        status: record.status,
      });
      throw invalidServiceCredential();
    }

    if (record.expiresAt && record.expiresAt.getTime() <= now.getTime()) {
      await this.failed('account_expired', record.credentialPrefix, input, {
        serviceAccountId: record.id,
      });
      throw invalidServiceCredential();
    }

    if (record.credentialExpiresAt && record.credentialExpiresAt.getTime() <= now.getTime()) {
      await this.failed('credential_expired', record.credentialPrefix, input, {
        serviceAccountId: record.id,
      });
      throw invalidServiceCredential();
    }

    const access = await input.resolveAccess(record.organizationId, record.roles);
    if (!access) {
      await this.failed('organization_unavailable', record.credentialPrefix, input, {
        serviceAccountId: record.id,
      });
      throw invalidServiceCredential();
    }

    await this.options.store.recordUse(record.id, now, input.ipAddress);

    await this.options.events?.emit({
      type: 'service_account.used',
      result: 'success',
      organizationId: record.organizationId,
      actorId: record.id,
      actorType: 'service_account',
      ipAddress: input.ipAddress,
      requestId: input.requestId ?? null,
      context: { serviceAccountId: record.id, name: record.name, scopes: record.scopes },
    });

    return {
      record,
      actor: {
        actorType: 'service_account',
        // The account's own id. An audit record for this request must name the
        // machine, not whoever created it.
        userId: record.id,
        email: '',
        organizationId: record.organizationId,
        roles: record.roles,
        permissions: access.permissions,
        // Never. Platform-wide power belongs to somebody who can be asked why they
        // used it.
        isSuperAdmin: false,
        tokenId: record.credentialPrefix ?? record.oidcClientId ?? record.id,
        scopes: record.scopes,
        provider: record.oidcClientId ? 'oidc-client-credentials' : 'service-account',
      },
    };
  }

  private async failed(
    reason: string,
    prefix: string | null,
    input: { ipAddress: string | null; requestId?: string | null },
    context: Record<string, unknown> = {},
  ): Promise<void> {
    await this.options.events?.emit({
      type: 'api_key.auth_failed',
      result: 'failure',
      reason,
      actorType: 'service_account',
      ipAddress: input.ipAddress,
      requestId: input.requestId ?? null,
      context: { credentialPrefix: prefix, ...context },
    });
  }
}

/** One error for every service-credential failure, for the usual reason. */
export function invalidServiceCredential(): ApiError {
  return ApiError.unauthorized('The service credential is not valid.', {
    reason: 'invalid_service_credential',
  });
}
