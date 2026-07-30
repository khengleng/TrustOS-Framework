import { ModuleRepository, type ModuleContext } from '@trustos/module-sdk';
import type { FileStorageConfig } from './config';

/**
 * Where object rows live.
 *
 * Separated from the byte storage so the two can move independently: an
 * application can keep rows in Postgres and bytes in a bucket without either
 * half knowing about the other.
 */

export interface StoredObjectRow {
  id: string;
  organizationId: string;
  /** Full storage key, including the organization namespace. */
  storageKey: string;
  /** Caller-facing name, without the namespace. */
  name: string;
  contentType: string;
  checksum: string;
  byteSize: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface StoredObjectVersionRow {
  id: string;
  organizationId: string;
  objectId: string;
  version: number;
  storageKey: string;
  checksum: string;
  byteSize: number;
  contentType: string;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface StoredObjectStore {
  findById(id: string, organizationId: string): Promise<StoredObjectRow>;
  findByName(name: string): Promise<StoredObjectRow | null>;
  list(options: { namePrefix?: string; skip?: number; take?: number }): Promise<StoredObjectRow[]>;
  count(): Promise<number>;
  create(
    row: Omit<StoredObjectRow, 'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<StoredObjectRow>;
  update(id: string, patch: Partial<StoredObjectRow>): Promise<StoredObjectRow>;
  softDelete(id: string, now: Date): Promise<StoredObjectRow>;

  addVersion(
    row: Omit<StoredObjectVersionRow, 'id' | 'organizationId' | 'createdAt' | 'deletedAt'>,
  ): Promise<StoredObjectVersionRow>;
  listVersions(objectId: string): Promise<StoredObjectVersionRow[]>;
}

/**
 * Prisma-backed store.
 *
 * Both repositories are `ModuleRepository`, so `organizationId` is applied by
 * `@trustos/tenancy` on every query rather than by these methods remembering to.
 */
export class PrismaStoredObjectStore implements StoredObjectStore {
  private readonly objects: ModuleRepository<StoredObjectRow>;
  private readonly versions: ModuleRepository<StoredObjectVersionRow>;

  constructor(context: ModuleContext<FileStorageConfig>) {
    this.objects = new ModuleRepository(context.prisma, 'storedObject', context.moduleId);
    this.versions = new ModuleRepository(context.prisma, 'storedObjectVersion', context.moduleId);
  }

  findById(id: string, organizationId: string): Promise<StoredObjectRow> {
    return this.objects.findById(id, organizationId);
  }

  findByName(name: string): Promise<StoredObjectRow | null> {
    return this.objects.findFirst({ name });
  }

  list(options: { namePrefix?: string; skip?: number; take?: number }): Promise<StoredObjectRow[]> {
    return this.objects.list({
      // `startsWith` is a parameterized Prisma filter, not string interpolation,
      // so a prefix containing `%` is a literal `%` and not a wildcard.
      ...(options.namePrefix ? { where: { name: { startsWith: options.namePrefix } } } : {}),
      ...(options.skip === undefined ? {} : { skip: options.skip }),
      ...(options.take === undefined ? {} : { take: options.take }),
    });
  }

  count(): Promise<number> {
    return this.objects.count();
  }

  create(
    row: Omit<StoredObjectRow, 'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<StoredObjectRow> {
    return this.objects.create({ ...row });
  }

  update(id: string, patch: Partial<StoredObjectRow>): Promise<StoredObjectRow> {
    return this.objects.update(id, { ...patch });
  }

  softDelete(id: string, now: Date): Promise<StoredObjectRow> {
    return this.objects.softDelete(id, now);
  }

  addVersion(
    row: Omit<StoredObjectVersionRow, 'id' | 'organizationId' | 'createdAt' | 'deletedAt'>,
  ): Promise<StoredObjectVersionRow> {
    return this.versions.create({ ...row });
  }

  listVersions(objectId: string): Promise<StoredObjectVersionRow[]> {
    return this.versions.list({ where: { objectId }, orderBy: { version: 'desc' } });
  }
}
