import { ApiError } from '@trustos/errors';
import {
  correlationHash,
  type MfaPolicy,
  type PasswordPolicy,
  type TokenPolicy,
} from '@trustos/security-policy';
import type { SecurityEventEmitter } from '@trustos/security-events';
import {
  deriveAuthentication,
  type AuthenticationRequestMeta,
  type AuthenticationResult,
  type IdentityHealth,
  type IdentityProfile,
  type IdentityProvider,
  type LogoutRequest,
  type PasswordCredentials,
  type RoleMapping,
  type VerifiedIdentity,
} from '../provider';
import { INVALID_CREDENTIALS_MESSAGE, LockoutTracker, lockedOutError } from './lockout';
import type { CompromisedPasswordChecker, PasswordHasher } from './password';

/**
 * The local identity provider.
 *
 * Phase 1's email-and-password authentication, kept working and hardened, behind
 * the same interface as OIDC. It exists for development, for tests and for
 * lightweight deployments — and `productionPolicyProblems` refuses it in
 * production unless a deployment says so explicitly, because an internal tool with
 * six users does not need Keycloak and should not be forced to run it.
 *
 * Written against ports rather than against `@trustos/auth`, so this package does
 * not drag a Prisma client into a worker that only validates tokens. The
 * application supplies the four pieces below; `apps/security-admin-example` shows
 * the wiring, and `TokenService` and `AuthUserStore` from `@trustos/auth` satisfy
 * the two structural ports — asserted by a test in this package.
 *
 * The login sequence, and why it is in this order:
 *
 *   1. **Lockout check.** Before hashing, so a locked account costs nothing and
 *      the response is identical whether or not the password was right.
 *   2. **Look up the user.** A miss still hashes, against a dummy, so a missing
 *      account and a wrong password take the same time.
 *   3. **Verify.** Failure records a failure and returns the *same* error as a
 *      missing account.
 *   4. **Rehash if needed.** A bcrypt hash from an earlier phase is upgraded here.
 *   5. **Clear the failure count**, so this afternoon's typo is not compounded by
 *      this morning's.
 *
 * Every branch emits a security event. A failed login is the single most useful
 * security record there is, and it has no audit record because nothing changed.
 */

/** What the provider needs to look a user up. `AuthUserStore` satisfies it. */
export interface LocalUserRecord {
  id: string;
  email: string;
  /**
   * Null for an account that has no local password — one provisioned through an
   * external identity provider. Such an account cannot authenticate here, and is
   * refused on exactly the path a wrong password takes.
   */
  passwordHash: string | null;
  displayName: string | null;
  isActive: boolean;
  isSuperAdmin: boolean;
  tokenVersion: number;
  deletedAt: Date | null;
  lastLoginAt: Date | null;
}

export interface LocalUserPort {
  findByEmail(email: string): Promise<LocalUserRecord | null>;
  findById(userId: string): Promise<LocalUserRecord | null>;
  recordLogin(userId: string, at: Date): Promise<void>;
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
}

/** What the provider needs to mint and read tokens. `TokenService` satisfies it. */
export interface LocalTokenPort {
  issueAccessToken(input: {
    userId: string;
    email: string;
    organizationId: string | null;
    roles: string[];
    permissions: string[];
    isSuperAdmin: boolean;
    tokenVersion: number;
  }): { token: string; jti: string; expiresAt: Date };

  issueRefreshToken(input: {
    userId: string;
    familyId: string;
    organizationId: string | null;
    tokenVersion: number;
  }): { token: string; jti: string; expiresAt: Date };

  verifyAccessToken(token: string): {
    sub: string;
    email: string;
    org: string | null;
    roles?: string[];
    perms?: string[];
    sa?: boolean;
    tv: number;
    jti: string;
    iat?: number;
    exp?: number;
    iss?: string;
    aud?: string | string[];
  };
}

/** Roles a locally authenticated user holds, resolved server-side. */
export interface LocalAccessResolver {
  resolve(
    userId: string,
    organizationId: string | null,
  ): Promise<{ roles: string[]; permissions: string[] } | null>;
}

export interface LocalIdentityProviderOptions {
  users: LocalUserPort;
  tokens: LocalTokenPort;
  hasher: PasswordHasher;
  lockout: LockoutTracker;
  access?: LocalAccessResolver;
  compromisedPasswords?: CompromisedPasswordChecker | null;
  events?: SecurityEventEmitter;
  tokenPolicy: TokenPolicy;
  passwordPolicy: PasswordPolicy;
  mfaPolicy: MfaPolicy;
  /** Salt for correlation hashes in events and lockout keys. Never logged. */
  correlationSalt: string;
  now?: () => Date;
}

export class LocalIdentityProvider implements IdentityProvider {
  readonly id = 'local';
  readonly kind = 'local' as const;
  readonly supportsPasswordAuthentication = true;
  /** The local provider owns its own session table, so revocation is real. */
  readonly supportsCentralSessionRevocation = true;

  private readonly now: () => Date;

  constructor(private readonly options: LocalIdentityProviderOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async authenticate(
    credentials: PasswordCredentials,
    meta: AuthenticationRequestMeta,
  ): Promise<AuthenticationResult> {
    const email = credentials.email.trim().toLowerCase();
    // Hashed, so neither the lockout store nor a security event holds a list of
    // email addresses that were tried.
    const key = correlationHash(email, this.options.correlationSalt);

    const lock = await this.options.lockout.check(key);
    if (lock.locked) {
      await this.emit('auth.failed', 'blocked', 'account_locked', meta, { identifier: key });
      throw lockedOutError(lock);
    }

    const user = await this.options.users.findByEmail(email);

    /*
     * An account with no local password is refused here rather than further down.
     *
     * It is an account provisioned through an external identity provider: there is
     * nothing to compare against, and reaching the hasher with a null would either
     * throw or — worse, depending on the implementation — compare against something
     * that is not a hash. It takes the same path as an unknown or inactive account,
     * so it costs the same time and returns the same message. Which of the three it
     * was is recorded in the security event and never in the response.
     */
    if (!user || !user.isActive || user.deletedAt !== null || user.passwordHash === null) {
      // Same time, same error, same message as a wrong password.
      await this.options.hasher.verifyAgainstDummy(credentials.password);
      await this.options.lockout.recordFailure(key);
      await this.emit('auth.failed', 'failure', 'invalid_credentials', meta, {
        identifier: key,
        // Distinguished in the event, never in the response.
        detail: !user
          ? 'unknown_identifier'
          : user.passwordHash === null
            ? 'no_local_password'
            : 'account_inactive',
      });
      throw invalidCredentials();
    }

    const valid = await this.options.hasher.verify(credentials.password, user.passwordHash);

    if (!valid) {
      const decision = await this.options.lockout.recordFailure(key);
      await this.emit('auth.failed', 'failure', 'invalid_credentials', meta, {
        identifier: key,
        remainingAttempts: decision.remaining,
      });

      if (decision.locked) {
        await this.emit('auth.account_locked', 'blocked', 'too_many_failures', meta, {
          identifier: key,
          lockedUntil: decision.lockedUntil?.toISOString() ?? null,
        });
      }

      throw invalidCredentials();
    }

    // Transparent upgrade. A bcrypt hash from phase 1 becomes a scrypt hash on
    // the first successful login, with no migration and no password reset.
    if (this.options.hasher.needsRehash(user.passwordHash)) {
      const rehashed = await this.options.hasher.hash(credentials.password);
      await this.options.users.updatePasswordHash(user.id, rehashed);
      await this.emit('auth.password_changed', 'success', 'rehashed', meta, {
        actorId: user.id,
        hasher: this.options.hasher.id,
      });
    }

    await this.options.lockout.recordSuccess(key);
    const at = this.now();
    await this.options.users.recordLogin(user.id, at);

    const identity = this.toIdentity(user, at, `local_${at.getTime()}_${user.id}`);
    const access = (await this.options.access?.resolve(user.id, null)) ?? {
      roles: [],
      permissions: [],
    };

    const accessToken = this.options.tokens.issueAccessToken({
      userId: user.id,
      email: user.email,
      organizationId: null,
      roles: access.roles,
      permissions: access.permissions,
      isSuperAdmin: user.isSuperAdmin,
      tokenVersion: user.tokenVersion,
    });

    const refreshToken = this.options.tokens.issueRefreshToken({
      userId: user.id,
      familyId: accessToken.jti,
      organizationId: null,
      tokenVersion: user.tokenVersion,
    });

    await this.emit('auth.succeeded', 'success', null, meta, {
      actorId: user.id,
      hasher: this.options.hasher.id,
    });

    return {
      identity: { ...identity, tokenId: accessToken.jti },
      tokens: {
        accessToken: accessToken.token,
        refreshToken: refreshToken.token,
        accessTokenExpiresAt: accessToken.expiresAt,
        refreshTokenExpiresAt: refreshToken.expiresAt,
      },
    };
  }

  async validateAccessToken(token: string): Promise<VerifiedIdentity> {
    // Delegated to `TokenService`, which pins the algorithm and checks the issuer
    // and audience. This provider does not decode the token itself: two
    // verification paths is one too many.
    const claims = this.options.tokens.verifyAccessToken(token);

    return {
      subject: claims.sub,
      email: claims.email,
      emailVerified: true,
      displayName: null,
      providerRoles: claims.roles ?? [],
      providerGroups: [],
      tokenId: claims.jti,
      issuer: claims.iss ?? this.options.tokenPolicy.issuer,
      audiences: Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [],
      issuedAt: claims.iat ? new Date(claims.iat * 1000) : null,
      expiresAt: claims.exp ? new Date(claims.exp * 1000) : null,
      // The local provider has no second factor. `low`, stated rather than left
      // undefined, so a route requiring MFA refuses a local session instead of
      // accepting one whose assurance was never established.
      authentication: deriveAuthentication({
        acr: null,
        amr: ['pwd'],
        authenticatedAt: claims.iat ? new Date(claims.iat * 1000) : null,
        multiFactorAcrValues: this.options.mfaPolicy.multiFactorAcrValues,
        multiFactorAmrValues: this.options.mfaPolicy.multiFactorAmrValues,
      }),
      active: true,
      claims: Object.freeze({ ...claims }),
      provider: this.id,
      providerKind: this.kind,
    };
  }

  async getProfile(subject: string): Promise<IdentityProfile> {
    const user = await this.options.users.findById(subject);
    if (!user) throw ApiError.notFound();

    return {
      subject: user.id,
      email: user.email,
      displayName: user.displayName,
      active: user.isActive && user.deletedAt === null,
      providerRoles: [],
      providerGroups: [],
      lastAuthenticatedAt: user.lastLoginAt,
    };
  }

  /**
   * Local logout.
   *
   * Session and refresh-token revocation belong to `@trustos/session-security`,
   * which owns the records. This provider does not duplicate them — it would be a
   * second place a session could be considered ended, and the two could disagree.
   */
  async logout(request: LogoutRequest): Promise<void> {
    void request;
  }

  async revokeSessions(subject: string): Promise<void> {
    // Same reasoning: the session registry revokes. Kept as a satisfied part of
    // the interface so an application can call it uniformly and be told, in the
    // provider's own documentation, where the work happens.
    void subject;
  }

  /**
   * The local provider has no external roles to map.
   *
   * Roles come from TrustOS's own membership tables, resolved by
   * `LocalAccessResolver` at token-issue time. Returning an empty mapping is the
   * honest answer, and it keeps the interface uniform.
   */
  mapRoles(identity: VerifiedIdentity): RoleMapping {
    return {
      roles: identity.providerRoles,
      isSuperAdmin: identity.claims.sa === true,
      organizationId: typeof identity.claims.org === 'string' ? identity.claims.org : null,
      unmapped: [],
    };
  }

  async health(): Promise<IdentityHealth> {
    return {
      ok: true,
      detail: `local provider, ${this.options.hasher.id} password hashing`,
      metadata: {
        passwordHasher: this.options.hasher.id,
        compromisedPasswordChecker: this.options.compromisedPasswords?.id ?? 'none',
        issuer: this.options.tokenPolicy.issuer,
        audience: this.options.tokenPolicy.audience,
      },
    };
  }

  // --- internals ------------------------------------------------------------

  private toIdentity(user: LocalUserRecord, at: Date, tokenId: string): VerifiedIdentity {
    return {
      subject: user.id,
      email: user.email,
      emailVerified: true,
      displayName: user.displayName,
      providerRoles: [],
      providerGroups: [],
      tokenId,
      issuer: this.options.tokenPolicy.issuer,
      audiences: [this.options.tokenPolicy.audience],
      issuedAt: at,
      expiresAt: new Date(at.getTime() + this.options.tokenPolicy.accessTokenSeconds * 1000),
      authentication: deriveAuthentication({
        acr: null,
        amr: ['pwd'],
        authenticatedAt: at,
        multiFactorAcrValues: this.options.mfaPolicy.multiFactorAcrValues,
        multiFactorAmrValues: this.options.mfaPolicy.multiFactorAmrValues,
      }),
      active: true,
      claims: Object.freeze({ sub: user.id, email: user.email, sa: user.isSuperAdmin }),
      provider: this.id,
      providerKind: this.kind,
    };
  }

  private async emit(
    type: Parameters<SecurityEventEmitter['emit']>[0]['type'],
    result: 'success' | 'failure' | 'blocked',
    reason: string | null,
    meta: AuthenticationRequestMeta,
    context: Record<string, unknown> = {},
  ): Promise<void> {
    const { actorId, ...rest } = context as { actorId?: string };

    await this.options.events?.emit({
      type,
      result,
      reason,
      provider: this.id,
      actorType: 'user',
      actorId: actorId ?? null,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      context: rest,
    });
  }
}

/**
 * The one error every failed local login produces.
 *
 * Same code, same message, whether the account does not exist, is inactive, is
 * soft-deleted, or the password was wrong. Anything more specific is an
 * enumeration oracle, and the distinction is recorded in the security event where
 * it is useful and not visible.
 */
export function invalidCredentials(): ApiError {
  return ApiError.unauthorized(INVALID_CREDENTIALS_MESSAGE, { reason: 'invalid_credentials' });
}
