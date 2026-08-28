import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@trustos/errors';
import { createTestModuleContext, type RecordingAuditPort } from '@trustos/module-sdk';
import { FakeModelDelegate, runInTenantContext } from '@trustos/tenancy';
import { fileStorageConfigSchema } from './config';
import { createFileStorage, fileStorageModule } from './file-storage.module';
import type { FileStorageService } from './file-storage.service';
import { InMemoryStorageProvider, LocalStorageProvider, checksumOf } from './provider';

/**
 * The file-storage module.
 *
 * Isolation is proven through the real Prisma-backed store driven by
 * `FakeModelDelegate`, so `scopedDelegate` — the framework's actual isolation
 * mechanism — is exercised rather than a hand-written in-memory filter that
 * would only test itself.
 */

const ACME = 'org_acme';
const RIVAL = 'org_rival';

const timestamps = {
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

interface Harness {
  service: FileStorageService;
  audit: RecordingAuditPort;
  provider: InMemoryStorageProvider;
  objects: FakeModelDelegate;
  versions: FakeModelDelegate;
}

function buildHarness(config: Record<string, unknown> = {}): Harness {
  const objects = new FakeModelDelegate([
    {
      id: 'obj_rival',
      organizationId: RIVAL,
      storageKey: 'org/org_rival/rival.pdf/v1',
      name: 'rival.pdf',
      contentType: 'application/pdf',
      checksum: checksumOf(Buffer.from('rival')),
      byteSize: 5,
      version: 1,
      ...timestamps,
    },
  ]);
  const versions = new FakeModelDelegate([]);
  const provider = new InMemoryStorageProvider();

  const { context, audit } = createTestModuleContext(fileStorageModule, {
    config,
    prisma: { storedObject: objects, storedObjectVersion: versions },
  });

  const instance = createFileStorage(context, { provider });
  return { service: instance.service, audit, provider, objects, versions };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

const bytes = (value: string): Buffer => Buffer.from(value, 'utf8');

describe('file-storage tenant isolation', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('lists only the calling organization objects', async () => {
    await asAcme(() =>
      harness.service.store(
        { name: 'acme.pdf', content: bytes('acme'), contentType: 'application/pdf' },
        ACME,
      ),
    );

    const acme = await asAcme(() => harness.service.list(ACME));
    expect(acme.items.map((row) => row.name)).toEqual(['acme.pdf']);

    const rival = await asRival(() => harness.service.list(RIVAL));
    expect(rival.items.map((row) => row.name)).toEqual(['rival.pdf']);
  });

  it('reports another organization object as not_found', async () => {
    try {
      await asAcme(() => harness.service.metadata('obj_rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('cannot read another organization content', async () => {
    await expect(asAcme(() => harness.service.read('obj_rival', ACME))).rejects.toThrow();
  });

  it('cannot retire another organization object', async () => {
    await expect(asAcme(() => harness.service.remove('obj_rival', ACME))).rejects.toThrow();
    expect(harness.objects.snapshot().find((row) => row.id === 'obj_rival')?.deletedAt).toBe(null);
  });

  it('cannot read another organization version history', async () => {
    await expect(asAcme(() => harness.service.versions('obj_rival', ACME))).rejects.toThrow();
  });

  it('namespaces stored keys by organization', async () => {
    const stored = await asAcme(() =>
      harness.service.store(
        { name: 'a.pdf', content: bytes('a'), contentType: 'text/plain' },
        ACME,
      ),
    );

    expect(stored.storageKey.startsWith(`org/${ACME}/`)).toBe(true);
    expect(await harness.service.keys(ACME)).toEqual(['org/org_acme/a.pdf/v1']);
    expect(await harness.service.keys(RIVAL)).toEqual([]);
  });

  it('lets two organizations use the same object name without collision', async () => {
    await asAcme(() =>
      harness.service.store(
        { name: 'shared.pdf', content: bytes('acme'), contentType: 'text/plain' },
        ACME,
      ),
    );
    await asRival(() =>
      harness.service.store(
        { name: 'shared.pdf', content: bytes('rival'), contentType: 'text/plain' },
        RIVAL,
      ),
    );

    const acmeBlob = await harness.provider.get(`org/${ACME}/shared.pdf/v1`);
    const rivalBlob = await harness.provider.get(`org/${RIVAL}/shared.pdf/v1`);
    expect(acmeBlob.content.toString()).toBe('acme');
    expect(rivalBlob.content.toString()).toBe('rival');
  });

  it('fails closed when there is no tenant context at all', async () => {
    await expect(harness.service.list(ACME)).rejects.toThrow(/Organization context is required/);
  });

  it('attributes every audit record to the acting organization', async () => {
    await asAcme(() =>
      harness.service.store(
        { name: 'a.pdf', content: bytes('a'), contentType: 'text/plain' },
        ACME,
      ),
    );
    await asRival(() =>
      harness.service.store(
        { name: 'b.pdf', content: bytes('b'), contentType: 'text/plain' },
        RIVAL,
      ),
    );

    expect(harness.audit.records.map((record) => record.organizationId)).toEqual([ACME, RIVAL]);
  });

  it('never writes object content into the audit trail', async () => {
    const stored = await asAcme(() =>
      harness.service.store(
        { name: 'secret.txt', content: bytes('BEGIN PRIVATE KEY'), contentType: 'text/plain' },
        ACME,
      ),
    );
    await asAcme(() => harness.service.read(stored.id, ACME));

    // An audit trail that carries payloads is a second copy of the data with
    // different access controls.
    expect(harness.audit.serialized()).not.toContain('BEGIN PRIVATE KEY');
    expect(harness.audit.byAction('file-storage.object.read')).toHaveLength(1);
  });
});

describe('versioning', () => {
  it('keeps previous versions readable', async () => {
    const harness = buildHarness();

    const first = await asAcme(() =>
      harness.service.store(
        { name: 'a.txt', content: bytes('one'), contentType: 'text/plain' },
        ACME,
      ),
    );
    const second = await asAcme(() =>
      harness.service.store(
        { name: 'a.txt', content: bytes('two'), contentType: 'text/plain' },
        ACME,
      ),
    );

    expect(first.id).toBe(second.id);
    expect(second.version).toBe(2);

    // The point of versioning: v1 is still there.
    expect((await harness.provider.get(`org/${ACME}/a.txt/v1`)).content.toString()).toBe('one');
    expect((await harness.provider.get(`org/${ACME}/a.txt/v2`)).content.toString()).toBe('two');

    const history = await asAcme(() => harness.service.versions(second.id, ACME));
    expect(history.map((row) => row.version).sort()).toEqual([1, 2]);
  });

  it('overwrites in place when versioning is off', async () => {
    const harness = buildHarness({ versioning: false });

    await asAcme(() =>
      harness.service.store(
        { name: 'a.txt', content: bytes('one'), contentType: 'text/plain' },
        ACME,
      ),
    );
    await asAcme(() =>
      harness.service.store(
        { name: 'a.txt', content: bytes('two'), contentType: 'text/plain' },
        ACME,
      ),
    );

    expect((await harness.provider.get(`org/${ACME}/a.txt`)).content.toString()).toBe('two');
    expect(await harness.provider.list(`org/${ACME}/`)).toHaveLength(1);
  });
});

describe('integrity', () => {
  it('refuses corrupted content and audits the mismatch', async () => {
    const harness = buildHarness();
    const stored = await asAcme(() =>
      harness.service.store(
        { name: 'a.txt', content: bytes('good'), contentType: 'text/plain' },
        ACME,
      ),
    );

    harness.provider.corrupt(stored.storageKey, bytes('tampered'));

    // Returning corrupt bytes silently is the one outcome that must not happen:
    // whatever consumes them cannot tell, and the corruption propagates.
    await expect(asAcme(() => harness.service.read(stored.id, ACME))).rejects.toThrow(
      /integrity check/,
    );

    expect(harness.audit.byAction('file-storage.object.checksum-mismatch')).toHaveLength(1);
  });
});

describe('limits and validation', () => {
  it('rejects an empty object', async () => {
    const harness = buildHarness();
    await expect(
      asAcme(() =>
        harness.service.store(
          { name: 'a.txt', content: Buffer.alloc(0), contentType: 'text/plain' },
          ACME,
        ),
      ),
    ).rejects.toThrow(/empty/);
  });

  it('applies the size ceiling', async () => {
    const harness = buildHarness({ maxBytes: 8 });
    await expect(
      asAcme(() =>
        harness.service.store(
          { name: 'a.txt', content: bytes('far too long'), contentType: 'text/plain' },
          ACME,
        ),
      ),
      // An upload endpoint with no size limit is a disk-exhaustion primitive
      // available to anyone who can authenticate.
    ).rejects.toThrow(/exceeds the 8 byte limit/);
  });

  it('applies a content-type allow-list when the application sets one', async () => {
    const harness = buildHarness({ allowedContentTypes: ['application/pdf'] });

    await expect(
      asAcme(() =>
        harness.service.store(
          { name: 'a.txt', content: bytes('a'), contentType: 'text/html' },
          ACME,
        ),
      ),
    ).rejects.toThrow(/not accepted/);
  });

  it('rejects an unsafe object name', async () => {
    const harness = buildHarness();
    await expect(
      asAcme(() =>
        harness.service.store(
          { name: '../../etc/passwd', content: bytes('a'), contentType: 'text/plain' },
          ACME,
        ),
      ),
    ).rejects.toThrow(/not valid/);
  });
});

describe('per-organization configuration', () => {
  it('applies a tenant override without changing another tenant limits', async () => {
    const harness = buildHarness({ maxBytes: 1024 });
    const { context, audit } = createTestModuleContext(fileStorageModule, {
      config: { maxBytes: 1024 },
      prisma: { storedObject: harness.objects, storedObjectVersion: harness.versions },
    });
    await context.tenantSettings.write('file-storage', ACME, { maxBytes: 4 });

    const service = createFileStorage(context, { provider: harness.provider }).service;

    await expect(
      asAcme(() =>
        service.store(
          { name: 'a.txt', content: bytes('too long'), contentType: 'text/plain' },
          ACME,
        ),
      ),
    ).rejects.toThrow(/4 byte limit/);

    await expect(
      asRival(() =>
        service.store(
          { name: 'b.txt', content: bytes('fine here'), contentType: 'text/plain' },
          RIVAL,
        ),
      ),
    ).resolves.toBeTruthy();

    expect(audit.records.length).toBeGreaterThan(0);
  });
});

describe('configuration validation', () => {
  it('installs with no configuration at all', () => {
    expect(fileStorageConfigSchema.parse({})).toMatchObject({
      root: '.trustos-storage',
      versioning: true,
    });
  });

  it('rejects a size ceiling outside the permitted range', () => {
    expect(fileStorageConfigSchema.safeParse({ maxBytes: 0 }).success).toBe(false);
    expect(fileStorageConfigSchema.safeParse({ maxBytes: 2 ** 40 }).success).toBe(false);
  });

  it('rejects an unknown configuration key rather than ignoring it', () => {
    // A typo in a deployment's configuration should fail loudly, not silently
    // leave the default in place.
    expect(fileStorageConfigSchema.safeParse({ maxByte: 10 }).success).toBe(false);
  });
});

describe('lifecycle', () => {
  it('refuses to start without a database', async () => {
    const { context } = createTestModuleContext(fileStorageModule, { prisma: null });
    const instance = createFileStorage(context, { provider: new InMemoryStorageProvider() });

    await expect(instance.initialize()).rejects.toThrow(/needs a database/);
  });

  it('reports the provider through a module health indicator', async () => {
    const harness = buildHarness();
    const { context } = createTestModuleContext(fileStorageModule, {
      prisma: { storedObject: harness.objects, storedObjectVersion: harness.versions },
    });
    const instance = createFileStorage(context, { provider: harness.provider });

    const indicator = instance.healthIndicator();
    expect(indicator.name).toBe('module:file-storage');
    // Non-critical: a storage problem should show in the report, not take the
    // whole instance out of rotation.
    expect(indicator.critical).toBe(false);
    expect((await indicator.check()).status).toBe('ok');
  });
});

describe('LocalStorageProvider', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'trustos-storage-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips content with its checksum', async () => {
    const provider = new LocalStorageProvider(root);
    const metadata = await provider.put({
      key: 'org/org_acme/a.txt',
      content: bytes('hello'),
      contentType: 'text/plain',
    });

    expect(metadata.checksum).toBe(checksumOf(bytes('hello')));

    const blob = await provider.get('org/org_acme/a.txt');
    expect(blob.content.toString()).toBe('hello');
    expect(blob.contentType).toBe('text/plain');
  });

  it('never writes outside the storage root', async () => {
    const provider = new LocalStorageProvider(root);
    await expect(
      provider.put({ key: '../escaped.txt', content: bytes('x'), contentType: 'text/plain' }),
    ).rejects.toThrow();
  });

  it('does not report sidecars as objects', async () => {
    const provider = new LocalStorageProvider(root);
    await provider.put({
      key: 'org/org_acme/a.txt',
      content: bytes('x'),
      contentType: 'text/plain',
    });

    expect(await provider.list('org/org_acme')).toEqual(['org/org_acme/a.txt']);
  });

  it('reports a missing object rather than an empty one', async () => {
    const provider = new LocalStorageProvider(root);
    expect(await provider.head('org/org_acme/missing.txt')).toBe(null);
    await expect(provider.get('org/org_acme/missing.txt')).rejects.toThrow();
  });

  it('reports the root as writable', async () => {
    const provider = new LocalStorageProvider(root);
    await provider.put({
      key: 'org/org_acme/a.txt',
      content: bytes('x'),
      contentType: 'text/plain',
    });

    expect(await provider.check()).toEqual({ ok: true, detail: 'storage root is writable' });
  });
});
