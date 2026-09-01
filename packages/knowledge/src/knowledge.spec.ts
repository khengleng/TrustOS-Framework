import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryVectorStore } from '@trustsystem/vector-store';
import { KnowledgeService } from './knowledge';
import { InMemoryKnowledgeStore } from './testing';

let clock = new Date('2026-10-15T10:00:00Z');
let counter = 0;

function setup() {
  const store = new InMemoryKnowledgeStore();
  const vectors = new InMemoryVectorStore(() => clock);
  const audit = { record: vi.fn() };

  const service = new KnowledgeService({
    store,
    vectors,
    audit,
    now: () => clock,
    newId: (prefix) => `${prefix}_${++counter}`,
  });

  return { store, vectors, audit, service };
}

async function collection(service: KnowledgeService, overrides: Record<string, unknown> = {}) {
  return service.createCollection({
    id: 'policies',
    organizationId: 'org_1',
    name: 'Company policies',
    embeddingModelId: 'fake.embed',
    dimensions: 8,
    actorId: 'usr_1',
    ...overrides,
  });
}

beforeEach(() => {
  clock = new Date('2026-10-15T10:00:00Z');
  counter = 0;
});

describe('collections', () => {
  it('defaults to restricted, not organization-wide', async () => {
    // Defaulting open would make every new collection readable by every user of the tenant until
    // somebody noticed.
    const { service } = setup();

    expect((await collection(service)).visibility).toBe('restricted');
  });

  it('creates the matching vector collection, so a mismatch is detectable from either side', async () => {
    const { service, vectors } = setup();
    await collection(service);

    expect(await vectors.getCollection('policies', 'org_1')).toMatchObject({
      modelId: 'fake.embed',
      dimensions: 8,
    });
  });

  it('audits creation with the visibility', async () => {
    const { service, audit } = setup();
    await collection(service, { visibility: 'organization' });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rag.collection.created',
        after: expect.objectContaining({ visibility: 'organization' }),
      }),
    );
  });
});

describe('access control', () => {
  it('lets any tenant user read an organization-wide collection', async () => {
    const { service } = setup();
    const target = await collection(service, { visibility: 'organization' });

    expect(service.canRead(target, { organizationId: 'org_1', roles: [] }).allowed).toBe(true);
  });

  it('refuses a restricted collection without the role, and says which role is needed', async () => {
    // "Forbidden" is a support ticket; "you do not have the compliance role" is actionable.
    const { service } = setup();
    const target = await collection(service, {
      visibility: 'restricted',
      allowedRoles: ['compliance'],
    });

    const result = service.canRead(target, { organizationId: 'org_1', roles: ['support'] });

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/requires one of these roles: compliance/);
  });

  it('explains why a knowledge base is an access-control surface', async () => {
    const { service } = setup();
    const target = await collection(service, { allowedRoles: ['compliance'] });

    expect(service.canRead(target, { organizationId: 'org_1', roles: [] }).reason).toMatch(
      /can quote to whoever it is talking to/,
    );
  });

  it('lets a named agent read a restricted collection', async () => {
    const { service } = setup();
    const target = await collection(service, {
      allowedRoles: ['compliance'],
      allowedAgentIds: ['policy-assistant'],
    });

    expect(
      service.canRead(target, { organizationId: 'org_1', roles: [], agentId: 'policy-assistant' })
        .allowed,
    ).toBe(true);
  });

  it('refuses a person direct access to an agent-only collection', async () => {
    const { service } = setup();
    const target = await collection(service, {
      visibility: 'agent_only',
      allowedAgentIds: ['researcher'],
    });

    expect(
      service.canRead(target, { organizationId: 'org_1', roles: ['administrator'] }),
    ).toMatchObject({
      allowed: false,
    });
    expect(
      service.canRead(target, { organizationId: 'org_1', roles: [], agentId: 'researcher' })
        .allowed,
    ).toBe(true);
  });

  it('refuses another tenant outright', async () => {
    const { service } = setup();
    const target = await collection(service, { visibility: 'organization' });

    expect(service.canRead(target, { organizationId: 'org_2', roles: [] }).allowed).toBe(false);
  });

  it('reports a cross-tenant collection as not found rather than forbidden', async () => {
    // Confirming it exists tells a caller about another tenant's collections.
    const { service } = setup();
    await collection(service);

    await expect(
      service.requireReadable('policies', { organizationId: 'org_2', roles: [] }),
    ).rejects.toThrow(/No knowledge collection/);
  });

  it('does not list collections the caller cannot read', async () => {
    const { service } = setup();
    await collection(service, { id: 'open', visibility: 'organization' });
    await collection(service, { id: 'secret', visibility: 'restricted', allowedRoles: ['legal'] });

    const listed = await service.listCollections({ organizationId: 'org_1', roles: [] });

    expect(listed.map((entry) => entry.id)).toEqual(['open']);
  });

  it('reports which collections an agent may search', async () => {
    const { service } = setup();
    await collection(service, { id: 'a', allowedAgentIds: ['researcher'] });
    await collection(service, { id: 'b', allowedRoles: ['legal'] });

    expect(await service.searchableBy('researcher', 'org_1')).toEqual(['a']);
  });
});

describe('documents', () => {
  it('stores a document and bumps the version', async () => {
    const { service } = setup();
    await collection(service);

    const first = await service.putDocument({
      collectionId: 'policies',
      organizationId: 'org_1',
      id: 'doc_1',
      title: 'Refund policy',
      content: 'Refunds take five days.',
      actorId: 'usr_1',
    });

    const second = await service.putDocument({
      collectionId: 'policies',
      organizationId: 'org_1',
      id: 'doc_1',
      title: 'Refund policy',
      content: 'Refunds take ten days.',
      actorId: 'usr_1',
    });

    expect(first.document.version).toBe(1);
    expect(second.document.version).toBe(2);
  });

  it('does not re-embed unchanged content', async () => {
    // A nightly sync of a thousand documents where three changed should cost three embeddings.
    const { service } = setup();
    await collection(service);

    const input = {
      collectionId: 'policies',
      organizationId: 'org_1' as string | null,
      id: 'doc_1',
      title: 'Refund policy',
      content: 'Refunds take five days.',
      actorId: 'usr_1' as string | null,
    };

    await service.putDocument(input);
    const second = await service.putDocument(input);

    expect(second.changed).toBe(false);
    expect(second.document.version).toBe(1);
  });

  it('audits the title and version, never the content', async () => {
    // A knowledge document can be a contract.
    const { service, audit } = setup();
    await collection(service);

    await service.putDocument({
      collectionId: 'policies',
      organizationId: 'org_1',
      title: 'Contract',
      content: 'The confidential settlement amount is 4,500,000 USD.',
      actorId: 'usr_1',
    });

    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('4,500,000');
  });

  it('refuses a document for a collection that does not exist', async () => {
    const { service } = setup();

    await expect(
      service.putDocument({
        collectionId: 'nope',
        organizationId: 'org_1',
        title: 'x',
        content: 'y',
        actorId: null,
      }),
    ).rejects.toThrow(/No knowledge collection/);
  });
});

describe('removal', () => {
  it('removes the vectors as well as the document', async () => {
    /*
     * A document removed from the catalogue but left in the index is still retrievable and still
     * quotable — the exact failure a deletion request is meant to prevent.
     */
    const { service, vectors, store } = setup();
    await collection(service);

    await service.putDocument({
      collectionId: 'policies',
      organizationId: 'org_1',
      id: 'doc_1',
      title: 'Refund policy',
      content: 'Refunds take five days.',
      actorId: 'usr_1',
    });

    await vectors.upsert([
      {
        id: 'doc_1:0',
        organizationId: 'org_1',
        collectionId: 'policies',
        vector: new Array(8).fill(1),
        modelId: 'fake.embed',
        dimensions: 8,
        version: '1',
        content: 'Refunds take five days.',
        metadata: {},
        source: { documentId: 'doc_1', title: 'Refund policy', uri: null, chunkIndex: 0 },
        createdAt: clock,
      },
    ]);

    const result = await service.removeDocument('doc_1', 'org_1', 'usr_1');

    expect(result).toMatchObject({ removed: true, vectorsRemoved: 1 });
    expect(store.documents.size).toBe(0);
    expect((await vectors.getCollection('policies', 'org_1'))?.recordCount).toBe(0);
  });

  it('is a no-op for a document that does not exist', async () => {
    const { service } = setup();

    expect(await service.removeDocument('nope', 'org_1', null)).toMatchObject({ removed: false });
  });
});

describe('expiry', () => {
  it('treats an explicitly expired document as no longer current', async () => {
    const { service } = setup();
    const target = await collection(service);

    const { document } = await service.putDocument({
      collectionId: 'policies',
      organizationId: 'org_1',
      title: 'Q3 price list',
      content: 'Prices for the third quarter.',
      expiresAt: new Date('2026-10-01T00:00:00Z'),
      actorId: 'usr_1',
    });

    expect(service.isCurrent(document, target)).toBe(false);
  });

  it('applies the collection age rule', async () => {
    // A policy from three years ago is worse than no policy: the model quotes it with the same
    // confidence and nothing in the answer says the source was stale.
    const { service } = setup();
    const target = await collection(service, { maxDocumentAgeDays: 30 });

    const { document } = await service.putDocument({
      collectionId: 'policies',
      organizationId: 'org_1',
      title: 'Old policy',
      content: 'Something from a while ago.',
      actorId: 'usr_1',
    });

    clock = new Date('2026-12-01T10:00:00Z');

    expect(service.isCurrent(document, target)).toBe(false);
  });

  it('purges expired documents and their vectors', async () => {
    const { service } = setup();
    await collection(service);

    await service.putDocument({
      collectionId: 'policies',
      organizationId: 'org_1',
      title: 'Expired notice',
      content: 'x',
      expiresAt: new Date('2026-10-01T00:00:00Z'),
      actorId: 'usr_1',
    });

    const result = await service.purgeExpired('org_1');

    expect(result.documents).toBe(1);
    expect(result.titles).toEqual(['Expired notice']);
  });

  it('keeps a current document', async () => {
    const { service } = setup();
    const target = await collection(service);

    const { document } = await service.putDocument({
      collectionId: 'policies',
      organizationId: 'org_1',
      title: 'Current policy',
      content: 'x',
      actorId: 'usr_1',
    });

    expect(service.isCurrent(document, target)).toBe(true);
  });
});
