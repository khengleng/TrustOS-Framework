import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import type { LoggerPort } from '@trustsystem/logging';
import type { EmbeddingService } from '@trustsystem/embedding';
import type { VectorRecord, VectorSearchHit, VectorStore } from '@trustsystem/vector-store';
import { chunkText, chunkingStrategySchema, type ChunkingStrategy } from './chunking';

/**
 * Retrieval.
 *
 * Finding the passages that should inform an answer, and — just as important — recording where
 * each came from so the answer can cite it.
 *
 * **Citations are not a nicety.** They are the only practical way a person can check whether a
 * generated answer is grounded. An answer with no sources is unverifiable; an answer whose sources
 * do not say what it claims is checkable in seconds. Everything here carries provenance from the
 * vector record through to the rendered context, because a citation added afterwards is a citation
 * somebody guessed.
 *
 * **On hybrid search.** The interface accommodates a keyword search alongside the vector search,
 * because vector search alone misses exact identifiers — an invoice number, a product code, an
 * error string. The framework ships the *fusion*, not the keyword index: full-text search belongs
 * to whatever database a deployment already runs.
 */

export const retrievalOptionsSchema = z
  .object({
    /** How many passages to retrieve. */
    limit: z.number().int().min(1).max(100).default(8),

    /**
     * Hits below this are dropped.
     *
     * 0.3 for cosine. The number matters: with no floor, a query about something the collection
     * does not cover still returns the eight least-irrelevant passages, and the model — given
     * passages and told to answer from them — produces something. A floor turns that into an
     * honest "nothing relevant was found".
     */
    minScore: z.number().min(-1).max(1).default(0.3),

    /**
     * Ceiling on the retrieved context, in characters.
     *
     * Retrieval that fills the window leaves no room for the conversation, and the failure is a
     * context-overflow error rather than a bad answer — which is at least visible, but avoidable.
     */
    maxContextChars: z.number().int().min(500).max(500_000).default(20_000),

    /** Equality filters on chunk metadata. */
    filter: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),

    /**
     * At most this many chunks from any one document.
     *
     * Without it, one long document that happens to match well fills every slot, and the answer
     * is drawn from a single source that may be wrong. Diversity is a hedge against that.
     */
    maxPerDocument: z.number().int().min(1).max(50).default(3),
  })
  .strict();

export type RetrievalOptions = z.infer<typeof retrievalOptionsSchema>;

export interface RetrievedPassage {
  /** Numbered from 1, so a citation marker reads as `[1]` rather than `[0]`. */
  citation: number;
  content: string;
  score: number;
  documentId: string | null;
  title: string | null;
  uri: string | null;
  chunkIndex: number | null;
  heading: string | null;
  /** Which retrieval found it. Useful when hybrid search is in play. */
  retrievedBy: 'vector' | 'keyword' | 'both';
}

export interface RetrievalResult {
  passages: RetrievedPassage[];
  /** The formatted block to put in a prompt, with citation markers. */
  context: string;
  /** Every source, deduplicated, for rendering a reference list. */
  sources: Array<{
    citation: number;
    title: string | null;
    uri: string | null;
    documentId: string | null;
  }>;

  /** True when nothing cleared the score floor. The honest "I do not know" signal. */
  empty: boolean;
  /** Passages dropped because the context limit was reached. */
  truncated: number;
  /** What the retrieval cost, so RAG's cost is visible rather than hidden in the completion. */
  embeddingTokens: number;
  embeddingCostCents: number;
}

/** A keyword search a deployment supplies. The framework ships no full-text index. */
export interface KeywordSearch {
  search(input: {
    organizationId: string | null;
    collectionId: string;
    query: string;
    limit: number;
    filter?: Record<string, string | number | boolean | null>;
  }): Promise<Array<{ record: VectorRecord; score: number }>>;
}

export interface RetrieverOptions {
  store: VectorStore;
  embeddings: EmbeddingService;
  keyword?: KeywordSearch;
  logger?: LoggerPort;
  newId?: (prefix: string) => string;
}

export class Retriever {
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: RetrieverOptions) {
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  /**
   * Ingests a document into a collection.
   *
   * Deletes the document's existing chunks first. Without that, re-ingesting a changed document
   * leaves the old chunks in the index, and a search returns both versions — the model then sees
   * contradictory passages and picks one, usually the one that reads more confidently.
   */
  async ingest(input: {
    organizationId: string | null;
    collectionId: string;
    documentId: string;
    title: string | null;
    uri: string | null;
    content: string;
    metadata?: Record<string, string | number | boolean | null>;
    chunking?: ChunkingStrategy;
    signal?: AbortSignal;
  }): Promise<{ chunks: number; tokens: number; costCents: number; replaced: number }> {
    const collection = await this.options.store.getCollection(
      input.collectionId,
      input.organizationId,
    );

    if (!collection) {
      throw ApiError.notFound(
        `No collection "${input.collectionId}" for this tenant. Create it first — the collection ` +
          'records which embedding model populates it, which is what makes a mismatched search ' +
          'detectable.',
      );
    }

    const strategy = input.chunking ?? chunkingStrategySchema.parse({});
    const chunks = chunkText(input.content, strategy);

    if (chunks.length === 0) {
      return { chunks: 0, tokens: 0, costCents: 0, replaced: 0 };
    }

    const embedded = await this.options.embeddings.embed({
      texts: chunks.map((chunk) => chunk.content),
      modelId: collection.modelId,
      signal: input.signal,
    });

    // Old chunks first. A re-ingestion that left them behind would put two versions of the same
    // document in the index.
    const replaced = await this.options.store.deleteByDocument(
      input.documentId,
      input.organizationId,
      input.collectionId,
    );

    const records: VectorRecord[] = chunks.map((chunk, index) => ({
      id: `${input.documentId}:${chunk.index}`,
      organizationId: input.organizationId,
      collectionId: input.collectionId,
      vector: embedded.embeddings[index]!.vector,
      modelId: embedded.embeddings[index]!.modelId,
      dimensions: embedded.embeddings[index]!.dimensions,
      version: embedded.embeddings[index]!.version,
      content: chunk.content,
      metadata: { ...(input.metadata ?? {}), ...(chunk.heading ? { heading: chunk.heading } : {}) },
      source: {
        documentId: input.documentId,
        title: input.title,
        uri: input.uri,
        chunkIndex: chunk.index,
      },
      createdAt: new Date(),
    }));

    await this.options.store.upsert(records);

    return {
      chunks: chunks.length,
      tokens: embedded.totalTokens,
      costCents: embedded.costCents,
      replaced,
    };
  }

  /**
   * Retrieves passages for a query.
   *
   * Vector search, optionally fused with keyword search, then diversified, then truncated to the
   * context budget, then numbered for citation.
   */
  async retrieve(input: {
    organizationId: string | null;
    collectionId: string;
    query: string;
    options?: Partial<RetrievalOptions>;
    signal?: AbortSignal;
  }): Promise<RetrievalResult> {
    const options = retrievalOptionsSchema.parse(input.options ?? {});

    const collection = await this.options.store.getCollection(
      input.collectionId,
      input.organizationId,
    );

    if (!collection) {
      throw ApiError.notFound(`No collection "${input.collectionId}" for this tenant.`);
    }

    const queryEmbedding = await this.options.embeddings.embedOne(
      input.query,
      collection.modelId,
      input.signal,
    );

    const vectorHits = await this.options.store.search({
      organizationId: input.organizationId,
      collectionId: input.collectionId,
      vector: queryEmbedding.vector,
      modelId: queryEmbedding.modelId,
      dimensions: queryEmbedding.dimensions,
      version: queryEmbedding.version,
      // Over-fetch, because diversification and the context limit both drop hits and a
      // limit-sized fetch would leave fewer than asked for.
      limit: options.limit * 3,
      filter: options.filter,
      minScore: options.minScore,
    });

    const keywordHits = this.options.keyword
      ? await this.options.keyword.search({
          organizationId: input.organizationId,
          collectionId: input.collectionId,
          query: input.query,
          limit: options.limit * 2,
          filter: options.filter,
        })
      : [];

    const fused = fuse(vectorHits, keywordHits);
    const diversified = diversify(fused, options.maxPerDocument);

    const passages: RetrievedPassage[] = [];
    let usedChars = 0;
    let truncated = 0;

    for (const hit of diversified) {
      if (passages.length >= options.limit) {
        truncated += 1;
        continue;
      }

      if (usedChars + hit.record.content.length > options.maxContextChars) {
        // Dropped rather than trimmed: half a passage is a passage whose end is missing, and a
        // model reading it has no way to know.
        truncated += 1;
        continue;
      }

      usedChars += hit.record.content.length;

      passages.push({
        citation: passages.length + 1,
        content: hit.record.content,
        score: hit.score,
        documentId: hit.record.source.documentId,
        title: hit.record.source.title,
        uri: hit.record.source.uri,
        chunkIndex: hit.record.source.chunkIndex,
        heading: (hit.record.metadata.heading as string | undefined) ?? null,
        retrievedBy: hit.retrievedBy,
      });
    }

    return {
      passages,
      context: formatContext(passages),
      sources: dedupeSources(passages),
      // The honest signal. Without it, a query about something the collection does not cover
      // still gets passages, and the model answers from them.
      empty: passages.length === 0,
      truncated,
      embeddingTokens: queryEmbedding.tokens,
      embeddingCostCents: 0,
    };
  }

  /** Removes a document from a collection. What a deletion request needs. */
  async remove(input: {
    organizationId: string | null;
    collectionId: string;
    documentId: string;
  }): Promise<number> {
    return this.options.store.deleteByDocument(
      input.documentId,
      input.organizationId,
      input.collectionId,
    );
  }
}

/**
 * Fuses vector and keyword results with reciprocal rank fusion.
 *
 * RRF rather than a weighted score sum, because the two scores are on incomparable scales — a
 * cosine similarity of 0.7 and a BM25 score of 12 cannot be added, and normalising them requires
 * knowing each distribution. RRF uses only the *rank*, which is comparable by construction.
 *
 * The constant 60 is the value from the original paper; it damps the influence of top ranks enough
 * that one system being confidently wrong does not dominate.
 */
function fuse(
  vectorHits: VectorSearchHit[],
  keywordHits: Array<{ record: VectorRecord; score: number }>,
): Array<VectorSearchHit & { retrievedBy: 'vector' | 'keyword' | 'both' }> {
  const K = 60;
  const scores = new Map<string, { record: VectorRecord; score: number; sources: Set<string> }>();

  for (const [rank, hit] of vectorHits.entries()) {
    scores.set(hit.record.id, {
      record: hit.record,
      score: 1 / (K + rank + 1),
      sources: new Set(['vector']),
    });
  }

  for (const [rank, hit] of keywordHits.entries()) {
    const existing = scores.get(hit.record.id);

    if (existing) {
      existing.score += 1 / (K + rank + 1);
      existing.sources.add('keyword');
    } else {
      scores.set(hit.record.id, {
        record: hit.record,
        score: 1 / (K + rank + 1),
        sources: new Set(['keyword']),
      });
    }
  }

  return [...scores.values()]
    .map((entry) => ({
      record: entry.record,
      score: entry.score,
      retrievedBy: (entry.sources.size === 2
        ? 'both'
        : entry.sources.has('vector')
          ? 'vector'
          : 'keyword') as 'vector' | 'keyword' | 'both',
    }))
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
}

/**
 * Caps how many chunks come from any one document.
 *
 * Without it, one long document that matches well fills every slot and the answer is drawn from a
 * single source. Diversity is a hedge against that source being wrong.
 */
function diversify<T extends { record: VectorRecord }>(hits: T[], maxPerDocument: number): T[] {
  const counts = new Map<string, number>();
  const kept: T[] = [];

  for (const hit of hits) {
    const documentId = hit.record.source.documentId ?? hit.record.id;
    const count = counts.get(documentId) ?? 0;

    if (count >= maxPerDocument) continue;

    counts.set(documentId, count + 1);
    kept.push(hit);
  }

  return kept;
}

/**
 * Formats passages for a prompt.
 *
 * Each is numbered and labelled with its source, and the block says what the numbers are for.
 * A model given unlabelled passages cites nothing, because nothing told it there was anything to
 * cite — and a citation instruction in the prompt with no markers in the context produces
 * fabricated citation numbers, which is worse than none.
 */
export function formatContext(passages: RetrievedPassage[]): string {
  if (passages.length === 0) return '';

  const blocks = passages.map((passage) => {
    const label = [passage.title, passage.heading].filter(Boolean).join(' — ') || 'Untitled source';
    return `[${passage.citation}] ${label}\n${passage.content}`;
  });

  return [
    'Use only the sources below to answer. Cite them by their number, like [1].',
    'If the sources do not contain the answer, say so — do not fill the gap.',
    '',
    ...blocks,
  ].join('\n');
}

function dedupeSources(passages: RetrievedPassage[]): Array<{
  citation: number;
  title: string | null;
  uri: string | null;
  documentId: string | null;
}> {
  const seen = new Map<
    string,
    { citation: number; title: string | null; uri: string | null; documentId: string | null }
  >();

  for (const passage of passages) {
    const key = passage.documentId ?? `${passage.title}:${passage.uri}`;
    if (seen.has(key)) continue;

    seen.set(key, {
      citation: passage.citation,
      title: passage.title,
      uri: passage.uri,
      documentId: passage.documentId,
    });
  }

  return [...seen.values()].sort((a, b) => a.citation - b.citation);
}

/**
 * Which citation markers an answer actually used, and which are wrong.
 *
 * A model citing `[7]` when six passages were supplied has fabricated a source, and that is
 * mechanically detectable — one of the few things about a generated answer that is. Feeds the
 * `citationCoverage` metric in `@trustsystem/evaluation`.
 */
export function checkCitations(
  answer: string,
  passages: RetrievedPassage[],
): { used: number[]; fabricated: number[]; uncited: number[]; coverage: number } {
  const cited = new Set<number>();

  for (const match of answer.matchAll(/\[(\d{1,3})\]/g)) {
    cited.add(Number.parseInt(match[1]!, 10));
  }

  const valid = new Set(passages.map((passage) => passage.citation));

  const used = [...cited].filter((number) => valid.has(number)).sort((a, b) => a - b);
  const fabricated = [...cited].filter((number) => !valid.has(number)).sort((a, b) => a - b);
  const uncited = [...valid].filter((number) => !cited.has(number)).sort((a, b) => a - b);

  return {
    used,
    fabricated,
    uncited,
    coverage: valid.size === 0 ? 0 : used.length / valid.size,
  };
}
