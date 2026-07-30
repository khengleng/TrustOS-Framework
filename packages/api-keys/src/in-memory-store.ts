import type { ApiKeyRecord, ApiKeyStore } from './service';

/**
 * In-memory API key store.
 *
 * Exported rather than kept in the test file, because it is the store a boot test and
 * a local development run both need: the alternative is that every consumer writes its
 * own, and one of them forgets to filter `findById` by organization — which is the
 * cross-tenant read this class exists to make impossible to get wrong by accident.
 *
 * Not for production. Everything is lost on restart, and nothing is indexed.
 */
export class InMemoryApiKeyStore implements ApiKeyStore {
  readonly records = new Map<string, ApiKeyRecord>();
  private counter = 0;

  async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    for (const record of this.records.values()) {
      if (record.keyHash === keyHash && !record.deletedAt) return { ...record };
    }
    return null;
  }

  async findById(id: string, organizationId: string): Promise<ApiKeyRecord | null> {
    const record = this.records.get(id);
    // Filtered by organization, which is what the cross-tenant test relies on.
    return record && record.organizationId === organizationId && !record.deletedAt
      ? { ...record }
      : null;
  }

  async findByName(organizationId: string, name: string): Promise<ApiKeyRecord | null> {
    for (const record of this.records.values()) {
      if (record.organizationId === organizationId && record.name === name && !record.deletedAt) {
        return { ...record };
      }
    }
    return null;
  }

  async listForOrganization(organizationId: string): Promise<ApiKeyRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.organizationId === organizationId && !record.deletedAt)
      .map((record) => ({ ...record }));
  }

  async countActive(organizationId: string): Promise<number> {
    return (await this.listForOrganization(organizationId)).filter(
      (record) => record.revokedAt === null,
    ).length;
  }

  async create(
    input: Omit<ApiKeyRecord, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'usageCount'>,
  ): Promise<ApiKeyRecord> {
    this.counter += 1;
    const now = new Date();
    const record: ApiKeyRecord = {
      ...input,
      id: `key_${this.counter}`,
      usageCount: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.records.set(record.id, record);
    return { ...record };
  }

  async update(id: string, patch: Partial<ApiKeyRecord>): Promise<ApiKeyRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error(`no key ${id}`);
    Object.assign(record, patch, { updatedAt: new Date() });
    return { ...record };
  }

  async recordUse(id: string, at: Date, ipAddress: string | null): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    record.lastUsedAt = at;
    record.lastUsedIp = ipAddress;
    record.usageCount += 1;
  }
}
