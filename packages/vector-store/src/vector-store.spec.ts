import { describe, expect, it } from 'vitest';
import { assertComparable, InMemoryVectorStore, vectorRecordSchema } from './index';

/**
 * The vector store port and its in-memory implementation.
 *
 * The in-memory store is what every retrieval test in the framework searches against, so a bug
 * here is a bug that makes *other packages'* tests pass. Two properties matter most: it refuses a
 * vector from the wrong model, and it scopes every search by tenant — an unscoped search that
 * returned another organization's documents would be a disclosure with an embedding in front of
 * it.
 */

const MODEL = { modelId: 'text-embedding-3-small', dimensions: 3, version: '1' };

const collection = { id: 'invoices', ...MODEL };

const record = (
  id: string,
  organizationId: string,
  vector: number[],
  content: string,
  metadata: Record<string, string> = {},
) =>
  vectorRecordSchema.parse({
    id,
    organizationId,
    collectionId: 'invoices',
    vector,
    ...MODEL,
    content,
    metadata,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
  });

describe('comparability', () => {
  it('accepts a vector from the collection’s own model', () => {
    expect(() => assertComparable(collection, MODEL, 'record')).not.toThrow();
  });

  it('refuses a vector from a different model, on write and on search', () => {
    /*
     * The same check guards both, and the advice differs: a bad write must not enter the index at
     * all, while a bad search is a caller using the wrong model. Both refuse.
     */
    const other = { ...MODEL, modelId: 'text-embedding-3-large' };

    expect(() => assertComparable(collection, other, 'record')).toThrow();
    expect(() => assertComparable(collection, other, 'query')).toThrow();
  });

  it('refuses a vector of the wrong dimensions', () => {
    expect(() => assertComparable(collection, { ...MODEL, dimensions: 768 }, 'record')).toThrow();
  });

  it('refuses a vector from a different version of the same model', () => {
    // A provider can change a model's output without changing its name.
    expect(() => assertComparable(collection, { ...MODEL, version: '2' }, 'query')).toThrow();
  });
});

describe('records', () => {
  it('accepts a well-formed record', () => {
    expect(record('doc-1', 'org_a', [1, 0, 0], 'Invoice 001').id).toBe('doc-1');
  });

  it('requires an organization rather than defaulting one', () => {
    // A record with no tenant cannot be scoped out of another tenant's search.
    expect(() =>
      vectorRecordSchema.parse({
        id: 'doc-1',
        collectionId: 'invoices',
        vector: [1, 0, 0],
        ...MODEL,
        content: 'x',
        createdAt: new Date(),
      }),
    ).toThrow();
  });

  it('refuses an empty vector', () => {
    expect(() =>
      vectorRecordSchema.parse({
        id: 'doc-1',
        organizationId: 'org_a',
        collectionId: 'invoices',
        vector: [],
        ...MODEL,
        content: 'x',
        createdAt: new Date(),
      }),
    ).toThrow();
  });

  it('refuses nested metadata', () => {
    /*
     * Flat scalars only. A nested structure is filterable in some vector databases and not others,
     * so permitting it would produce an abstraction that works on one backend and fails on the
     * next.
     */
    expect(() =>
      vectorRecordSchema.parse({
        id: 'doc-1',
        organizationId: 'org_a',
        collectionId: 'invoices',
        vector: [1, 0, 0],
        ...MODEL,
        content: 'x',
        metadata: { nested: { a: 1 } },
        createdAt: new Date(),
      }),
    ).toThrow();
  });
});

describe('the in-memory store', () => {
  const now = () => new Date('2026-07-01T00:00:00.000Z');

  async function seeded() {
    const store = new InMemoryVectorStore(now);

    await store.createCollection({
      id: 'invoices',
      organizationId: 'org_a',
      ...MODEL,
      metric: 'cosine',
    });

    await store.createCollection({
      id: 'invoices',
      organizationId: 'org_b',
      ...MODEL,
      metric: 'cosine',
    });

    await store.upsert([
      record('a', 'org_a', [1, 0, 0], 'Acme invoice', { kind: 'invoice' }),
      record('b', 'org_a', [0, 1, 0], 'Acme receipt', { kind: 'receipt' }),
      record('c', 'org_b', [1, 0, 0], 'Rival invoice', { kind: 'invoice' }),
    ]);

    return store;
  }

  const query = (organizationId: string, extra: Record<string, unknown> = {}) => ({
    organizationId,
    collectionId: 'invoices',
    vector: [1, 0, 0],
    ...MODEL,
    ...extra,
  });

  it('returns the nearest record first', async () => {
    const hits = await (await seeded()).search(query('org_a'));

    expect(hits[0]?.record.id).toBe('a');
  });

  it('never returns another organization’s records', async () => {
    /*
     * The quietest failure available here: record `c` is an *exact* match for the query vector, so
     * an unscoped search would rank it first and the results would look perfectly correct.
     */
    const hits = await (await seeded()).search(query('org_a', { limit: 10 }));

    expect(hits.map((hit) => hit.record.id)).not.toContain('c');
  });

  it('honours the limit', async () => {
    expect(await (await seeded()).search(query('org_a', { limit: 1 }))).toHaveLength(1);
  });

  it('filters on metadata', async () => {
    const hits = await (await seeded()).search(query('org_a', { filter: { kind: 'receipt' } }));

    expect(hits.map((hit) => hit.record.id)).toEqual(['b']);
  });

  it('drops hits below the minimum score', async () => {
    // `b` is orthogonal to the query, so it scores 0 and should not survive a floor.
    const hits = await (await seeded()).search(query('org_a', { minScore: 0.5, limit: 10 }));

    expect(hits.map((hit) => hit.record.id)).toEqual(['a']);
  });

  it('replaces a record on upsert rather than duplicating it', async () => {
    const store = await seeded();

    await store.upsert([record('a', 'org_a', [1, 0, 0], 'Acme invoice, corrected')]);

    const hits = await store.search(query('org_a', { limit: 10 }));

    expect(hits.filter((hit) => hit.record.id === 'a')).toHaveLength(1);
    expect(hits.find((hit) => hit.record.id === 'a')?.record.content).toBe(
      'Acme invoice, corrected',
    );
  });

  it('refuses a search whose vector does not match the collection', async () => {
    const store = await seeded();

    await expect(
      store.search(query('org_a', { modelId: 'text-embedding-3-large' })),
    ).rejects.toThrow();
  });

  it('deletes only within the calling tenant', async () => {
    const store = await seeded();

    const removed = await store.delete(['c'], 'org_a', 'invoices');

    expect(removed).toBe(0);
    expect((await store.search(query('org_b', { limit: 10 }))).map((hit) => hit.record.id)).toEqual(
      ['c'],
    );
  });

  it('removes every chunk of a document on re-ingestion', async () => {
    const store = new InMemoryVectorStore(now);

    await store.createCollection({
      id: 'invoices',
      organizationId: 'org_a',
      ...MODEL,
      metric: 'cosine',
    });

    await store.upsert([
      vectorRecordSchema.parse({
        id: 'chunk-1',
        organizationId: 'org_a',
        collectionId: 'invoices',
        vector: [1, 0, 0],
        ...MODEL,
        content: 'first half',
        source: { documentId: 'doc-9' },
        createdAt: now(),
      }),
      vectorRecordSchema.parse({
        id: 'chunk-2',
        organizationId: 'org_a',
        collectionId: 'invoices',
        vector: [0, 1, 0],
        ...MODEL,
        content: 'second half',
        source: { documentId: 'doc-9' },
        createdAt: now(),
      }),
    ]);

    expect(await store.deleteByDocument('doc-9', 'org_a', 'invoices')).toBe(2);
  });

  it('lists and deletes collections per tenant', async () => {
    const store = await seeded();

    expect(await store.listCollections('org_a')).toHaveLength(1);
    expect(await store.getCollection('invoices', 'org_a')).not.toBeNull();
    expect(await store.deleteCollection('invoices', 'org_a')).toBe(true);
    expect(await store.getCollection('invoices', 'org_a')).toBeNull();
    // The other tenant's collection of the same name is untouched.
    expect(await store.getCollection('invoices', 'org_b')).not.toBeNull();
  });
});
