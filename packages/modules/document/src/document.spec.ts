import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@trustsystem/errors';
import { createTestModuleContext, type RecordingAuditPort } from '@trustsystem/module-sdk';
import { InMemoryStorageProvider, checksumOf } from '@trustsystem/module-file-storage';
import { FakeModelDelegate, runInTenantContext } from '@trustsystem/tenancy';
import { documentConfigSchema } from './config';
import { createDocument, documentModule } from './document.module';
import type { DocumentService } from './document.service';

const ACME = 'org_acme';
const RIVAL = 'org_rival';

const timestamps = {
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
};

interface Harness {
  service: DocumentService;
  audit: RecordingAuditPort;
  storage: InMemoryStorageProvider;
  documents: FakeModelDelegate;
}

const PDF = 'application/pdf';

function buildHarness(config: Record<string, unknown> = {}): Harness {
  const categories = new FakeModelDelegate([
    { id: 'cat_acme', organizationId: ACME, key: 'contracts', name: 'Contracts', ...timestamps },
    {
      id: 'cat_rival',
      organizationId: RIVAL,
      key: 'contracts',
      name: 'Rival contracts',
      ...timestamps,
    },
  ]);

  const documents = new FakeModelDelegate([
    {
      id: 'doc_rival',
      organizationId: RIVAL,
      categoryId: 'cat_rival',
      title: 'Rival contract',
      description: null,
      storageKey: 'org/org_rival/documents/rival.pdf/v1',
      contentType: PDF,
      checksum: checksumOf(Buffer.from('rival')),
      byteSize: 5,
      version: 1,
      ...timestamps,
    },
  ]);

  const versions = new FakeModelDelegate([]);
  const storage = new InMemoryStorageProvider();

  const { context, audit } = createTestModuleContext(documentModule, {
    config,
    prisma: { documentCategory: categories, document: documents, documentVersion: versions },
  });

  const instance = createDocument(context, { storage });
  return { service: instance.service, audit, storage, documents };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

const upload = (harness: Harness, overrides: Record<string, unknown> = {}) =>
  asAcme(() =>
    harness.service.upload(
      {
        title: 'Acme contract',
        name: 'contract.pdf',
        content: Buffer.from('acme contract'),
        contentType: PDF,
        ...overrides,
      },
      ACME,
    ),
  );

describe('document tenant isolation', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('lists only the calling organization documents', async () => {
    await upload(harness);

    expect((await asAcme(() => harness.service.list(ACME))).items.map((row) => row.title)).toEqual([
      'Acme contract',
    ]);
    expect(
      (await asRival(() => harness.service.list(RIVAL))).items.map((row) => row.title),
    ).toEqual(['Rival contract']);
  });

  it('reports another organization document as not_found', async () => {
    try {
      await asAcme(() => harness.service.find('doc_rival', ACME));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('not_found');
    }
  });

  it('cannot download, update, version or retire another organization document', async () => {
    await expect(asAcme(() => harness.service.download('doc_rival', ACME))).rejects.toThrow();
    await expect(
      asAcme(() => harness.service.update('doc_rival', { title: 'Hijacked' }, ACME)),
    ).rejects.toThrow();
    await expect(
      asAcme(() =>
        harness.service.addVersion(
          'doc_rival',
          { content: Buffer.from('x'), contentType: PDF },
          ACME,
        ),
      ),
    ).rejects.toThrow();
    await expect(asAcme(() => harness.service.remove('doc_rival', ACME))).rejects.toThrow();

    expect(harness.documents.snapshot().find((row) => row.id === 'doc_rival')?.title).toBe(
      'Rival contract',
    );
  });

  it('resolves a category key within the calling organization only', async () => {
    // Both organizations have a `contracts` category.
    const document = await upload(harness, { categoryKey: 'contracts' });
    expect(document.categoryId).toBe('cat_acme');
  });

  it('namespaces content keys by organization, under a documents prefix', async () => {
    const document = await upload(harness);

    expect(document.storageKey).toBe(`org/${ACME}/documents/contract.pdf/v1`);
    // The prefix keeps document content from colliding with anything the
    // file-storage module holds directly.
    expect(await harness.storage.list(`org/${ACME}/documents/`)).toHaveLength(1);
    expect(await harness.storage.list(`org/${RIVAL}/`)).toHaveLength(0);
  });

  it('fails closed when there is no tenant context at all', async () => {
    await expect(harness.service.listCategories()).rejects.toThrow(
      /Organization context is required/,
    );
  });

  it('attributes every audit record to the acting organization', async () => {
    await upload(harness);
    await asRival(() =>
      harness.service.createCategory({ key: 'invoices', name: 'Invoices' }, RIVAL),
    );

    expect(harness.audit.records.map((record) => record.organizationId)).toEqual([ACME, RIVAL]);
  });

  it('never writes document content or description into the audit trail', async () => {
    await upload(harness, {
      content: Buffer.from('SALARY: 120000'),
      description: 'Contains the salary schedule',
    });

    const serialized = harness.audit.serialized();
    expect(serialized).not.toContain('SALARY');
    expect(serialized).not.toContain('salary schedule');
  });
});

describe('versioning', () => {
  it('keeps previous versions readable and records the history', async () => {
    const harness = buildHarness();
    const first = await upload(harness);

    const second = await asAcme(() =>
      harness.service.addVersion(
        first.id,
        { content: Buffer.from('revised contract'), contentType: PDF },
        ACME,
      ),
    );

    expect(second.version).toBe(2);
    expect(
      (await harness.storage.get(`org/${ACME}/documents/contract.pdf/v1`)).content.toString(),
    ).toBe('acme contract');
    expect(
      (await harness.storage.get(`org/${ACME}/documents/contract.pdf/v2`)).content.toString(),
    ).toBe('revised contract');

    const history = await asAcme(() => harness.service.versions(first.id, ACME));
    expect(history.map((row) => row.version).sort()).toEqual([1, 2]);
  });

  it('audits a new version without repeating the content', async () => {
    const harness = buildHarness();
    const document = await upload(harness);
    await asAcme(() =>
      harness.service.addVersion(
        document.id,
        { content: Buffer.from('v2 body'), contentType: PDF },
        ACME,
      ),
    );

    const record = harness.audit.byAction('document.version.created')[0];
    expect(record?.after).toMatchObject({ version: 2 });
    expect(JSON.stringify(record)).not.toContain('v2 body');
  });
});

describe('downloads', () => {
  it('verifies content against the checksum on the row', async () => {
    const harness = buildHarness();
    const document = await upload(harness);

    harness.storage.corrupt(document.storageKey, Buffer.from('tampered'));

    await expect(asAcme(() => harness.service.download(document.id, ACME))).rejects.toThrow(
      /integrity check/,
    );
  });

  it('audits a download, because that is the action an investigation asks about', async () => {
    const harness = buildHarness();
    const document = await upload(harness);

    await asAcme(() => harness.service.download(document.id, ACME));
    expect(harness.audit.byAction('document.document.downloaded')).toHaveLength(1);
  });
});

describe('content type allow-list', () => {
  it('refuses a format that is not on the list, by default', async () => {
    const harness = buildHarness();

    // An HTML document served back from a customer-facing endpoint is stored
    // cross-site scripting, so the default allow-list contains only formats that
    // are inert when opened.
    await expect(upload(harness, { contentType: 'text/html' })).rejects.toThrow(/not accepted/);
    await expect(upload(harness, { contentType: 'image/svg+xml' })).rejects.toThrow(/not accepted/);
  });

  it('accepts a format an organization has added', async () => {
    const harness = buildHarness({ allowedContentTypes: ['text/html'] });
    await expect(upload(harness, { contentType: 'text/html' })).resolves.toBeTruthy();
  });

  it('applies the size ceiling', async () => {
    const harness = buildHarness({ maxUploadBytes: 4 });
    await expect(upload(harness)).rejects.toThrow(/exceeds the 4 byte limit/);
  });

  it('refuses an unsafe document name', async () => {
    const harness = buildHarness();
    await expect(upload(harness, { name: 'a/../../escape.pdf' })).rejects.toThrow();
  });
});

describe('categories', () => {
  it('refuses a duplicate key within an organization', async () => {
    const harness = buildHarness();
    await expect(
      asAcme(() => harness.service.createCategory({ key: 'contracts', name: 'Again' }, ACME)),
    ).rejects.toThrow(/already exists/);
  });

  it('refuses an unknown category on upload', async () => {
    const harness = buildHarness();
    await expect(upload(harness, { categoryKey: 'nope' })).rejects.toThrow(/No category with key/);
  });

  it('can be made mandatory per organization', async () => {
    const harness = buildHarness({ requireCategory: true });
    await expect(upload(harness)).rejects.toThrow(/category is required/);
    await expect(upload(harness, { categoryKey: 'contracts' })).resolves.toBeTruthy();
  });

  it('rejects a category filter that does not exist rather than returning everything', async () => {
    const harness = buildHarness();
    // Silently ignoring an unknown filter would return every document to a
    // caller who believed they were looking at one category.
    await expect(asAcme(() => harness.service.list(ACME, { categoryKey: 'nope' }))).rejects.toThrow(
      /No category with key/,
    );
  });
});

describe('soft delete', () => {
  it('hides a retired document but keeps its content', async () => {
    const harness = buildHarness();
    const document = await upload(harness);

    await asAcme(() => harness.service.remove(document.id, ACME));

    expect((await asAcme(() => harness.service.list(ACME))).items).toHaveLength(0);
    // Content is left in place: retention is the application's decision, and
    // deleting bytes would make the version history unopenable.
    expect(await harness.storage.head(document.storageKey)).not.toBe(null);
  });
});

describe('configuration validation', () => {
  it('installs with no configuration at all', () => {
    const parsed = documentConfigSchema.parse({});
    expect(parsed.versioning).toBe(true);
    expect(parsed.allowedContentTypes).toContain('application/pdf');
    expect(parsed.allowedContentTypes).not.toContain('text/html');
  });

  it('rejects an unknown configuration key rather than ignoring it', () => {
    expect(documentConfigSchema.safeParse({ maxUpload: 1 }).success).toBe(false);
  });
});

describe('lifecycle', () => {
  it('refuses to start without a database', async () => {
    const { context } = createTestModuleContext(documentModule, { prisma: null });
    const instance = createDocument(context, { storage: new InMemoryStorageProvider() });

    await expect(instance.initialize()).rejects.toThrow(/needs a database/);
  });

  it('reports storage through a module health indicator', async () => {
    const harness = buildHarness();
    const { context } = createTestModuleContext(documentModule, {
      prisma: { document: harness.documents },
    });
    const instance = createDocument(context, { storage: harness.storage });

    expect(instance.healthIndicator().name).toBe('module:document');
    expect((await instance.healthIndicator().check()).status).toBe('ok');
  });
});
