import { ApiError } from '@trustsystem/errors';
import type { ModuleContext } from '@trustsystem/module-sdk';
import { buildPageMeta, type Paginated } from '@trustsystem/shared-types';
import type { FileStorageConfig } from './config';
import { assertKeyBelongsTo, assertValidKey, organizationPrefix, tenantKey } from './keys';
import { checksumOf, type StorageProvider, type StoredBlob } from './provider';
import type { StoredObjectRow, StoredObjectStore, StoredObjectVersionRow } from './store';

/**
 * Object storage for one application.
 *
 * The service owns three things the provider deliberately does not: the
 * organization namespace every key sits inside, version history, and the audit
 * trail. That split is what lets a provider be swapped without re-proving tenant
 * isolation.
 *
 * `organizationId` is a parameter on every method rather than something the
 * service reaches for, so a background job and an HTTP request take the same
 * code path.
 */

export interface StoreObjectInput {
  /** Caller-facing name. Becomes part of the storage key, so it is validated. */
  name: string;
  content: Buffer;
  contentType: string;
}

export interface ObjectListQuery {
  namePrefix?: string;
  page?: number;
  pageSize?: number;
}

const MAX_PAGE_SIZE = 100;

export class FileStorageService {
  constructor(
    private readonly context: ModuleContext<FileStorageConfig>,
    private readonly provider: StorageProvider,
    private readonly objects: StoredObjectStore,
  ) {}

  /**
   * Stores an object, or a new version of one.
   *
   * Content is written before the row is updated. If the write fails the row
   * still points at the previous version, which is intact — the reverse order
   * would leave a row referring to bytes that were never stored.
   */
  async store(input: StoreObjectInput, organizationId: string): Promise<StoredObjectRow> {
    const config = await this.context.resolveConfig(organizationId);
    const name = assertValidKey(input.name);

    this.assertAcceptable(input, config);

    const existing = await this.objects.findByName(name);
    const version = existing ? existing.version + 1 : 1;
    const storageKey = this.keyFor(organizationId, name, version, config);

    const metadata = await this.provider.put({
      key: storageKey,
      content: input.content,
      contentType: input.contentType,
    });

    const row = existing
      ? await this.objects.update(existing.id, {
          storageKey,
          contentType: metadata.contentType,
          checksum: metadata.checksum,
          byteSize: metadata.byteSize,
          version,
        })
      : await this.objects.create({
          storageKey,
          name,
          contentType: metadata.contentType,
          checksum: metadata.checksum,
          byteSize: metadata.byteSize,
          version,
        });

    if (config.versioning) {
      await this.objects.addVersion({
        objectId: row.id,
        version,
        storageKey,
        checksum: metadata.checksum,
        byteSize: metadata.byteSize,
        contentType: metadata.contentType,
      });
    }

    await this.context.audit.record({
      action: 'file-storage.object.stored',
      entityType: 'StoredObject',
      entityId: row.id,
      organizationId,
      // The checksum and size, never the content: an audit trail that carries
      // payloads is a second copy of the data with different access controls.
      after: { name, version, checksum: metadata.checksum, byteSize: metadata.byteSize },
    });

    return row;
  }

  async metadata(id: string, organizationId: string): Promise<StoredObjectRow> {
    return this.objects.findById(id, organizationId);
  }

  /**
   * Reads content, verifying its checksum.
   *
   * A mismatch is audited and then thrown. Returning corrupt bytes silently is
   * the one outcome that must not happen: whatever consumes them has no way to
   * tell, and the corruption propagates.
   */
  async read(
    id: string,
    organizationId: string,
  ): Promise<{ object: StoredObjectRow; blob: StoredBlob }> {
    const object = await this.objects.findById(id, organizationId);
    assertKeyBelongsTo(organizationId, object.storageKey);

    let blob: StoredBlob;
    try {
      blob = await this.provider.get(object.storageKey);
    } catch (error) {
      if (isChecksumMismatch(error)) {
        await this.context.audit.record({
          action: 'file-storage.object.checksum-mismatch',
          entityType: 'StoredObject',
          entityId: object.id,
          organizationId,
          after: { name: object.name, expected: object.checksum },
        });
      }
      throw error;
    }

    // Second check, against the row rather than the sidecar: a provider whose
    // metadata was rewritten alongside the content would pass its own check.
    const actual = checksumOf(blob.content);
    if (actual !== object.checksum) {
      await this.context.audit.record({
        action: 'file-storage.object.checksum-mismatch',
        entityType: 'StoredObject',
        entityId: object.id,
        organizationId,
        after: { name: object.name, expected: object.checksum, actual },
      });

      throw new ApiError('internal_error', {
        message: 'Stored content failed its integrity check.',
        context: { reason: 'checksum_mismatch_against_row', objectId: object.id },
      });
    }

    await this.context.audit.record({
      action: 'file-storage.object.read',
      entityType: 'StoredObject',
      entityId: object.id,
      organizationId,
      after: { name: object.name, version: object.version },
    });

    return { object, blob };
  }

  async list(
    organizationId: string,
    query: ObjectListQuery = {},
  ): Promise<Paginated<StoredObjectRow>> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize ?? 25)));

    if (query.namePrefix) assertValidKey(query.namePrefix);

    const [items, totalItems] = await Promise.all([
      this.objects.list({
        ...(query.namePrefix ? { namePrefix: query.namePrefix } : {}),
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.objects.count(),
    ]);

    // Belt and braces on top of the scoped store: a row whose key is outside
    // this organization's namespace is a bug, and returning it would be a
    // cross-tenant read.
    for (const item of items) assertKeyBelongsTo(organizationId, item.storageKey);

    return { items, meta: buildPageMeta({ page, pageSize }, totalItems) };
  }

  async versions(id: string, organizationId: string): Promise<StoredObjectVersionRow[]> {
    const object = await this.objects.findById(id, organizationId);
    return this.objects.listVersions(object.id);
  }

  /**
   * Retires an object.
   *
   * The row is soft-deleted and the bytes are left in place. Deleting content
   * immediately would make the version history a list of things that cannot be
   * read, and a retention decision belongs to the application, not to a module.
   */
  async remove(id: string, organizationId: string): Promise<StoredObjectRow> {
    const object = await this.objects.findById(id, organizationId);
    const before = { name: object.name, version: object.version, byteSize: object.byteSize };

    const removed = await this.objects.softDelete(object.id, this.context.clock());

    await this.context.audit.record({
      action: 'file-storage.object.deleted',
      entityType: 'StoredObject',
      entityId: object.id,
      organizationId,
      before,
    });

    return removed;
  }

  /** Keys under an organization's namespace. Diagnostic; not a listing API. */
  async keys(organizationId: string): Promise<string[]> {
    return this.provider.list(organizationPrefix(organizationId));
  }

  // --- internals ------------------------------------------------------------

  private keyFor(
    organizationId: string,
    name: string,
    version: number,
    config: FileStorageConfig,
  ): string {
    // Versioned objects get one key per version so a previous version is still
    // readable; unversioned objects reuse one key and overwrite in place.
    return config.versioning
      ? tenantKey(organizationId, `${name}/v${version}`)
      : tenantKey(organizationId, name);
  }

  /**
   * Applies the organization's limits.
   *
   * These messages are deliberately specific and client-visible: a size ceiling
   * and an accepted content-type list are documented API limits, not information
   * about how the server is wired, and a caller that cannot tell why an upload
   * was refused will retry it.
   */
  private assertAcceptable(input: StoreObjectInput, config: FileStorageConfig): void {
    if (input.content.byteLength === 0) {
      const message = 'Content is empty.';
      throw ApiError.validation([{ path: 'content', message }], message);
    }

    if (input.content.byteLength > config.maxBytes) {
      const message = `Content exceeds the ${config.maxBytes} byte limit for this organization.`;
      throw ApiError.validation([{ path: 'content', message }], message);
    }

    if (
      config.allowedContentTypes.length > 0 &&
      !config.allowedContentTypes.includes(input.contentType)
    ) {
      const message = `Content type "${input.contentType}" is not accepted.`;
      throw ApiError.validation([{ path: 'contentType', message }], message);
    }
  }
}

function isChecksumMismatch(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'context' in error &&
    (error as { context?: { reason?: string } }).context?.reason === 'checksum_mismatch'
  );
}
