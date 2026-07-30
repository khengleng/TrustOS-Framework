import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ApiError } from '@trustos/errors';
import { assertValidKey, resolveWithinRoot } from './keys';

/**
 * Where bytes live.
 *
 * The port is intentionally small: put, get, head, delete, list. Everything the
 * module offers on top — versioning, checksums, tenant namespaces, audit — is
 * built above this interface, so moving from local disk to object storage is one
 * new class and no changes to callers.
 */
export interface StoredBlob {
  key: string;
  content: Buffer;
  contentType: string;
  /** SHA-256 of `content`, lowercase hex. */
  checksum: string;
  byteSize: number;
}

export interface BlobMetadata {
  key: string;
  contentType: string;
  checksum: string;
  byteSize: number;
}

export interface StorageProvider {
  readonly id: string;
  put(input: { key: string; content: Buffer; contentType: string }): Promise<BlobMetadata>;
  get(key: string): Promise<StoredBlob>;
  head(key: string): Promise<BlobMetadata | null>;
  delete(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  /**
   * Whether the backend is usable, for the module's readiness contribution.
   *
   * Deliberately a cheap check rather than a write probe: readiness is polled
   * every few seconds, and a probe that writes turns the health endpoint into a
   * source of load and of garbage objects.
   */
  check(): Promise<{ ok: boolean; detail: string }>;
}

/** SHA-256, lowercase hex. The only checksum the module uses. */
export function checksumOf(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Thrown when stored content does not match its recorded checksum.
 *
 * Surfaced as `internal_error` rather than a 404: the object exists, and quietly
 * returning corrupt bytes is worse than failing. The module audits the mismatch
 * so it is visible after the fact.
 */
export function checksumMismatch(key: string, expected: string, actual: string): ApiError {
  return new ApiError('internal_error', {
    message: 'Stored content failed its integrity check.',
    context: { reason: 'checksum_mismatch', key, expected, actual },
  });
}

// ---------------------------------------------------------------------------

/** In-memory provider. Used by tests and by local development. */
export class InMemoryStorageProvider implements StorageProvider {
  readonly id = 'memory';
  private readonly blobs = new Map<string, StoredBlob>();

  async put(input: { key: string; content: Buffer; contentType: string }): Promise<BlobMetadata> {
    assertValidKey(input.key);

    const blob: StoredBlob = {
      key: input.key,
      content: Buffer.from(input.content),
      contentType: input.contentType,
      checksum: checksumOf(input.content),
      byteSize: input.content.byteLength,
    };

    this.blobs.set(input.key, blob);
    return metadataOf(blob);
  }

  async get(key: string): Promise<StoredBlob> {
    const blob = this.blobs.get(assertValidKey(key));
    if (!blob) throw ApiError.notFound();

    const actual = checksumOf(blob.content);
    if (actual !== blob.checksum) throw checksumMismatch(key, blob.checksum, actual);

    return { ...blob, content: Buffer.from(blob.content) };
  }

  async head(key: string): Promise<BlobMetadata | null> {
    const blob = this.blobs.get(assertValidKey(key));
    return blob ? metadataOf(blob) : null;
  }

  async delete(key: string): Promise<boolean> {
    return this.blobs.delete(assertValidKey(key));
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.blobs.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  async check(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: `${this.blobs.size} object(s) held in memory` };
  }

  /** Test helper: corrupts stored bytes without touching the checksum. */
  corrupt(key: string, content: Buffer): void {
    const blob = this.blobs.get(key);
    if (blob) this.blobs.set(key, { ...blob, content });
  }
}

/**
 * Local filesystem provider.
 *
 * Content and metadata are stored as two files per key: the bytes, and a `.meta`
 * sidecar holding the content type and checksum. A sidecar rather than an
 * extended attribute because extended attributes do not survive a copy, a
 * container image build, or most backup tools — and a checksum that disappears
 * during a restore is worse than no checksum.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly id = 'local';

  constructor(private readonly root: string) {}

  private paths(key: string): { content: string; meta: string } {
    const content = resolveWithinRoot(this.root, key);
    return { content, meta: `${content}.meta` };
  }

  async put(input: { key: string; content: Buffer; contentType: string }): Promise<BlobMetadata> {
    const { content, meta } = this.paths(input.key);
    await mkdir(dirname(content), { recursive: true });

    const metadata: BlobMetadata = {
      key: input.key,
      contentType: input.contentType,
      checksum: checksumOf(input.content),
      byteSize: input.content.byteLength,
    };

    // Content first, sidecar second. If the process dies between the two, the
    // object reads as missing rather than as present-with-no-checksum — a
    // recoverable state instead of an unverifiable one.
    await writeFile(content, input.content);
    await writeFile(meta, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

    return metadata;
  }

  async get(key: string): Promise<StoredBlob> {
    const { content, meta } = this.paths(key);
    if (!existsSync(content) || !existsSync(meta)) throw ApiError.notFound();

    const bytes = await readFile(content);
    const metadata = parseMetadata(await readFile(meta, 'utf8'), key);
    const actual = checksumOf(bytes);

    if (actual !== metadata.checksum) throw checksumMismatch(key, metadata.checksum, actual);

    return { ...metadata, content: bytes };
  }

  async head(key: string): Promise<BlobMetadata | null> {
    const { content, meta } = this.paths(key);
    if (!existsSync(content) || !existsSync(meta)) return null;
    return parseMetadata(await readFile(meta, 'utf8'), key);
  }

  async delete(key: string): Promise<boolean> {
    const { content, meta } = this.paths(key);
    if (!existsSync(content)) return false;

    await rm(content, { force: true });
    await rm(meta, { force: true });
    return true;
  }

  async list(prefix: string): Promise<string[]> {
    assertValidKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
    const base = resolveWithinRoot(this.root, prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
    if (!existsSync(base)) return [];

    const found: string[] = [];
    const walk = async (directory: string, keyPrefix: string): Promise<void> => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : 1,
      )) {
        const childKey = keyPrefix ? `${keyPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(join(directory, entry.name), childKey);
          continue;
        }
        // Sidecars are an implementation detail and are not objects.
        if (entry.isFile() && !entry.name.endsWith('.meta')) found.push(childKey);
      }
    };

    const info = await stat(base);
    if (!info.isDirectory()) return [];

    const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    await walk(base, normalized);
    return found;
  }

  /**
   * Reports whether the root is writable.
   *
   * The root is created on demand, so a missing directory is not a failure — a
   * root that exists but cannot be written to is, and that is the case an
   * operator needs told about before uploads start failing.
   */
  async check(): Promise<{ ok: boolean; detail: string }> {
    const root = resolve(this.root);

    if (!existsSync(root))
      return { ok: true, detail: 'storage root will be created on first write' };

    try {
      await access(root, constants.W_OK);
      return { ok: true, detail: 'storage root is writable' };
    } catch {
      // The path is included: it is operator-facing configuration, not a secret.
      return { ok: false, detail: `storage root is not writable (${root})` };
    }
  }
}

function metadataOf(blob: StoredBlob): BlobMetadata {
  return {
    key: blob.key,
    contentType: blob.contentType,
    checksum: blob.checksum,
    byteSize: blob.byteSize,
  };
}

function parseMetadata(raw: string, key: string): BlobMetadata {
  try {
    const parsed = JSON.parse(raw) as Partial<BlobMetadata>;
    if (typeof parsed.checksum !== 'string' || typeof parsed.byteSize !== 'number') {
      throw new Error('incomplete');
    }
    return {
      key,
      contentType: parsed.contentType ?? 'application/octet-stream',
      checksum: parsed.checksum,
      byteSize: parsed.byteSize,
    };
  } catch {
    throw new ApiError('internal_error', {
      message: 'Stored content failed its integrity check.',
      context: { reason: 'metadata_unreadable', key },
    });
  }
}
