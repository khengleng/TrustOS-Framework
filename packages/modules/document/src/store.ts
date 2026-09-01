import { ModuleRepository, type ModuleContext } from '@trustsystem/module-sdk';
import type { DocumentConfig } from './config';

/** Where categories, documents and versions live. */

export interface DocumentCategoryRow {
  id: string;
  organizationId: string;
  key: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface DocumentRow {
  id: string;
  organizationId: string;
  categoryId: string | null;
  title: string;
  description: string | null;
  /** Storage key of the current version, inside the organization namespace. */
  storageKey: string;
  contentType: string;
  checksum: string;
  byteSize: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Append-only version history. */
export interface DocumentVersionRow {
  id: string;
  organizationId: string;
  documentId: string;
  version: number;
  storageKey: string;
  contentType: string;
  checksum: string;
  byteSize: number;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface DocumentStore {
  listCategories(): Promise<DocumentCategoryRow[]>;
  findCategoryByKey(key: string): Promise<DocumentCategoryRow | null>;
  requireCategory(id: string, organizationId: string): Promise<DocumentCategoryRow>;
  createCategory(
    row: Omit<
      DocumentCategoryRow,
      'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
    >,
  ): Promise<DocumentCategoryRow>;

  listDocuments(options: {
    categoryId?: string;
    skip?: number;
    take?: number;
  }): Promise<DocumentRow[]>;
  countDocuments(categoryId?: string): Promise<number>;
  findDocument(id: string, organizationId: string): Promise<DocumentRow>;
  createDocument(
    row: Omit<DocumentRow, 'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<DocumentRow>;
  updateDocument(id: string, patch: Partial<DocumentRow>): Promise<DocumentRow>;
  softDeleteDocument(id: string, now: Date): Promise<DocumentRow>;

  addVersion(
    row: Omit<DocumentVersionRow, 'id' | 'organizationId' | 'createdAt' | 'deletedAt'>,
  ): Promise<DocumentVersionRow>;
  listVersions(documentId: string): Promise<DocumentVersionRow[]>;
}

export class PrismaDocumentStore implements DocumentStore {
  private readonly categories: ModuleRepository<DocumentCategoryRow>;
  private readonly documents: ModuleRepository<DocumentRow>;
  private readonly versions: ModuleRepository<DocumentVersionRow>;

  constructor(context: ModuleContext<DocumentConfig>) {
    const { prisma, moduleId } = context;
    this.categories = new ModuleRepository(prisma, 'documentCategory', moduleId);
    this.documents = new ModuleRepository(prisma, 'document', moduleId);
    this.versions = new ModuleRepository(prisma, 'documentVersion', moduleId);
  }

  listCategories(): Promise<DocumentCategoryRow[]> {
    return this.categories.list({ orderBy: { key: 'asc' } });
  }

  findCategoryByKey(key: string): Promise<DocumentCategoryRow | null> {
    return this.categories.findFirst({ key });
  }

  requireCategory(id: string, organizationId: string): Promise<DocumentCategoryRow> {
    return this.categories.findById(id, organizationId);
  }

  createCategory(
    row: Omit<
      DocumentCategoryRow,
      'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
    >,
  ): Promise<DocumentCategoryRow> {
    return this.categories.create({ ...row });
  }

  listDocuments(options: {
    categoryId?: string;
    skip?: number;
    take?: number;
  }): Promise<DocumentRow[]> {
    return this.documents.list({
      ...(options.categoryId ? { where: { categoryId: options.categoryId } } : {}),
      ...(options.skip === undefined ? {} : { skip: options.skip }),
      ...(options.take === undefined ? {} : { take: options.take }),
    });
  }

  countDocuments(categoryId?: string): Promise<number> {
    return this.documents.count(categoryId ? { categoryId } : {});
  }

  findDocument(id: string, organizationId: string): Promise<DocumentRow> {
    return this.documents.findById(id, organizationId);
  }

  createDocument(
    row: Omit<DocumentRow, 'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<DocumentRow> {
    return this.documents.create({ ...row });
  }

  updateDocument(id: string, patch: Partial<DocumentRow>): Promise<DocumentRow> {
    return this.documents.update(id, { ...patch });
  }

  softDeleteDocument(id: string, now: Date): Promise<DocumentRow> {
    return this.documents.softDelete(id, now);
  }

  addVersion(
    row: Omit<DocumentVersionRow, 'id' | 'organizationId' | 'createdAt' | 'deletedAt'>,
  ): Promise<DocumentVersionRow> {
    return this.versions.create({ ...row });
  }

  listVersions(documentId: string): Promise<DocumentVersionRow[]> {
    return this.versions.list({ where: { documentId }, orderBy: { version: 'desc' } });
  }
}
