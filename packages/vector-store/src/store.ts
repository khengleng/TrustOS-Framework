import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import {
  areComparable,
  explainIncomparable,
  score,
  type DistanceMetric,
  type Embedding,
} from '@trustsystem/embedding';

/**
 * Vector storage abstraction.
 *
 * An interface plus an in-memory implementation. PGVector, Qdrant, Milvus, Pinecone and Weaviate
 * are adapters a deployment supplies — the framework ships none, for the same reason it ships no
 * model definitions and no provider adapters.
 *
 * Two things this abstraction insists on that a bare vector database does not:
 *
 * **1. Every record carries its tenant, and every search is scoped.** A vector database is a
 * shared index by default, and a query with no filter returns everybody's documents. That is the
 * same shape of failure as the cache key problem, with the same lack of symptom: search still
 * works, it just occasionally answers from another tenant's data. `organizationId` is a required
 * field on the record and a required argument to `search`.
 *
 * **2. Embeddings must be comparable.** A collection records the model that populated it, and a
 * search with a different model's vector is refused. Without that check the search silently
 * returns arbitrary results — see the header of `@trustsystem/embedding`.
 */

export const vectorRecordSchema = z
  .object({
    id: z.string().min(1).max(200),
    /** Required, not optional. A record with no tenant cannot be scoped out of another's search. */
    organizationId: z.string().nullable(),
    /** Which collection. A tenant may have several, and they are not searched together. */
    collectionId: z.string().min(1).max(120),

    vector: z.array(z.number()).min(1),
    /** The model that produced the vector. Checked on every search. */
    modelId: z.string().min(1).max(120),
    dimensions: z.number().int().min(1),
    version: z.string().max(60),

    /** The text this vector represents. Returned with a hit, so a citation has something to show. */
    content: z.string().max(1_000_000),

    /**
     * Filterable metadata.
     *
     * Flat, and only scalars. A nested structure is filterable in some vector databases and not
     * others, and an abstraction that permitted it would work on one backend and fail on the next.
     */
    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),

    /** Where this came from: a document id, a URL, a section. For citations. */
    source: z
      .object({
        documentId: z.string().max(200).nullable().default(null),
        title: z.string().max(500).nullable().default(null),
        uri: z.string().max(2000).nullable().default(null),
        /** Which chunk of the document, so a citation can point at a place rather than a file. */
        chunkIndex: z.number().int().min(0).nullable().default(null),
      })
      .strict()
      .default({}),

    createdAt: z.coerce.date(),
  })
  .strict();

export type VectorRecord = z.infer<typeof vectorRecordSchema>;

export interface VectorSearchHit {
  record: VectorRecord;
  /** Normalised so higher is always better, whatever the metric. */
  score: number;
}

export interface VectorSearchInput {
  /** Required. Not optional, not defaulted — see the header. */
  organizationId: string | null;
  collectionId: string;
  vector: number[];
  /** Model provenance, checked against the collection. */
  modelId: string;
  dimensions: number;
  version: string;

  limit?: number;
  /** Equality filters on metadata. */
  filter?: Record<string, string | number | boolean | null>;
  /** Hits below this are dropped. */
  minScore?: number;
}

/**
 * A collection's identity.
 *
 * Recorded so a search can be refused when its vector came from a different model — the check
 * that stops silently arbitrary results.
 */
export interface VectorCollection {
  id: string;
  organizationId: string | null;
  modelId: string;
  dimensions: number;
  version: string;
  metric: DistanceMetric;
  recordCount: number;
  createdAt: Date;
}

export interface VectorStore {
  readonly key: string;

  createCollection(
    input: Omit<VectorCollection, 'recordCount' | 'createdAt'>,
  ): Promise<VectorCollection>;
  getCollection(id: string, organizationId: string | null): Promise<VectorCollection | null>;
  listCollections(organizationId: string | null): Promise<VectorCollection[]>;
  deleteCollection(id: string, organizationId: string | null): Promise<boolean>;

  upsert(records: VectorRecord[]): Promise<{ inserted: number; updated: number }>;
  search(input: VectorSearchInput): Promise<VectorSearchHit[]>;
  delete(ids: string[], organizationId: string | null, collectionId: string): Promise<number>;
  /** Removes everything for one document. What a re-ingestion does before writing. */
  deleteByDocument(
    documentId: string,
    organizationId: string | null,
    collectionId: string,
  ): Promise<number>;

  health?(): Promise<{ status: 'healthy' | 'degraded' | 'unavailable'; detail: string }>;
}

/**
 * Checks that a search vector matches the collection it is searching.
 *
 * Shared, so every adapter enforces it identically rather than five adapters each remembering.
 * The failure it prevents is silent: search returns results, they are just unrelated to the query.
 */
export function assertComparable(
  collection: Pick<VectorCollection, 'id' | 'modelId' | 'dimensions' | 'version'>,
  vector: Pick<Embedding, 'modelId' | 'dimensions' | 'version'>,
  // Named, because the same check guards a write and a search and the two need different advice:
  // a bad write should not enter the index at all, while a bad search is a caller using the
  // wrong model.
  role: 'query' | 'record' = 'query',
): void {
  if (areComparable(collection, vector)) return;

  const summary =
    role === 'query'
      ? `The query vector does not match the "${collection.id}" collection.`
      : `A vector being written does not match the "${collection.id}" collection.`;

  throw ApiError.validation(
    [
      {
        path: 'vector',
        message:
          (explainIncomparable(collection, vector) ??
            'This vector is not comparable with the collection.') +
          (role === 'record'
            ? ' Refused on write: once a mismatched vector is in the index, every search over it ' +
              'is degraded and nothing reports it.'
            : ''),
        code: 'embedding_mismatch',
      },
    ],
    summary,
  );
}

/**
 * An in-memory vector store.
 *
 * For tests, development and small collections. A linear scan, which is correct and is fine to a
 * few tens of thousands of vectors — past that a real vector database is the answer, and this
 * says so rather than pretending to scale.
 */
export class InMemoryVectorStore implements VectorStore {
  readonly key = 'memory';

  private readonly collections = new Map<string, VectorCollection>();
  private readonly records = new Map<string, VectorRecord[]>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private collectionKey(id: string, organizationId: string | null): string {
    // The tenant is in the key, so two tenants may use the same collection name without one
    // reading the other's records.
    return `${organizationId ?? 'platform'}::${id}`;
  }

  async createCollection(
    input: Omit<VectorCollection, 'recordCount' | 'createdAt'>,
  ): Promise<VectorCollection> {
    const key = this.collectionKey(input.id, input.organizationId);

    if (this.collections.has(key)) {
      throw ApiError.conflict(`The collection "${input.id}" already exists for this tenant.`, {
        reason: 'collection_conflict',
        collectionId: input.id,
      });
    }

    const collection: VectorCollection = { ...input, recordCount: 0, createdAt: this.now() };
    this.collections.set(key, collection);
    this.records.set(key, []);

    return collection;
  }

  async getCollection(id: string, organizationId: string | null): Promise<VectorCollection | null> {
    return this.collections.get(this.collectionKey(id, organizationId)) ?? null;
  }

  async listCollections(organizationId: string | null): Promise<VectorCollection[]> {
    return [...this.collections.values()]
      .filter((collection) => collection.organizationId === organizationId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async deleteCollection(id: string, organizationId: string | null): Promise<boolean> {
    const key = this.collectionKey(id, organizationId);
    this.records.delete(key);
    return this.collections.delete(key);
  }

  async upsert(records: VectorRecord[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;

    for (const record of records) {
      const key = this.collectionKey(record.collectionId, record.organizationId);
      const collection = this.collections.get(key);

      if (!collection) {
        throw ApiError.notFound(
          `No collection "${record.collectionId}" for this tenant. Create it before writing, so ` +
            'the model and dimensions are recorded and a mismatch can be caught.',
        );
      }

      // The write-side half of the comparability check: a vector from the wrong model must not
      // enter the index at all, because once it is in, every search over it is degraded.
      assertComparable(collection, record, 'record');

      const existing = this.records.get(key) ?? [];
      const index = existing.findIndex((entry) => entry.id === record.id);

      if (index === -1) {
        existing.push(record);
        inserted += 1;
      } else {
        existing[index] = record;
        updated += 1;
      }

      this.records.set(key, existing);
      this.collections.set(key, { ...collection, recordCount: existing.length });
    }

    return { inserted, updated };
  }

  async search(input: VectorSearchInput): Promise<VectorSearchHit[]> {
    const key = this.collectionKey(input.collectionId, input.organizationId);
    const collection = this.collections.get(key);

    if (!collection) return [];

    assertComparable(collection, input);

    const candidates = (this.records.get(key) ?? []).filter((record) => {
      /*
       * The tenant check, again, on the records themselves.
       *
       * Redundant with the collection key, and kept because the consequence of the key being
       * wrong is one tenant reading another's documents — which is worth one comparison per
       * record.
       */
      if (record.organizationId !== input.organizationId) return false;

      for (const [field, value] of Object.entries(input.filter ?? {})) {
        if (record.metadata[field] !== value) return false;
      }

      return true;
    });

    return candidates
      .map((record) => ({ record, score: score(input.vector, record.vector, collection.metric) }))
      .filter((hit) => input.minScore === undefined || hit.score >= input.minScore)
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
      .slice(0, input.limit ?? 10);
  }

  async delete(
    ids: string[],
    organizationId: string | null,
    collectionId: string,
  ): Promise<number> {
    const key = this.collectionKey(collectionId, organizationId);
    const existing = this.records.get(key) ?? [];
    const toRemove = new Set(ids);

    const kept = existing.filter((record) => !toRemove.has(record.id));
    this.records.set(key, kept);

    const collection = this.collections.get(key);
    if (collection) this.collections.set(key, { ...collection, recordCount: kept.length });

    return existing.length - kept.length;
  }

  async deleteByDocument(
    documentId: string,
    organizationId: string | null,
    collectionId: string,
  ): Promise<number> {
    const key = this.collectionKey(collectionId, organizationId);
    const existing = this.records.get(key) ?? [];

    const kept = existing.filter((record) => record.source.documentId !== documentId);
    this.records.set(key, kept);

    const collection = this.collections.get(key);
    if (collection) this.collections.set(key, { ...collection, recordCount: kept.length });

    return existing.length - kept.length;
  }

  async health(): Promise<{ status: 'healthy'; detail: string }> {
    const vectors = [...this.records.values()].reduce((sum, list) => sum + list.length, 0);

    return {
      status: 'healthy',
      detail:
        `In-memory store: ${this.collections.size} collection(s), ${vectors} vector(s). ` +
        'A linear scan — fine to a few tens of thousands, and not a substitute for a vector ' +
        'database past that.',
    };
  }
}
