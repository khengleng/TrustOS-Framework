import type { PrismaService } from '@trustsystem/database';
import type {
  RefreshTokenRecord,
  SessionRecord,
  SessionRevocationReason,
  SessionStore,
} from '@trustsystem/session-security';

/**
 * Prisma-backed session store.
 *
 * Sessions live in `UserSession`; the refresh-token hashes live in the framework's
 * existing `RefreshToken` table, which phase 1 already rotates. Two tables rather
 * than one because they answer different questions: a session is what a person
 * recognises and an administrator revokes, and a refresh token is a single-use
 * credential in a rotation family.
 *
 * Not tenant-scoped through `@trustsystem/tenancy`: a session lookup happens *before* an
 * actor exists, so there is no tenant context to scope to. Every method that could
 * cross a boundary takes a `userId` and filters on it.
 */
export class PrismaSessionStore implements SessionStore {
  constructor(private readonly prisma: PrismaService) {}

  async createSession(record: Omit<SessionRecord, 'id'>): Promise<SessionRecord> {
    const created = await this.prisma.userSession.create({ data: { ...record } });
    return toSession(created);
  }

  async findSession(id: string): Promise<SessionRecord | null> {
    const found = await this.prisma.userSession.findUnique({ where: { id } });
    return found ? toSession(found) : null;
  }

  async findSessionByFamily(familyId: string): Promise<SessionRecord | null> {
    const found = await this.prisma.userSession.findUnique({ where: { familyId } });
    return found ? toSession(found) : null;
  }

  async listSessions(
    userId: string,
    options: { includeRevoked?: boolean } = {},
  ): Promise<SessionRecord[]> {
    const rows = await this.prisma.userSession.findMany({
      where: { userId, ...(options.includeRevoked ? {} : { revokedAt: null }) },
      orderBy: { lastActivityAt: 'desc' },
    });
    return rows.map(toSession);
  }

  async touchSession(id: string, at: Date): Promise<void> {
    await this.prisma.userSession.update({ where: { id }, data: { lastActivityAt: at } });
  }

  async revokeSession(id: string, at: Date, reason: SessionRevocationReason): Promise<void> {
    // Conditional on `revokedAt: null`, so a second revocation is a no-op rather
    // than overwriting the original reason and timestamp.
    await this.prisma.userSession.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at, revokedReason: reason },
    });
  }

  async revokeAllSessions(
    userId: string,
    at: Date,
    reason: SessionRevocationReason,
  ): Promise<number> {
    const result = await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: at, revokedReason: reason },
    });
    return result.count;
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    await this.prisma.refreshToken.create({
      data: {
        tokenHash: record.tokenHash,
        userId: record.userId,
        familyId: record.familyId,
        expiresAt: record.expiresAt,
      },
    });
  }

  async findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!row) return null;

    const session = await this.prisma.userSession.findUnique({
      where: { familyId: row.familyId },
    });

    return {
      tokenHash: row.tokenHash,
      sessionId: session?.id ?? '',
      familyId: row.familyId,
      userId: row.userId,
      expiresAt: row.expiresAt,
      usedAt: row.usedAt,
      revokedAt: row.revokedAt,
      revokedReason: row.revokedReason,
      replacedByHash: row.replacedByHash,
    };
  }

  async markRefreshTokenUsed(tokenHash: string, at: Date, replacedByHash: string): Promise<void> {
    // Conditional on `usedAt: null`. Two concurrent refreshes with the same token
    // then produce one winner and one reuse detection, rather than two successes.
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, usedAt: null },
      data: { usedAt: at, replacedByHash },
    });
  }

  async revokeRefreshFamily(
    familyId: string,
    at: Date,
    reason: SessionRevocationReason,
  ): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: at, revokedReason: reason },
    });
    return result.count;
  }
}

function toSession(row: {
  id: string;
  userId: string;
  familyId: string;
  clientId: string | null;
  deviceLabel: string | null;
  userAgent: string | null;
  ipHash: string | null;
  organizationId: string | null;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  authenticationLevel: string;
  mfaCompleted: boolean;
  provider: string;
}): SessionRecord {
  return {
    ...row,
    // Narrowed rather than cast: a value outside the union means somebody wrote to
    // the table by hand.
    authenticationLevel:
      row.authenticationLevel === 'high' || row.authenticationLevel === 'medium'
        ? row.authenticationLevel
        : 'low',
  };
}
