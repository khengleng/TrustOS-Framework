import { ApiError } from '@trustsystem/errors';
import type { ModuleContext } from '@trustsystem/module-sdk';
import {
  assertKeyBelongsTo,
  assertValidKey,
  checksumOf,
  tenantKey,
  type StorageProvider,
} from '@trustsystem/module-file-storage';
import { buildPageMeta, type Paginated } from '@trustsystem/shared-types';
import type { DocumentConfig } from './config';
import type { DocumentCategoryRow, DocumentRow, DocumentStore, DocumentVersionRow } from './store';

/**
 * Documents for one application.
 *
 * Content is held through the file-storage module's `StorageProvider` port, and
 * keys are built with its helpers. That is the whole reason for the module
 * dependency: containment — the code that turns a caller-supplied name into a
 * filesystem path — exists once, in one file, with one set of tests, rather than
 * being written a second time here.
 */

export interface UploadDocumentInput {
  title: string;
  /** Filename-safe name; becomes part of the storage key. */
  name: string;
  content: Buffer;
  contentType: string;
  description?: string;
  categoryKey?: string;
}

export interface DocumentListQuery {
  categoryKey?: string;
  page?: number;
  pageSize?: number;
}

const MAX_PAGE_SIZE = 100;

export class DocumentService {
  constructor(
    private readonly context: ModuleContext<DocumentConfig>,
    private readonly store: DocumentStore,
    private readonly storage: StorageProvider,
  ) {}

  // --- categories -----------------------------------------------------------

  listCategories(): Promise<DocumentCategoryRow[]> {
    return this.store.listCategories();
  }

  async createCategory(
    input: { key: string; name: string },
    organizationId: string,
  ): Promise<DocumentCategoryRow> {
    if (await this.store.findCategoryByKey(input.key)) {
      throw ApiError.conflict(`A category with key "${input.key}" already exists.`);
    }

    const category = await this.store.createCategory({ ...input });

    await this.context.audit.record({
      action: 'document.category.created',
      entityType: 'DocumentCategory',
      entityId: category.id,
      organizationId,
      after: { key: category.key, name: category.name },
    });

    return category;
  }

  // --- documents ------------------------------------------------------------

  async upload(input: UploadDocumentInput, organizationId: string): Promise<DocumentRow> {
    const config = await this.context.resolveConfig(organizationId);
    this.assertAcceptable(input, config);

    const category = await this.resolveCategory(input.categoryKey, config);
    const name = assertValidKey(input.name);
    const storageKey = this.keyFor(organizationId, name, 1);

    const stored = await this.storage.put({
      key: storageKey,
      content: input.content,
      contentType: input.contentType,
    });

    const document = await this.store.createDocument({
      categoryId: category?.id ?? null,
      title: input.title,
      description: input.description ?? null,
      storageKey,
      contentType: stored.contentType,
      checksum: stored.checksum,
      byteSize: stored.byteSize,
      version: 1,
    });

    if (config.versioning) {
      await this.store.addVersion({
        documentId: document.id,
        version: 1,
        storageKey,
        contentType: stored.contentType,
        checksum: stored.checksum,
        byteSize: stored.byteSize,
      });
    }

    await this.context.audit.record({
      action: 'document.document.uploaded',
      entityType: 'Document',
      entityId: document.id,
      organizationId,
      // Title, size and checksum — never the content, and never the description,
      // which is free text a person may have pasted a customer detail into.
      after: {
        title: document.title,
        category: category?.key ?? null,
        checksum: stored.checksum,
        byteSize: stored.byteSize,
      },
    });

    return document;
  }

  /**
   * Adds a version to an existing document.
   *
   * The new content is written under a new key before the row moves, so a failed
   * write leaves the document pointing at the version that is still there.
   */
  async addVersion(
    id: string,
    input: { content: Buffer; contentType: string; name?: string },
    organizationId: string,
  ): Promise<DocumentRow> {
    const config = await this.context.resolveConfig(organizationId);
    const document = await this.store.findDocument(id, organizationId);

    this.assertAcceptable(input, config);

    const version = document.version + 1;
    const name = assertValidKey(input.name ?? baseNameOf(document.storageKey));
    const storageKey = this.keyFor(organizationId, name, version);

    const stored = await this.storage.put({
      key: storageKey,
      content: input.content,
      contentType: input.contentType,
    });

    const updated = await this.store.updateDocument(id, {
      storageKey,
      contentType: stored.contentType,
      checksum: stored.checksum,
      byteSize: stored.byteSize,
      version,
    });

    await this.store.addVersion({
      documentId: document.id,
      version,
      storageKey,
      contentType: stored.contentType,
      checksum: stored.checksum,
      byteSize: stored.byteSize,
    });

    await this.context.audit.record({
      action: 'document.version.created',
      entityType: 'DocumentVersion',
      entityId: document.id,
      organizationId,
      after: { version, checksum: stored.checksum, byteSize: stored.byteSize },
    });

    return updated;
  }

  async list(
    organizationId: string,
    query: DocumentListQuery = {},
  ): Promise<Paginated<DocumentRow>> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize ?? 25)));

    const category = query.categoryKey
      ? await this.store.findCategoryByKey(query.categoryKey)
      : null;

    if (query.categoryKey && !category) {
      throw ApiError.notFound(`No category with key "${query.categoryKey}".`);
    }

    const [items, totalItems] = await Promise.all([
      this.store.listDocuments({
        ...(category ? { categoryId: category.id } : {}),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.store.countDocuments(category?.id),
    ]);

    // Belt and braces on top of the scoped store.
    for (const item of items) assertKeyBelongsTo(organizationId, item.storageKey);

    return { items, meta: buildPageMeta({ page, pageSize }, totalItems) };
  }

  find(id: string, organizationId: string): Promise<DocumentRow> {
    return this.store.findDocument(id, organizationId);
  }

  /**
   * Reads content, verifying it against the checksum on the row.
   *
   * A download is audited. Reading a document is exactly the action an
   * investigation asks about afterwards — who opened this contract — and it is
   * cheap to record next to the upload that created it.
   */
  async download(
    id: string,
    organizationId: string,
  ): Promise<{ document: DocumentRow; content: Buffer }> {
    const document = await this.store.findDocument(id, organizationId);
    assertKeyBelongsTo(organizationId, document.storageKey);

    const blob = await this.storage.get(document.storageKey);
    const actual = checksumOf(blob.content);

    if (actual !== document.checksum) {
      throw new ApiError('internal_error', {
        message: 'Stored content failed its integrity check.',
        context: { reason: 'checksum_mismatch', documentId: document.id },
      });
    }

    await this.context.audit.record({
      action: 'document.document.downloaded',
      entityType: 'Document',
      entityId: document.id,
      organizationId,
      after: { title: document.title, version: document.version },
    });

    return { document, content: blob.content };
  }

  async update(
    id: string,
    input: { title?: string; description?: string; categoryKey?: string },
    organizationId: string,
  ): Promise<DocumentRow> {
    const config = await this.context.resolveConfig(organizationId);
    const existing = await this.store.findDocument(id, organizationId);

    const category =
      input.categoryKey === undefined
        ? null
        : await this.resolveCategory(input.categoryKey, config);

    const before = {
      title: existing.title,
      description: existing.description,
      categoryId: existing.categoryId,
    };

    const updated = await this.store.updateDocument(id, {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(category ? { categoryId: category.id } : {}),
    });

    await this.context.audit.record({
      action: 'document.document.updated',
      entityType: 'Document',
      entityId: id,
      organizationId,
      before,
      after: {
        title: updated.title,
        description: updated.description,
        categoryId: updated.categoryId,
      },
    });

    return updated;
  }

  async versions(id: string, organizationId: string): Promise<DocumentVersionRow[]> {
    const document = await this.store.findDocument(id, organizationId);
    return this.store.listVersions(document.id);
  }

  /**
   * Retires a document.
   *
   * Soft delete, and content is left in place: a document that has been filed
   * against a case may be needed for a retention period the module knows nothing
   * about, and deleting the bytes would make the version history a list of things
   * that cannot be opened.
   */
  async remove(id: string, organizationId: string): Promise<DocumentRow> {
    const existing = await this.store.findDocument(id, organizationId);
    const removed = await this.store.softDeleteDocument(id, this.context.clock());

    await this.context.audit.record({
      action: 'document.document.deleted',
      entityType: 'Document',
      entityId: id,
      organizationId,
      before: { title: existing.title, version: existing.version },
    });

    return removed;
  }

  // --- internals ------------------------------------------------------------

  private keyFor(organizationId: string, name: string, version: number): string {
    // Under a `documents/` prefix so document content and anything the
    // file-storage module holds directly cannot collide on a key.
    return tenantKey(organizationId, `documents/${name}/v${version}`);
  }

  private async resolveCategory(
    key: string | undefined,
    config: DocumentConfig,
  ): Promise<DocumentCategoryRow | null> {
    if (!key) {
      if (config.requireCategory) {
        throw ApiError.validation(
          [{ path: 'categoryKey', message: 'Required for this organization.' }],
          'A category is required.',
        );
      }
      return null;
    }

    const category = await this.store.findCategoryByKey(key);
    if (!category) throw ApiError.notFound(`No category with key "${key}".`);
    return category;
  }

  private assertAcceptable(
    input: { content: Buffer; contentType: string },
    config: DocumentConfig,
  ): void {
    if (input.content.byteLength === 0) {
      const message = 'Content is empty.';
      throw ApiError.validation([{ path: 'content', message }], message);
    }

    if (input.content.byteLength > config.maxUploadBytes) {
      const message = `Content exceeds the ${config.maxUploadBytes} byte limit for this organization.`;
      throw ApiError.validation([{ path: 'content', message }], message);
    }

    if (!config.allowedContentTypes.includes(input.contentType)) {
      // The list is an allow-list rather than a deny-list: a format nobody
      // thought about is refused, not accepted.
      const message = `Content type "${input.contentType}" is not accepted.`;
      throw ApiError.validation([{ path: 'contentType', message }], message);
    }
  }
}

/** `org/x/documents/report.pdf/v3` -> `report.pdf`. */
function baseNameOf(storageKey: string): string {
  const segments = storageKey.split('/');
  return segments[segments.length - 2] ?? 'content';
}
