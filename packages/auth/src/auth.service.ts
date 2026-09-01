import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@trustsystem/config';
import { ApiError } from '@trustsystem/errors';
import type {
  AuthResponse,
  OrganizationSummary,
  TokenPair,
  UserSummary,
} from '@trustsystem/shared-types';
import { emailSchema, parseOrThrow, passwordSchema } from '@trustsystem/validation';
import { NOOP_EVENT_SINK, type AuthEvent, type AuthEventSink } from './events';
import { hashPassword, needsRehash, verifyPassword, verifyPasswordAgainstDummy } from './password';
import { TokenService, hashRefreshToken } from './tokens';
import {
  EMPTY_REQUEST_META,
  type AuthRequestMeta,
  type AuthUserRecord,
  type AuthUserStore,
  type MembershipResolver,
  type MembershipSummary,
  type RefreshTokenStore,
} from './ports';

export interface AuthServiceDependencies {
  config: AppConfig;
  users: AuthUserStore;
  refreshTokens: RefreshTokenStore;
  memberships: MembershipResolver;
  events?: AuthEventSink;
  /** Injectable clock so token lifetime tests do not sleep. */
  now?: () => Date;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName?: string | null;
}

export interface LoginInput {
  email: string;
  password: string;
  /** Optional: log straight into a specific organization. */
  organizationId?: string;
}

/**
 * Email/password authentication with rotating refresh tokens.
 *
 * Scope is deliberately narrow: no social login, no passkeys, no external IdP.
 * Those belong behind the same interface later; adding them now would mean
 * designing an abstraction against a single implementation.
 */
export class AuthService {
  private readonly tokens: TokenService;
  private readonly events: AuthEventSink;
  private readonly now: () => Date;

  constructor(private readonly deps: AuthServiceDependencies) {
    this.tokens = new TokenService(deps.config);
    this.events = deps.events ?? NOOP_EVENT_SINK;
    this.now = deps.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  async register(
    input: RegisterInput,
    meta: AuthRequestMeta = EMPTY_REQUEST_META,
  ): Promise<AuthResponse> {
    const email = parseOrThrow(emailSchema, input.email);
    const password = parseOrThrow(passwordSchema, input.password);

    const existing = await this.deps.users.findByEmail(email);
    if (existing) {
      // Registration cannot avoid disclosing that an address is taken — the
      // account cannot be created twice. Login and password reset must not
      // disclose it, and they do not.
      throw ApiError.conflict('An account with that email address already exists.');
    }

    const passwordHash = await hashPassword(password, this.deps.config.auth.passwordHashRounds);
    const user = await this.deps.users.create({
      email,
      passwordHash,
      displayName: input.displayName?.trim() || null,
    });

    await this.emit({
      type: 'auth.registered',
      actorId: user.id,
      organizationId: null,
      entityType: 'User',
      entityId: user.id,
      metadata: { email: user.email },
      request: meta,
    });

    return this.buildAuthResponse(user, null, meta);
  }

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  async login(
    input: LoginInput,
    meta: AuthRequestMeta = EMPTY_REQUEST_META,
  ): Promise<AuthResponse> {
    const email = emailSchema.safeParse(input.email);
    const candidate = email.success ? email.data : String(input.email ?? '').toLowerCase();

    const user = await this.deps.users.findByEmail(candidate);

    if (!user || !this.isUsable(user)) {
      // Constant-ish work regardless of whether the account exists.
      await verifyPasswordAgainstDummy(input.password ?? '');
      await this.emit({
        type: 'auth.login_failed',
        actorId: user?.id ?? null,
        organizationId: null,
        entityType: 'User',
        entityId: user?.id ?? null,
        metadata: { email: candidate, reason: user ? 'account_unusable' : 'unknown_email' },
        request: meta,
      });
      throw ApiError.unauthorized('Email address or password is incorrect.');
    }

    /*
     * An account with no local password cannot sign in with one.
     *
     * That is an account provisioned through an identity provider: it authenticates
     * there, not here. Refused with the same message and the same audit reason a wrong
     * password gets, because "this address exists but signs in elsewhere" is exactly the
     * kind of thing an enumeration attack is looking for.
     */
    const passwordMatches =
      user.passwordHash !== null && (await verifyPassword(input.password ?? '', user.passwordHash));
    if (!passwordMatches) {
      await this.emit({
        type: 'auth.login_failed',
        actorId: user.id,
        organizationId: null,
        entityType: 'User',
        entityId: user.id,
        metadata: { email: candidate, reason: 'bad_password' },
        request: meta,
      });
      throw ApiError.unauthorized('Email address or password is incorrect.');
    }

    // Upgrade the stored hash if the cost factor has been raised since the
    // account was created. The user notices nothing.
    if (
      user.passwordHash !== null &&
      needsRehash(user.passwordHash, this.deps.config.auth.passwordHashRounds)
    ) {
      const upgraded = await hashPassword(input.password, this.deps.config.auth.passwordHashRounds);
      await this.deps.users.updatePasswordHash(user.id, upgraded);
      await this.emit({
        type: 'auth.password_rehashed',
        actorId: user.id,
        organizationId: null,
        entityType: 'User',
        entityId: user.id,
        request: meta,
      });
    }

    await this.deps.users.recordLogin(user.id, this.now());

    const membership = await this.selectMembership(user.id, input.organizationId);

    await this.emit({
      type: 'auth.login',
      actorId: user.id,
      organizationId: membership?.organizationId ?? null,
      entityType: 'User',
      entityId: user.id,
      request: meta,
    });

    return this.buildAuthResponse(user, membership, meta);
  }

  /**
   * Issues a new token pair scoped to `organizationId`.
   *
   * Membership is verified here, at issue time, which is what lets every later
   * request trust the `org` claim without a database lookup.
   */
  async selectOrganization(
    userId: string,
    organizationId: string,
    meta: AuthRequestMeta = EMPTY_REQUEST_META,
  ): Promise<AuthResponse> {
    const user = await this.requireUsableUser(userId);
    const membership = await this.deps.memberships.resolveAccess(userId, organizationId);
    if (!membership) {
      throw ApiError.forbidden('You are not a member of that organization.', {
        reason: 'not_a_member',
        actorId: userId,
        requestedOrganizationId: organizationId,
      });
    }

    await this.emit({
      type: 'auth.organization_selected',
      actorId: user.id,
      organizationId,
      entityType: 'Organization',
      entityId: organizationId,
      request: meta,
    });

    return this.buildAuthResponse(user, membership, meta);
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  /**
   * Rotates a refresh token.
   *
   * Every refresh mints a new token and revokes the presented one. If a token
   * that has already been rotated is presented again, the only two
   * explanations are a stolen token or a badly retried request — and since the
   * two are indistinguishable, the entire family is revoked. The legitimate
   * user is logged out; the thief gains nothing.
   */
  async refresh(
    refreshToken: string,
    meta: AuthRequestMeta = EMPTY_REQUEST_META,
  ): Promise<AuthResponse> {
    const claims = this.tokens.verifyRefreshToken(refreshToken);
    const tokenHash = hashRefreshToken(refreshToken);
    const stored = await this.deps.refreshTokens.findByHash(tokenHash);

    if (!stored) {
      // Signature checks out but the token is unknown: it was pruned, or the
      // store was reset. Revoke the family and make the client re-authenticate.
      await this.deps.refreshTokens.revokeFamily(claims.fam, 'reuse_detected');
      await this.emit({
        type: 'auth.token_reuse_detected',
        actorId: claims.sub,
        // Taken from the token so the event lands in the audit trail of the
        // organization whose administrators need to see it. The claim is not
        // trusted for access — nothing is granted here — only for routing.
        organizationId: claims.org,
        entityType: 'RefreshToken',
        entityId: null,
        metadata: { familyId: claims.fam, reason: 'unknown_token' },
        request: meta,
      });
      throw ApiError.unauthorized('Session expired. Please sign in again.');
    }

    if (stored.revokedAt) {
      await this.deps.refreshTokens.revokeFamily(stored.familyId, 'reuse_detected');
      await this.emit({
        type: 'auth.token_reuse_detected',
        actorId: stored.userId,
        organizationId: claims.org,
        entityType: 'RefreshToken',
        entityId: null,
        metadata: {
          familyId: stored.familyId,
          previousRevocationReason: stored.revokedReason,
        },
        request: meta,
      });
      throw ApiError.unauthorized('Session expired. Please sign in again.');
    }

    if (stored.expiresAt.getTime() <= this.now().getTime()) {
      throw ApiError.unauthorized('Session expired. Please sign in again.');
    }

    const user = await this.requireUsableUser(stored.userId);
    if (user.tokenVersion !== claims.tv) {
      // Sessions were revoked in bulk after this token was issued.
      throw ApiError.unauthorized('Session expired. Please sign in again.');
    }

    // Re-resolve access from the database so a revoked role stops working at
    // the next refresh rather than at the next login.
    const membership = await this.selectMembership(user.id, claims.org, 'fall-back');

    const response = await this.buildAuthResponse(user, membership, meta, stored.familyId);

    await this.deps.refreshTokens.revoke(
      tokenHash,
      'rotated',
      hashRefreshToken(response.tokens.refreshToken),
    );

    await this.emit({
      type: 'auth.token_refreshed',
      actorId: user.id,
      organizationId: membership?.organizationId ?? null,
      entityType: 'RefreshToken',
      entityId: null,
      metadata: { familyId: stored.familyId },
      request: meta,
    });

    return response;
  }

  // ---------------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------------

  /**
   * Revokes the presented token's whole family.
   *
   * Idempotent and silent about failure: a client logging out with an already
   * dead token should still end up logged out, and returning an error would
   * only encourage clients to ignore it.
   */
  async logout(refreshToken: string, meta: AuthRequestMeta = EMPTY_REQUEST_META): Promise<void> {
    let userId: string | null = null;
    let familyId: string | null = null;

    try {
      const claims = this.tokens.verifyRefreshToken(refreshToken);
      userId = claims.sub;
      familyId = claims.fam;
    } catch {
      const stored = await this.deps.refreshTokens.findByHash(hashRefreshToken(refreshToken));
      if (stored) {
        userId = stored.userId;
        familyId = stored.familyId;
      }
    }

    if (familyId) await this.deps.refreshTokens.revokeFamily(familyId, 'logout');

    await this.emit({
      type: 'auth.logout',
      actorId: userId,
      organizationId: null,
      entityType: 'RefreshToken',
      entityId: null,
      metadata: familyId ? { familyId } : undefined,
      request: meta,
    });
  }

  /**
   * Revokes every session for a user.
   *
   * Bumping `tokenVersion` invalidates outstanding *access* tokens too, which
   * is the piece a refresh-token-only logout cannot do. This is the hook a
   * future "sign out everywhere" or breach response uses.
   */
  async revokeAllSessions(
    userId: string,
    reason: 'admin' | 'password_change' = 'admin',
    meta: AuthRequestMeta = EMPTY_REQUEST_META,
  ): Promise<void> {
    await this.deps.refreshTokens.revokeAllForUser(userId, reason);
    await this.deps.users.incrementTokenVersion(userId);
    await this.emit({
      type: 'auth.sessions_revoked',
      actorId: userId,
      organizationId: null,
      entityType: 'User',
      entityId: userId,
      metadata: { reason },
      request: meta,
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private isUsable(user: AuthUserRecord): boolean {
    return user.isActive && user.deletedAt === null;
  }

  private async requireUsableUser(userId: string): Promise<AuthUserRecord> {
    const user = await this.deps.users.findById(userId);
    if (!user || !this.isUsable(user)) {
      throw ApiError.unauthorized('Session expired. Please sign in again.');
    }
    return user;
  }

  /**
   * Picks the organization a token should be scoped to.
   *
   * An explicit request must be honoured or refused — never silently replaced
   * with a different organization. With no request, a single membership is
   * selected automatically (the common case) and multiple memberships leave
   * the token unscoped until the user chooses.
   */
  private async selectMembership(
    userId: string,
    requested?: string | null,
    onMissing: 'reject' | 'fall-back' = 'reject',
  ): Promise<MembershipSummary | null> {
    if (requested) {
      const membership = await this.deps.memberships.resolveAccess(userId, requested);
      if (membership) return membership;

      // On refresh, losing access to the previously selected organization is a
      // normal outcome (the user was removed). Drop them to the picker rather
      // than failing the refresh, which would look like a broken session.
      if (onMissing === 'reject') {
        throw ApiError.forbidden('You are not a member of that organization.', {
          reason: 'not_a_member',
          actorId: userId,
          requestedOrganizationId: requested,
        });
      }
      return null;
    }

    const memberships = await this.deps.memberships.listMemberships(userId);
    return memberships.length === 1 ? (memberships[0] as MembershipSummary) : null;
  }

  private async buildAuthResponse(
    user: AuthUserRecord,
    membership: MembershipSummary | null,
    meta: AuthRequestMeta,
    familyId: string = randomUUID(),
  ): Promise<AuthResponse> {
    const access = this.tokens.issueAccessToken({
      userId: user.id,
      email: user.email,
      organizationId: membership?.organizationId ?? null,
      roles: membership?.roles ?? [],
      permissions: membership?.permissions ?? [],
      isSuperAdmin: user.isSuperAdmin,
      tokenVersion: user.tokenVersion,
    });

    const refresh = this.tokens.issueRefreshToken({
      userId: user.id,
      familyId,
      organizationId: membership?.organizationId ?? null,
      tokenVersion: user.tokenVersion,
    });

    await this.deps.refreshTokens.save({
      tokenHash: hashRefreshToken(refresh.token),
      userId: user.id,
      familyId,
      expiresAt: refresh.expiresAt,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const memberships = await this.deps.memberships.listMemberships(user.id);

    const tokens: TokenPair = {
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresIn: this.tokens.accessTokenTtlSeconds,
      tokenType: 'Bearer',
    };

    return {
      user: toUserSummary(user),
      organizations: memberships.map(toOrganizationSummary),
      tokens,
    };
  }

  private async emit(event: AuthEvent): Promise<void> {
    try {
      await this.events.emit(event);
    } catch {
      // An audit sink failure must not turn a successful login into a 500.
      // The sink itself is responsible for logging why it failed.
    }
  }
}

export function toUserSummary(user: AuthUserRecord): UserSummary {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function toOrganizationSummary(membership: MembershipSummary): OrganizationSummary {
  return {
    id: membership.organizationId,
    name: membership.organizationName,
    slug: membership.organizationSlug,
    isActive: membership.organizationIsActive,
    createdAt: membership.organizationCreatedAt.toISOString(),
    updatedAt: membership.organizationUpdatedAt.toISOString(),
  };
}
