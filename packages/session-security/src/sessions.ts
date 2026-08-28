import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '@trustos/errors';
import type { SecurityEventEmitter } from '@trustos/security-events';
import type { SessionPolicy } from '@trustos/security-policy';
import type { ActorAuthenticationLevel } from '@trustos/shared-types';

/**
 * The session registry.
 *
 * A session is the thing a person recognises in a "your devices" list and the thing
 * an administrator revokes during an incident. It holds **no token** — the refresh
 * token's hash lives in its own table, and the access token is not stored at all —
 * so a leak of this table reveals who was signed in from roughly where, and grants
 * nothing.
 *
 * Four limits, each closing a different gap:
 *
 *   **Idle timeout.** A session with no activity is over, whatever its expiry. This
 *   is what makes an abandoned browser on a shared machine stop mattering.
 *
 *   **Absolute lifetime.** A ceiling regardless of activity, because a session kept
 *   alive by a polling tab would otherwise never end. There is no "unlimited"
 *   option, and production refuses a lifetime long enough to be one in practice.
 *
 *   **Concurrency.** The *oldest* session is revoked when the limit is reached, not
 *   the new one. Signing in on a new device must never be denied — that is a
 *   support call and a user who disables the feature — but an attacker accumulating
 *   sessions quietly is bounded.
 *
 *   **Rotation with reuse detection.** Below.
 */

export type SessionRevocationReason =
  | 'logout'
  | 'logout_all'
  | 'administrative'
  | 'reuse_detected'
  | 'idle_timeout'
  | 'absolute_timeout'
  | 'concurrency_limit'
  | 'password_changed'
  | 'suspicious';

export interface SessionRecord {
  id: string;
  userId: string;
  /** Rotation family, linking this session to its refresh tokens. */
  familyId: string;
  clientId: string | null;
  deviceLabel: string | null;
  userAgent: string | null;
  /** Correlation hash of the address, never the address. */
  ipHash: string | null;
  organizationId: string | null;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  authenticationLevel: ActorAuthenticationLevel;
  mfaCompleted: boolean;
  provider: string;
}

/** What a person sees in a device list. No hashes, no ids they cannot use. */
export interface SessionSummary {
  id: string;
  deviceLabel: string | null;
  clientId: string | null;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
  mfaCompleted: boolean;
  provider: string;
  /** True for the session making the request, so the UI can say "this device". */
  current: boolean;
}

export interface RefreshTokenRecord {
  tokenHash: string;
  sessionId: string;
  familyId: string;
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  replacedByHash: string | null;
}

export interface SessionStore {
  createSession(record: Omit<SessionRecord, 'id'>): Promise<SessionRecord>;
  findSession(id: string): Promise<SessionRecord | null>;
  findSessionByFamily(familyId: string): Promise<SessionRecord | null>;
  listSessions(userId: string, options?: { includeRevoked?: boolean }): Promise<SessionRecord[]>;
  touchSession(id: string, at: Date): Promise<void>;
  revokeSession(id: string, at: Date, reason: SessionRevocationReason): Promise<void>;
  revokeAllSessions(userId: string, at: Date, reason: SessionRevocationReason): Promise<number>;

  saveRefreshToken(record: RefreshTokenRecord): Promise<void>;
  findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null>;
  markRefreshTokenUsed(tokenHash: string, at: Date, replacedByHash: string): Promise<void>;
  revokeRefreshFamily(familyId: string, at: Date, reason: SessionRevocationReason): Promise<number>;
}

/**
 * Hash used to store a refresh token.
 *
 * SHA-256, not a slow KDF: the token is 200+ bits of server-generated entropy, so it
 * is not brute-forcible, and the refresh path would otherwise pay a KDF's cost on
 * every call. The same reasoning as an API key, and the opposite of a password.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionServiceOptions {
  store: SessionStore;
  policy: SessionPolicy;
  events?: SecurityEventEmitter;
  /** Salt for address correlation hashes. Never logged. */
  correlationSalt: string;
  /** Called when reuse or another strong signal is detected. */
  onSuspicious?: (input: {
    userId: string;
    sessionId: string | null;
    reason: string;
    ipHash: string | null;
  }) => Promise<void> | void;
  now?: () => Date;
}

export interface StartSessionInput {
  userId: string;
  clientId?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
  organizationId?: string | null;
  authenticationLevel?: ActorAuthenticationLevel;
  mfaCompleted?: boolean;
  provider?: string;
  /** The refresh token issued with this session. Hashed here, never stored raw. */
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export class SessionService {
  private readonly now: () => Date;

  constructor(private readonly options: SessionServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Creates a session, evicting the oldest if the concurrency limit is reached. */
  async start(input: StartSessionInput): Promise<SessionRecord> {
    const now = this.now();
    await this.enforceConcurrency(input.userId, now);

    const familyId = randomUUID();

    const session = await this.options.store.createSession({
      userId: input.userId,
      familyId,
      clientId: input.clientId ?? null,
      deviceLabel: describeDevice(input.userAgent ?? null),
      userAgent: input.userAgent ?? null,
      ipHash: this.hashAddress(input.ipAddress ?? null),
      organizationId: input.organizationId ?? null,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: new Date(now.getTime() + this.options.policy.absoluteLifetimeSeconds * 1000),
      revokedAt: null,
      revokedReason: null,
      authenticationLevel: input.authenticationLevel ?? 'low',
      mfaCompleted: input.mfaCompleted ?? false,
      provider: input.provider ?? 'local',
    });

    await this.options.store.saveRefreshToken({
      tokenHash: hashRefreshToken(input.refreshToken),
      sessionId: session.id,
      familyId,
      userId: input.userId,
      expiresAt: input.refreshTokenExpiresAt,
      usedAt: null,
      revokedAt: null,
      revokedReason: null,
      replacedByHash: null,
    });

    await this.options.events?.emit({
      type: 'session.created',
      result: 'success',
      actorId: input.userId,
      actorType: 'user',
      organizationId: input.organizationId ?? null,
      provider: session.provider,
      context: {
        sessionId: session.id,
        clientId: session.clientId,
        deviceLabel: session.deviceLabel,
        mfaCompleted: session.mfaCompleted,
      },
    });

    return session;
  }

  /**
   * Rotates a refresh token.
   *
   * The whole point is the second branch. A refresh token is single-use: on a normal
   * refresh it is marked used and replaced. If a token that has *already* been used
   * arrives, one of two things happened — the legitimate client retried after a
   * network failure, or an attacker is replaying a stolen token — and there is no way
   * to tell them apart from the request.
   *
   * So the whole family is revoked. That signs the legitimate user out and forces a
   * fresh login, which is a real cost, and it is the correct trade: the alternative
   * is that a stolen token keeps working alongside the real one indefinitely, and
   * nobody ever finds out.
   *
   * This behaviour is inherited from phase 1 and must not be weakened. It is the
   * only detection the framework has for a stolen refresh token.
   */
  async rotate(input: {
    presentedToken: string;
    newToken: string;
    newTokenExpiresAt: Date;
    ipAddress?: string | null;
  }): Promise<SessionRecord> {
    const now = this.now();
    const presentedHash = hashRefreshToken(input.presentedToken);
    const stored = await this.options.store.findRefreshToken(presentedHash);

    if (!stored) throw invalidRefreshToken();

    if (stored.revokedAt) {
      // The family was already killed — most likely by a previous reuse detection.
      await this.reportSuspicious(stored.userId, stored.sessionId, 'refresh_token_revoked', null);
      throw invalidRefreshToken();
    }

    if (stored.usedAt) {
      // Reuse. Kill the family, sign the user out everywhere in it, and record it as
      // critical: this is what a stolen refresh token looks like.
      const revoked = await this.options.store.revokeRefreshFamily(
        stored.familyId,
        now,
        'reuse_detected',
      );
      await this.options.store.revokeSession(stored.sessionId, now, 'reuse_detected');

      await this.options.events?.emit({
        type: 'session.refresh_reuse_detected',
        result: 'blocked',
        reason: 'refresh_token_reuse',
        actorId: stored.userId,
        actorType: 'user',
        context: {
          sessionId: stored.sessionId,
          familyId: stored.familyId,
          revokedTokens: revoked,
          firstUsedAt: stored.usedAt.toISOString(),
        },
      });

      await this.reportSuspicious(
        stored.userId,
        stored.sessionId,
        'refresh_token_reuse',
        this.hashAddress(input.ipAddress ?? null),
      );

      throw invalidRefreshToken();
    }

    if (stored.expiresAt.getTime() <= now.getTime()) throw invalidRefreshToken();

    const session = await this.options.store.findSession(stored.sessionId);
    if (!session) throw invalidRefreshToken();

    this.assertSessionUsable(session, now);

    const newHash = hashRefreshToken(input.newToken);
    await this.options.store.markRefreshTokenUsed(presentedHash, now, newHash);

    await this.options.store.saveRefreshToken({
      tokenHash: newHash,
      sessionId: session.id,
      familyId: stored.familyId,
      userId: stored.userId,
      expiresAt: input.newTokenExpiresAt,
      usedAt: null,
      revokedAt: null,
      revokedReason: null,
      replacedByHash: null,
    });

    await this.options.store.touchSession(session.id, now);

    await this.options.events?.emit({
      type: 'session.refresh_rotated',
      result: 'success',
      actorId: stored.userId,
      actorType: 'user',
      organizationId: session.organizationId,
      context: { sessionId: session.id, familyId: stored.familyId },
    });

    return { ...session, lastActivityAt: now };
  }

  /**
   * Records activity and enforces the timeouts.
   *
   * Called on every authenticated request. `touchSession` is a write per request,
   * which is a real cost — a deployment that cannot afford it batches the update and
   * accepts a coarser idle timeout, and that trade belongs to the deployment rather
   * than to the framework.
   */
  async touch(sessionId: string): Promise<SessionRecord> {
    const now = this.now();
    const session = await this.options.store.findSession(sessionId);
    if (!session) throw sessionEnded();

    this.assertSessionUsable(session, now);
    await this.options.store.touchSession(sessionId, now);

    return { ...session, lastActivityAt: now };
  }

  /**
   * A user's sessions.
   *
   * `organizationId` is an optional *filter*, and an administrator route must pass
   * it. Without it the method is "list any user's sessions by id", which is a
   * cross-tenant read as soon as one administrator learns another organization's
   * user id. A user listing their own devices passes nothing, because the user id
   * came from their own verified token.
   */
  async list(
    userId: string,
    currentSessionId: string | null = null,
    organizationId: string | null = null,
  ): Promise<SessionSummary[]> {
    const all = await this.options.store.listSessions(userId);
    const sessions =
      organizationId === null
        ? all
        : all.filter((session) => session.organizationId === organizationId);

    return sessions.map((session) => ({
      id: session.id,
      deviceLabel: session.deviceLabel,
      clientId: session.clientId,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      expiresAt: session.expiresAt,
      mfaCompleted: session.mfaCompleted,
      provider: session.provider,
      current: session.id === currentSessionId,
    }));
  }

  /** Ends one session. Idempotent, because it is used during an incident. */
  async revoke(
    sessionId: string,
    reason: SessionRevocationReason,
    actor: { userId: string; actorType: 'user' | 'system' } | null = null,
    organizationId: string | null = null,
  ): Promise<void> {
    const now = this.now();
    const session = await this.options.store.findSession(sessionId);
    if (!session) throw ApiError.notFound();
    if (organizationId !== null && session.organizationId !== organizationId) {
      // Not found rather than forbidden: a forbidden response would confirm that a
      // session with this id exists in some other organization.
      throw ApiError.notFound();
    }
    if (session.revokedAt) return;

    await this.options.store.revokeSession(sessionId, now, reason);
    await this.options.store.revokeRefreshFamily(session.familyId, now, reason);

    await this.options.events?.emit({
      type: 'session.revoked',
      result: 'success',
      reason,
      actorId: actor?.userId ?? session.userId,
      actorType: actor?.actorType ?? 'user',
      organizationId: session.organizationId,
      context: { sessionId, targetUserId: session.userId, deviceLabel: session.deviceLabel },
    });
  }

  /** Ends every session for a user — the "sign out everywhere" button. */
  async revokeAll(
    userId: string,
    reason: SessionRevocationReason,
    actor: { userId: string; actorType: 'user' | 'system' } | null = null,
  ): Promise<number> {
    const now = this.now();
    const sessions = await this.options.store.listSessions(userId);
    const count = await this.options.store.revokeAllSessions(userId, now, reason);

    for (const session of sessions) {
      if (session.revokedAt) continue;
      await this.options.store.revokeRefreshFamily(session.familyId, now, reason);
    }

    await this.options.events?.emit({
      type: 'session.all_revoked',
      result: 'success',
      reason,
      actorId: actor?.userId ?? userId,
      actorType: actor?.actorType ?? 'user',
      context: { targetUserId: userId, revokedSessions: count },
    });

    return count;
  }

  // --- internals ------------------------------------------------------------

  private assertSessionUsable(session: SessionRecord, now: Date): void {
    if (session.revokedAt) throw sessionEnded();

    if (session.expiresAt.getTime() <= now.getTime()) {
      void this.expire(session, 'absolute_timeout', 'session.absolute_timeout');
      throw sessionEnded();
    }

    const idleMs = now.getTime() - session.lastActivityAt.getTime();
    if (idleMs > this.options.policy.idleTimeoutSeconds * 1000) {
      void this.expire(session, 'idle_timeout', 'session.idle_timeout');
      throw sessionEnded();
    }
  }

  /**
   * Revokes an expired session in the background.
   *
   * Not awaited: the caller is being told their session ended, and making that
   * response wait on a write — or fail because of one — would turn a clean
   * "sign in again" into an error.
   */
  private async expire(
    session: SessionRecord,
    reason: SessionRevocationReason,
    eventType: 'session.idle_timeout' | 'session.absolute_timeout',
  ): Promise<void> {
    try {
      await this.options.store.revokeSession(session.id, this.now(), reason);
      await this.options.store.revokeRefreshFamily(session.familyId, this.now(), reason);
      await this.options.events?.emit({
        type: eventType,
        result: 'blocked',
        reason,
        actorId: session.userId,
        actorType: 'user',
        organizationId: session.organizationId,
        context: { sessionId: session.id },
      });
    } catch {
      // Nothing to do. The session is already unusable to the caller; the row will
      // be cleaned up by the next attempt or by a sweep.
    }
  }

  private async enforceConcurrency(userId: string, now: Date): Promise<void> {
    const active = (await this.options.store.listSessions(userId)).filter(
      (session) => !session.revokedAt && session.expiresAt.getTime() > now.getTime(),
    );

    const overBy = active.length - this.options.policy.maxConcurrentSessions + 1;
    if (overBy <= 0) return;

    // Oldest first. The new session is never the one refused.
    const evictable = [...active].sort(
      (left, right) => left.lastActivityAt.getTime() - right.lastActivityAt.getTime(),
    );

    for (const session of evictable.slice(0, overBy)) {
      await this.options.store.revokeSession(session.id, now, 'concurrency_limit');
      await this.options.store.revokeRefreshFamily(session.familyId, now, 'concurrency_limit');

      await this.options.events?.emit({
        type: 'session.concurrency_evicted',
        result: 'blocked',
        reason: 'concurrency_limit',
        actorId: userId,
        actorType: 'user',
        context: {
          sessionId: session.id,
          limit: this.options.policy.maxConcurrentSessions,
          deviceLabel: session.deviceLabel,
        },
      });
    }
  }

  private hashAddress(address: string | null): string | null {
    if (!address) return null;
    // A correlation hash, not the address. "The same source, again" is answerable
    // from it; a list of customer IP addresses is not recoverable from the table.
    return createHash('sha256')
      .update(`${this.options.correlationSalt}:${address}`)
      .digest('hex')
      .slice(0, 16);
  }

  private async reportSuspicious(
    userId: string,
    sessionId: string | null,
    reason: string,
    ipHash: string | null,
  ): Promise<void> {
    await this.options.onSuspicious?.({ userId, sessionId, reason, ipHash });
  }
}

/**
 * Describes a device from a user agent.
 *
 * A label a person recognises — "Chrome on macOS" — not a fingerprint. Deliberately
 * coarse: a precise fingerprint is a tracking identifier, and the only job here is
 * helping somebody spot the session that is not theirs.
 */
export function describeDevice(userAgent: string | null): string | null {
  if (!userAgent) return null;

  const platform = /Windows/i.test(userAgent)
    ? 'Windows'
    : /Macintosh|Mac OS X/i.test(userAgent)
      ? 'macOS'
      : /Android/i.test(userAgent)
        ? 'Android'
        : /iPhone|iPad|iOS/i.test(userAgent)
          ? 'iOS'
          : /Linux/i.test(userAgent)
            ? 'Linux'
            : null;

  const browser = /Edg\//i.test(userAgent)
    ? 'Edge'
    : /OPR\//i.test(userAgent)
      ? 'Opera'
      : /Chrome\//i.test(userAgent)
        ? 'Chrome'
        : /Safari\//i.test(userAgent)
          ? 'Safari'
          : /Firefox\//i.test(userAgent)
            ? 'Firefox'
            : /curl|wget|python|node|go-http/i.test(userAgent)
              ? 'Command line'
              : null;

  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform ?? 'Unknown device';
}

/**
 * The one error a refresh failure produces.
 *
 * Same code and message whether the token is unknown, revoked, expired, or was
 * reused. A holder of a stolen token must not learn that reuse detection just fired,
 * because knowing means knowing to stop.
 */
export function invalidRefreshToken(): ApiError {
  return ApiError.unauthorized('Please sign in again.', { reason: 'invalid_refresh_token' });
}

export function sessionEnded(): ApiError {
  return ApiError.unauthorized('Please sign in again.', { reason: 'session_ended' });
}
