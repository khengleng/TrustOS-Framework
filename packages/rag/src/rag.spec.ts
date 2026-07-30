import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddingService,
  areComparable,
  cosineSimilarity,
  explainIncomparable,
  score,
  type EmbeddingProvider,
} from '@trustos/embedding';
import { InMemoryVectorStore } from '@trustos/vector-store';
import { assessChunking, chunkText, chunkingStrategySchema } from './chunking';
import { Retriever, checkCitations, formatContext, retrievalOptionsSchema } from './retrieval';

/**
 * A deterministic embedding provider.
 *
 * Hashes words into a fixed-length vector, so texts sharing words are similar and texts sharing
 * none are not. Enough to test retrieval ordering without a real model, and honest about being a
 * fake — it has no semantics, only overlap.
 */
const DIMENSIONS = 64;

const fakeProvider: EmbeddingProvider = {
  key: 'fake',
  embed: async ({ texts }) => ({
    vectors: texts.map((text) => {
      const vector = new Array(DIMENSIONS).fill(0);
      for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
        let hash = 0;
        for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % DIMENSIONS;
        vector[hash] += 1;
      }
      return vector;
    }),
    tokens: texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
  }),
};

const MODEL = {
  id: 'fake.embed',
  provider: 'fake',
  providerModelId: 'fake-1',
  dimensions: DIMENSIONS,
  metric: 'cosine' as const,
};

async function setup() {
  const store = new InMemoryVectorStore();
  const embeddings = new EmbeddingService({ models: [MODEL], providers: [fakeProvider] });

  await store.createCollection({
    id: 'kb',
    organizationId: 'org_1',
    modelId: 'fake.embed',
    dimensions: DIMENSIONS,
    version: '1',
    metric: 'cosine',
  });

  return { store, embeddings, retriever: new Retriever({ store, embeddings }) };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('chunking', () => {
  const strategy = chunkingStrategySchema.parse({ targetChars: 200, overlapFraction: 0.1 });

  it('returns nothing for empty text', () => {
    expect(chunkText('   ')).toEqual([]);
  });

  it('keeps a short document as one chunk', () => {
    expect(chunkText('A short note.', strategy)).toHaveLength(1);
  });

  it('splits on paragraph boundaries before sentence ones', () => {
    // Cutting every N characters puts the answer across a boundary about half the time.
    const text = `${'First paragraph. '.repeat(15)}\n\n${'Second paragraph. '.repeat(15)}`;
    const chunks = chunkText(text, strategy);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.content).not.toContain('Second paragraph');
  });

  it('overlaps neighbours, so a fact spanning a boundary is retrievable', () => {
    const text = `${'alpha '.repeat(40)}\n\n${'beta '.repeat(40)}`;
    const chunks = chunkText(
      text,
      chunkingStrategySchema.parse({ targetChars: 150, overlapFraction: 0.2 }),
    );

    expect(chunks.length).toBeGreaterThan(1);
    // The second chunk carries the tail of the first.
    expect(chunks[1]?.content).toContain('alpha');
  });

  it('carries the heading into each chunk under it', () => {
    // Without it a retrieved chunk reads as context-free prose: "the limit is 5%" with no
    // indication of what the limit applies to.
    const text = `## Refund policy\n\n${'The limit is five per cent. '.repeat(20)}`;
    const chunks = chunkText(text, strategy);

    expect(chunks.every((chunk) => chunk.heading === 'Refund policy')).toBe(true);
    expect(chunks.at(-1)?.content).toContain('Refund policy');
  });

  it('merges a fragment into its neighbour', () => {
    // A 40-character chunk is a heading with no body: it matches queries about its own words and
    // contributes nothing to the answer.
    const text = `${'Body text here. '.repeat(20)}\n\nTiny.`;
    const chunks = chunkText(text, strategy);

    expect(chunks.every((chunk) => chunk.charCount >= 50)).toBe(true);
  });

  it('splits an unbroken run rather than leaving one enormous chunk', () => {
    // A minified file or a base64 blob has no structure to respect; the alternative is a chunk no
    // model can read.
    const chunks = chunkText('x'.repeat(1000), strategy);

    expect(chunks.length).toBeGreaterThan(1);
  });

  it('records offsets, so a citation can point at a place', () => {
    const chunks = chunkText(`${'Sentence one. '.repeat(20)}`, strategy);

    expect(chunks[0]?.startOffset).toBe(0);
    expect(chunks[0]?.endOffset).toBeGreaterThan(0);
  });

  it('reports a document that became one oversized chunk', () => {
    // Retrieval then returns all or nothing of it, which is the worst of both.
    const wide = chunkingStrategySchema.parse({ targetChars: 100, minChars: 1 });
    const problems = assessChunking(
      [
        {
          index: 0,
          content: 'x'.repeat(900),
          startOffset: 0,
          endOffset: 900,
          heading: null,
          charCount: 900,
        },
      ],
      wide,
    );

    expect(problems.join(' ')).toMatch(/one oversized chunk/);
  });

  it('reports a document made almost entirely of fragments', () => {
    // A list or a table: each row matches queries about its own words and contributes nothing.
    const tiny = chunkingStrategySchema.parse({ targetChars: 2000, minChars: 500 });
    const chunks = Array.from({ length: 10 }, (_, index) => ({
      index,
      content: `- item ${index}`,
      startOffset: index * 10,
      endOffset: index * 10 + 9,
      heading: null,
      charCount: 9,
    }));

    expect(assessChunking(chunks, tiny).join(' ')).toMatch(/list or a table, which chunks badly/);
  });

  it('reports an empty document', () => {
    expect(assessChunking([], strategy).join(' ')).toMatch(/produced no chunks/);
  });
});

describe('embedding comparability', () => {
  it('treats vectors from two models as incomparable', () => {
    // Not "less accurate" — meaningless.
    const a = { modelId: 'x', dimensions: 64, version: '1' };
    const b = { modelId: 'y', dimensions: 64, version: '1' };

    expect(areComparable(a, b)).toBe(false);
    expect(explainIncomparable(a, b)).toMatch(/not a weaker signal — it is meaningless/);
  });

  it('catches a provider changing a model in place', () => {
    // The case that is otherwise invisible: old and new vectors coexist and scores between them
    // mean nothing.
    const a = { modelId: 'x', dimensions: 64, version: '1' };
    const b = { modelId: 'x', dimensions: 64, version: '2' };

    expect(explainIncomparable(a, b)).toMatch(/provider changed the model; re-embed/);
  });

  it('scores a zero vector as zero rather than NaN', () => {
    // NaN propagates silently through a ranking and produces an arbitrary order.
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('normalises euclidean so higher is better everywhere', () => {
    // Mixing a distance with similarities in one ranking inverts the results while still
    // producing a plausible-looking list.
    const near = score([1, 0], [1, 0.1], 'euclidean');
    const far = score([1, 0], [-1, 0], 'euclidean');

    expect(near).toBeGreaterThan(far);
  });
});

describe('the embedding service', () => {
  it('refuses a vector whose length does not match the configuration', async () => {
    const wrong: EmbeddingProvider = {
      key: 'fake',
      embed: async ({ texts }) => ({ vectors: texts.map(() => [1, 2, 3]), tokens: 1 }),
    };

    const service = new EmbeddingService({ models: [MODEL], providers: [wrong] });

    await expect(service.embed({ texts: ['a'], modelId: 'fake.embed' })).rejects.toThrow(
      /mixing them in an index makes every similarity score meaningless/,
    );
  });

  it('refuses a provider returning the wrong number of vectors', async () => {
    // Continuing would pair each vector with the wrong text, and the search results would be
    // wrong with no symptom.
    const wrong: EmbeddingProvider = {
      key: 'fake',
      embed: async () => ({ vectors: [new Array(DIMENSIONS).fill(0)], tokens: 1 }),
    };

    const service = new EmbeddingService({ models: [MODEL], providers: [wrong] });

    await expect(service.embed({ texts: ['a', 'b'], modelId: 'fake.embed' })).rejects.toThrow(
      /pair each vector with the wrong text/,
    );
  });

  it('batches according to the model limit', async () => {
    const embed = vi.fn(fakeProvider.embed);
    const service = new EmbeddingService({
      models: [{ ...MODEL, maxBatchSize: 2 }],
      providers: [{ key: 'fake', embed }],
    });

    await service.embed({ texts: ['a', 'b', 'c', 'd', 'e'], modelId: 'fake.embed' });

    expect(embed).toHaveBeenCalledTimes(3);
  });

  it('names what is registered for an unknown model', async () => {
    const service = new EmbeddingService({ models: [MODEL], providers: [fakeProvider] });

    try {
      service.model('nope');
      expect.unreachable();
    } catch (error) {
      // The detail carries the list; `toThrow` only sees the one-line summary.
      const details = (error as { details?: Array<{ message: string }> }).details ?? [];
      expect(details[0]?.message).toMatch(/Registered: fake\.embed/);
    }
  });
});

describe('the vector store', () => {
  it('refuses a record whose vector came from another model', async () => {
    const { store } = await setup();

    await expect(
      store.upsert([
        {
          id: 'x',
          organizationId: 'org_1',
          collectionId: 'kb',
          vector: new Array(DIMENSIONS).fill(1),
          modelId: 'other.model',
          dimensions: DIMENSIONS,
          version: '1',
          content: 'x',
          metadata: {},
          source: { documentId: null, title: null, uri: null, chunkIndex: null },
          createdAt: new Date(),
        },
      ]),
    ).rejects.toThrow(/A vector being written does not match/);
  });

  it('does not return another tenant’s records', async () => {
    const { store, retriever } = await setup();

    await store.createCollection({
      id: 'kb',
      organizationId: 'org_2',
      modelId: 'fake.embed',
      dimensions: DIMENSIONS,
      version: '1',
      metric: 'cosine',
    });

    await retriever.ingest({
      organizationId: 'org_1',
      collectionId: 'kb',
      documentId: 'doc_1',
      title: 'Tenant one policy',
      uri: null,
      content: 'Refunds are processed within five business days.',
    });

    const other = await retriever.retrieve({
      organizationId: 'org_2',
      collectionId: 'kb',
      query: 'refunds',
    });

    expect(other.passages).toEqual([]);
    expect(other.empty).toBe(true);
  });

  it('lets two tenants use the same collection name', async () => {
    const { store } = await setup();

    await expect(
      store.createCollection({
        id: 'kb',
        organizationId: 'org_2',
        modelId: 'fake.embed',
        dimensions: DIMENSIONS,
        version: '1',
        metric: 'cosine',
      }),
    ).resolves.toBeDefined();
  });
});

describe('ingestion', () => {
  it('chunks, embeds and stores a document', async () => {
    const { retriever, store } = await setup();

    const result = await retriever.ingest({
      organizationId: 'org_1',
      collectionId: 'kb',
      documentId: 'doc_1',
      title: 'Refund policy',
      uri: 'https://example.com/refunds',
      content: 'Refunds are processed within five business days of approval.',
    });

    expect(result.chunks).toBe(1);
    expect((await store.getCollection('kb', 'org_1'))?.recordCount).toBe(1);
  });

  it('replaces a document’s old chunks on re-ingestion', async () => {
    /*
     * Without this, a search returns both versions and the model sees contradictory passages —
     * then picks one, usually the one that reads more confidently.
     */
    const { retriever, store } = await setup();

    await retriever.ingest({
      organizationId: 'org_1',
      collectionId: 'kb',
      documentId: 'doc_1',
      title: 'Policy',
      uri: null,
      content: 'Refunds take five days.',
    });

    const second = await retriever.ingest({
      organizationId: 'org_1',
      collectionId: 'kb',
      documentId: 'doc_1',
      title: 'Policy',
      uri: null,
      content: 'Refunds take ten days.',
    });

    expect(second.replaced).toBe(1);
    expect((await store.getCollection('kb', 'org_1'))?.recordCount).toBe(1);
  });

  it('refuses to ingest into a collection that does not exist', async () => {
    const { retriever } = await setup();

    await expect(
      retriever.ingest({
        organizationId: 'org_1',
        collectionId: 'missing',
        documentId: 'd',
        title: null,
        uri: null,
        content: 'x',
      }),
    ).rejects.toThrow(/records which embedding model populates it/);
  });
});

describe('retrieval', () => {
  async function populated() {
    const parts = await setup();

    await parts.retriever.ingest({
      organizationId: 'org_1',
      collectionId: 'kb',
      documentId: 'doc_refunds',
      title: 'Refund policy',
      uri: 'https://example.com/refunds',
      content: `Refunds are processed within five business days of approval by finance. ${'Additional refund detail follows here for length. '.repeat(6)}`,
    });

    await parts.retriever.ingest({
      organizationId: 'org_1',
      collectionId: 'kb',
      documentId: 'doc_shipping',
      title: 'Shipping policy',
      uri: 'https://example.com/shipping',
      content: `Parcels are dispatched the following morning by courier. ${'Additional shipping detail follows here for length. '.repeat(6)}`,
    });

    return parts;
  }

  it('finds the relevant passage', async () => {
    const { retriever } = await populated();

    const result = await retriever.retrieve({
      organizationId: 'org_1',
      collectionId: 'kb',
      query: 'refunds processed business days',
      options: { minScore: 0 },
    });

    expect(result.passages[0]?.documentId).toBe('doc_refunds');
  });

  it('numbers passages from 1, so a marker reads as [1]', async () => {
    const { retriever } = await populated();

    const result = await retriever.retrieve({
      organizationId: 'org_1',
      collectionId: 'kb',
      query: 'refunds',
      options: { minScore: 0 },
    });

    expect(result.passages.map((passage) => passage.citation)).toEqual([1, 2]);
  });

  it('reports empty rather than returning the least-irrelevant passages', async () => {
    /*
     * The honest signal. With no floor, a query about something the collection does not cover
     * still returns passages, and the model — given passages and told to answer from them —
     * produces something.
     */
    const { retriever } = await populated();

    const result = await retriever.retrieve({
      organizationId: 'org_1',
      collectionId: 'kb',
      query: 'quantum chromodynamics lattice gauge',
      options: { minScore: 0.3 },
    });

    expect(result.empty).toBe(true);
    expect(result.context).toBe('');
  });

  it('caps how many chunks come from one document', async () => {
    // Without it, one long document that matches well fills every slot and the answer comes from
    // a single source that may be wrong.
    const { retriever } = await setup();

    await retriever.ingest({
      organizationId: 'org_1',
      collectionId: 'kb',
      documentId: 'doc_long',
      title: 'Long',
      uri: null,
      content: `${'Refund policy paragraph about refunds and approval. '.repeat(30)}`,
      chunking: chunkingStrategySchema.parse({ targetChars: 200 }),
    });

    const result = await retriever.retrieve({
      organizationId: 'org_1',
      collectionId: 'kb',
      query: 'refund approval',
      options: { minScore: 0, maxPerDocument: 2, limit: 10 },
    });

    expect(result.passages.length).toBeLessThanOrEqual(2);
  });

  it('drops rather than trims a passage that will not fit the budget', async () => {
    // Half a passage is a passage whose end is missing, and a model reading it cannot know.
    const { retriever } = await populated();

    const result = await retriever.retrieve({
      organizationId: 'org_1',
      collectionId: 'kb',
      query: 'refunds shipping',
      // 500 is the schema floor; both passages together exceed it once they are long enough.
      options: { minScore: 0, maxContextChars: 500, limit: 10 },
    });

    expect(result.truncated).toBeGreaterThan(0);
    // Nothing was trimmed: every returned passage is whole.
    for (const passage of result.passages) {
      expect(passage.content.endsWith('.')).toBe(true);
    }
  });

  it('filters on metadata', async () => {
    const { retriever } = await setup();

    await retriever.ingest({
      organizationId: 'org_1',
      collectionId: 'kb',
      documentId: 'a',
      title: 'A',
      uri: null,
      content: 'Refund rules for retail customers.',
      metadata: { segment: 'retail' },
    });
    await retriever.ingest({
      organizationId: 'org_1',
      collectionId: 'kb',
      documentId: 'b',
      title: 'B',
      uri: null,
      content: 'Refund rules for wholesale customers.',
      metadata: { segment: 'wholesale' },
    });

    const result = await retriever.retrieve({
      organizationId: 'org_1',
      collectionId: 'kb',
      query: 'refund rules',
      options: { minScore: 0, filter: { segment: 'retail' } },
    });

    expect(result.passages).toHaveLength(1);
    expect(result.passages[0]?.documentId).toBe('a');
  });
});

describe('hybrid search', () => {
  it('fuses keyword hits with vector hits by rank', async () => {
    /*
     * Reciprocal rank fusion rather than a weighted sum: a cosine similarity of 0.7 and a BM25
     * score of 12 cannot be added, and normalising them requires knowing each distribution.
     */
    const { store, embeddings, retriever } = await setup();

    await retriever.ingest({
      organizationId: 'org_1',
      collectionId: 'kb',
      documentId: 'doc_invoice',
      title: 'Invoice INV-99321',
      uri: null,
      content: 'Invoice INV-99321 was settled on the third of March.',
    });

    const keyword = {
      search: async () => {
        const records = await store.search({
          organizationId: 'org_1',
          collectionId: 'kb',
          vector: (await embeddings.embedOne('INV-99321', 'fake.embed')).vector,
          modelId: 'fake.embed',
          dimensions: DIMENSIONS,
          version: '1',
          limit: 5,
        });
        return records.map((hit) => ({ record: hit.record, score: 10 }));
      },
    };

    const hybrid = new Retriever({ store, embeddings, keyword });

    const result = await hybrid.retrieve({
      organizationId: 'org_1',
      collectionId: 'kb',
      query: 'INV-99321',
      options: { minScore: 0 },
    });

    expect(result.passages[0]?.retrievedBy).toBe('both');
  });
});

describe('formatting context', () => {
  const passages = [
    {
      citation: 1,
      content: 'Refunds take five days.',
      score: 0.9,
      documentId: 'doc_1',
      title: 'Refund policy',
      uri: 'https://example.com/r',
      chunkIndex: 0,
      heading: 'Timing',
      retrievedBy: 'vector' as const,
    },
  ];

  it('labels each passage and says what the numbers are for', () => {
    // A citation instruction with no markers in the context produces fabricated citation numbers.
    const context = formatContext(passages);

    expect(context).toContain('[1] Refund policy — Timing');
    expect(context).toContain('Cite them by their number, like [1].');
  });

  it('tells the model to say when the sources do not answer', () => {
    expect(formatContext(passages)).toMatch(/do not fill the gap/);
  });

  it('is empty when there are no passages', () => {
    expect(formatContext([])).toBe('');
  });
});

describe('citation checking', () => {
  const passages = [1, 2, 3].map((citation) => ({
    citation,
    content: 'x',
    score: 1,
    documentId: `d${citation}`,
    title: null,
    uri: null,
    chunkIndex: null,
    heading: null,
    retrievedBy: 'vector' as const,
  }));

  it('detects a fabricated citation', () => {
    // One of the few things about a generated answer that is mechanically checkable.
    const result = checkCitations('As shown in [1] and [7], the limit applies.', passages);

    expect(result.used).toEqual([1]);
    expect(result.fabricated).toEqual([7]);
  });

  it('reports coverage over the supplied passages', () => {
    expect(checkCitations('See [1] and [2].', passages).coverage).toBeCloseTo(2 / 3, 4);
  });

  it('lists passages the answer never used', () => {
    expect(checkCitations('See [1].', passages).uncited).toEqual([2, 3]);
  });

  it('reports zero coverage for an answer with no citations', () => {
    expect(checkCitations('The limit is five per cent.', passages)).toMatchObject({
      used: [],
      coverage: 0,
    });
  });
});

describe('retrieval defaults', () => {
  it('has a score floor, so an uncovered query returns nothing', () => {
    expect(retrievalOptionsSchema.parse({}).minScore).toBe(0.3);
  });

  it('caps per-document chunks by default', () => {
    expect(retrievalOptionsSchema.parse({}).maxPerDocument).toBe(3);
  });
});
