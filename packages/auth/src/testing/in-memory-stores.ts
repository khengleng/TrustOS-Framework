import type {
  AuthUserRecord,
  AuthUserStore,
  CreateUserInput,
  MembershipResolver,
  MembershipSummary,
  RefreshTokenRecord,
  RefreshTokenStore,
  RevocationReason,
  SaveRefreshTokenInput,
} from '../ports';

/**
 * In-memory implementations of the auth ports.
 *
 * Shipped with the package so product tests can exercise their own auth flows
 * without a database. They implement the same contracts the Prisma stores do,
 * including the parts that are easy to get wrong (idempotent revocation,
 * soft-delete filtering).
 */

export class InMemoryUserStore implements AuthUserStore {
  private readonly users = new Map<string, AuthUserRecord>();
  private sequence = 0;

  constructor(seed: AuthUserRecord[] = []) {
    seed.forEach((user) => this.users.set(user.id, user));
  }

  seed(overrides: Partial<AuthUserRecord> = {}): AuthUserRecord {
    this.sequence += 1;
    const now = new Date('2026-01-01T00:00:00.000Z');
    const user: AuthUserRecord = {
      id: `user_${this.sequence}`,
      email: `user${this.sequence}@example.com`,
      passwordHash: 'unset',
      displayName: null,
      isActive: true,
      isSuperAdmin: false,
      tokenVersion: 0,
      deletedAt: null,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    this.users.set(user.id, user);
    return user;
  }

  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    return (
      [...this.users.values()].find((user) => user.email === email && user.deletedAt === null) ??
      null
    );
  }

  async findById(userId: string): Promise<AuthUserRecord | null> {
    const user = this.users.get(userId);
    return user && user.deletedAt === null ? user : null;
  }

  async create(input: CreateUserInput): Promise<AuthUserRecord> {
    return this.seed({ ...input });
  }

  async recordLogin(userId: string, at: Date): Promise<void> {
    const user = this.users.get(userId);
    if (user) user.lastLoginAt = at;
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) user.passwordHash = passwordHash;
  }

  async incrementTokenVersion(userId: string): Promise<number> {
    const user = this.users.get(userId);
    if (!user) return 0;
    user.tokenVersion += 1;
    return user.tokenVersion;
  }
}

export class InMemoryRefreshTokenStore implements RefreshTokenStore {
  readonly records = new Map<string, RefreshTokenRecord & { replacedByHash?: string }>();

  async save(input: SaveRefreshTokenInput): Promise<void> {
    this.records.set(input.tokenHash, {
      tokenHash: input.tokenHash,
      userId: input.userId,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      revokedAt: null,
      revokedReason: null,
    });
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    return this.records.get(tokenHash) ?? null;
  }

  async revoke(
    tokenHash: string,
    reason: RevocationReason,
    replacedByHash?: string,
  ): Promise<void> {
    const record = this.records.get(tokenHash);
    // Matches the Prisma store: never overwrite an existing revocation reason.
    if (!record || record.revokedAt) return;
    record.revokedAt = new Date();
    record.revokedReason = reason;
    if (replacedByHash) record.replacedByHash = replacedByHash;
  }

  async revokeFamily(familyId: string, reason: RevocationReason): Promise<void> {
    for (const record of this.records.values()) {
      if (record.familyId === familyId && !record.revokedAt) {
        record.revokedAt = new Date();
        record.revokedReason = reason;
      }
    }
  }

  async revokeAllForUser(userId: string, reason: RevocationReason): Promise<void> {
    for (const record of this.records.values()) {
      if (record.userId === userId && !record.revokedAt) {
        record.revokedAt = new Date();
        record.revokedReason = reason;
      }
    }
  }

  liveTokens(): RefreshTokenRecord[] {
    return [...this.records.values()].filter((record) => !record.revokedAt);
  }
}

export class InMemoryMembershipResolver implements MembershipResolver {
  private readonly byUser = new Map<string, MembershipSummary[]>();

  add(userId: string, membership: Partial<MembershipSummary> & { organizationId: string }): void {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const entry: MembershipSummary = {
      organizationName: `Organization ${membership.organizationId}`,
      organizationSlug: membership.organizationId,
      organizationIsActive: true,
      organizationCreatedAt: now,
      organizationUpdatedAt: now,
      roles: ['operator'],
      permissions: ['organization.read'],
      ...membership,
    };
    this.byUser.set(userId, [...(this.byUser.get(userId) ?? []), entry]);
  }

  remove(userId: string, organizationId: string): void {
    this.byUser.set(
      userId,
      (this.byUser.get(userId) ?? []).filter((entry) => entry.organizationId !== organizationId),
    );
  }

  async listMemberships(userId: string): Promise<MembershipSummary[]> {
    return this.byUser.get(userId) ?? [];
  }

  async resolveAccess(userId: string, organizationId: string): Promise<MembershipSummary | null> {
    return (
      (this.byUser.get(userId) ?? []).find((entry) => entry.organizationId === organizationId) ??
      null
    );
  }
}
