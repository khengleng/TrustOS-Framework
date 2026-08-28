import { randomUUID } from 'node:crypto';
import type {
  RefreshTokenRecord,
  SessionRecord,
  SessionRevocationReason,
  SessionStore,
} from './sessions';

/**
 * In-memory session store.
 *
 * For tests and for a single-process development server. Process-local, so it is not
 * a deployment option: two instances would each have their own sessions, and a
 * revocation on one would not reach the other — which is exactly the property session
 * revocation must not have.
 *
 * The Prisma store is the real one. This exists because the session rules — rotation,
 * reuse detection, the four limits — are worth testing exhaustively, and doing that
 * against a database means fixtures and flake.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();

  async createSession(record: Omit<SessionRecord, 'id'>): Promise<SessionRecord> {
    const session: SessionRecord = { ...record, id: `sess_${randomUUID()}` };
    this.sessions.set(session.id, session);
    return session;
  }

  async findSession(id: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(id);
    return session ? { ...session } : null;
  }

  async findSessionByFamily(familyId: string): Promise<SessionRecord | null> {
    for (const session of this.sessions.values()) {
      if (session.familyId === familyId) return { ...session };
    }
    return null;
  }

  async listSessions(
    userId: string,
    options: { includeRevoked?: boolean } = {},
  ): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .filter((session) => options.includeRevoked || session.revokedAt === null)
      .map((session) => ({ ...session }))
      .sort((left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime());
  }

  async touchSession(id: string, at: Date): Promise<void> {
    const session = this.sessions.get(id);
    if (session) session.lastActivityAt = at;
  }

  async revokeSession(id: string, at: Date, reason: SessionRevocationReason): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.revokedAt) return;
    session.revokedAt = at;
    session.revokedReason = reason;
  }

  async revokeAllSessions(
    userId: string,
    at: Date,
    reason: SessionRevocationReason,
  ): Promise<number> {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId !== userId || session.revokedAt) continue;
      session.revokedAt = at;
      session.revokedReason = reason;
      count += 1;
    }
    return count;
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    this.refreshTokens.set(record.tokenHash, { ...record });
  }

  async findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const record = this.refreshTokens.get(tokenHash);
    return record ? { ...record } : null;
  }

  async markRefreshTokenUsed(tokenHash: string, at: Date, replacedByHash: string): Promise<void> {
    const record = this.refreshTokens.get(tokenHash);
    if (!record) return;
    record.usedAt = at;
    record.replacedByHash = replacedByHash;
  }

  async revokeRefreshFamily(
    familyId: string,
    at: Date,
    reason: SessionRevocationReason,
  ): Promise<number> {
    let count = 0;
    for (const record of this.refreshTokens.values()) {
      if (record.familyId !== familyId || record.revokedAt) continue;
      record.revokedAt = at;
      record.revokedReason = reason;
      count += 1;
    }
    return count;
  }

  /** Diagnostic, for tests. */
  snapshot(): { sessions: SessionRecord[]; refreshTokens: RefreshTokenRecord[] } {
    return {
      sessions: [...this.sessions.values()].map((session) => ({ ...session })),
      refreshTokens: [...this.refreshTokens.values()].map((record) => ({ ...record })),
    };
  }
}
