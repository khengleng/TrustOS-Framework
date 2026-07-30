import type { ApiKeyRecord, ApiKeyStore } from './service';

/**
 * Prisma-backed key store.
 *
 * Written against a narrow delegate rather than a `PrismaClient`, for the reason
 * phase 2 discovered: the framework's client and a generated application's client
 * are produced from different schemas and are not structurally assignable, so naming
 * the capability keeps this usable with either.
 *
 * Not tenant-scoped through `@trustos/tenancy`, and that is deliberate:
 * `findByHash` runs *before* an actor exists, so there is no tenant context to scope
 * to. Every other method takes an `organizationId` and filters on it explicitly, and
 * the tests assert that a key from another organization is not returned.
 */
export interface ApiKeyDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<ApiKeyRecord | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
  }): Promise<ApiKeyRecord[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  create(args: { data: Record<string, unknown> }): Promise<ApiKeyRecord>;
  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<ApiKeyRecord>;
}

export class PrismaApiKeyStore implements ApiKeyStore {
  constructor(private readonly delegate: ApiKeyDelegate) {}

  findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    // By hash, not by prefix: the hash is unique and the lookup is exact, so a
    // near-miss cannot select a different organization's key.
    return this.delegate.findFirst({ where: { keyHash, deletedAt: null } });
  }

  findById(id: string, organizationId: string): Promise<ApiKeyRecord | null> {
    return this.delegate.findFirst({ where: { id, organizationId, deletedAt: null } });
  }

  findByName(organizationId: string, name: string): Promise<ApiKeyRecord | null> {
    return this.delegate.findFirst({ where: { organizationId, name, deletedAt: null } });
  }

  listForOrganization(organizationId: string): Promise<ApiKeyRecord[]> {
    return this.delegate.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  countActive(organizationId: string): Promise<number> {
    return this.delegate.count({
      where: { organizationId, deletedAt: null, revokedAt: null },
    });
  }

  create(
    input: Omit<ApiKeyRecord, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'usageCount'>,
  ): Promise<ApiKeyRecord> {
    return this.delegate.create({ data: { ...input } });
  }

  update(id: string, patch: Partial<ApiKeyRecord>): Promise<ApiKeyRecord> {
    return this.delegate.update({ where: { id }, data: { ...patch } });
  }

  async recordUse(id: string, at: Date, ipAddress: string | null): Promise<void> {
    await this.delegate.update({
      where: { id },
      data: {
        lastUsedAt: at,
        lastUsedIp: ipAddress,
        // Incremented in the database rather than read-modify-written, so two
        // concurrent requests do not lose a count.
        usageCount: { increment: 1 },
      },
    });
  }
}
