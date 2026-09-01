/**
 * @trustsystem/vector-store
 *
 * Vector storage abstraction with an in-memory default. PGVector, Qdrant, Milvus, Pinecone and
 * Weaviate are adapters a deployment supplies.
 *
 * Two things this insists on that a bare vector database does not: every record carries its
 * tenant and every search is scoped, and a query vector must be comparable with the collection
 * it searches.
 */
export * from './store';
