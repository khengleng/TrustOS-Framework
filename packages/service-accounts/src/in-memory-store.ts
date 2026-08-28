import { randomUUID } from 'node:crypto';
import type { ServiceAccountRecord, ServiceAccountStore } from './service';

/** In-memory store, for tests. The Prisma store is the real one. */
export class InMemoryServiceAccountStore implements ServiceAccountStore {
  private readonly accounts = new Map<string, ServiceAccountRecord>();

  async findById(id: string): Promise<ServiceAccountRecord | null> {
    const record = this.accounts.get(id);
    return record && !record.deletedAt ? { ...record } : null;
  }

  async findByCredentialHash(hash: string): Promise<ServiceAccountRecord | null> {
    for (const record of this.accounts.values()) {
      if (record.credentialHash === hash && !record.deletedAt) return { ...record };
    }
    return null;
  }

  async findByOidcClientId(clientId: string): Promise<ServiceAccountRecord | null> {
    for (const record of this.accounts.values()) {
      if (record.oidcClientId === clientId && !record.deletedAt) return { ...record };
    }
    return null;
  }

  async findByName(
    organizationId: string | null,
    name: string,
  ): Promise<ServiceAccountRecord | null> {
    for (const record of this.accounts.values()) {
      if (record.organizationId === organizationId && record.name === name && !record.deletedAt) {
        return { ...record };
      }
    }
    return null;
  }

  async list(organizationId: string | null): Promise<ServiceAccountRecord[]> {
    return [...this.accounts.values()]
      .filter((record) => record.organizationId === organizationId && !record.deletedAt)
      .map((record) => ({ ...record }));
  }

  async create(
    input: Omit<ServiceAccountRecord, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<ServiceAccountRecord> {
    const now = new Date();
    const record: ServiceAccountRecord = {
      ...input,
      id: `sa_${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.accounts.set(record.id, record);
    return { ...record };
  }

  async update(id: string, patch: Partial<ServiceAccountRecord>): Promise<ServiceAccountRecord> {
    const record = this.accounts.get(id);
    if (!record) throw new Error(`No service account ${id}`);
    Object.assign(record, patch, { updatedAt: new Date() });
    return { ...record };
  }

  async recordUse(id: string, at: Date, ipAddress: string | null): Promise<void> {
    const record = this.accounts.get(id);
    if (!record) return;
    record.lastUsedAt = at;
    record.lastUsedIp = ipAddress;
  }
}
