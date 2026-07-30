import type { KnowledgeCollection, KnowledgeDocument, KnowledgeStore } from './knowledge';

/** An in-memory knowledge store, for tests and development. */
export class InMemoryKnowledgeStore implements KnowledgeStore {
  readonly collections = new Map<string, KnowledgeCollection>();
  readonly documents = new Map<string, KnowledgeDocument>();

  private key(id: string, organizationId: string | null): string {
    return `${organizationId ?? 'platform'}::${id}`;
  }

  async createCollection(collection: KnowledgeCollection): Promise<KnowledgeCollection> {
    this.collections.set(this.key(collection.id, collection.organizationId), collection);
    return collection;
  }

  async findCollection(
    id: string,
    organizationId: string | null,
  ): Promise<KnowledgeCollection | null> {
    return this.collections.get(this.key(id, organizationId)) ?? null;
  }

  async listCollections(organizationId: string | null): Promise<KnowledgeCollection[]> {
    return [...this.collections.values()]
      .filter((collection) => collection.organizationId === organizationId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async updateCollection(
    id: string,
    organizationId: string | null,
    patch: Partial<KnowledgeCollection>,
  ): Promise<KnowledgeCollection | null> {
    const key = this.key(id, organizationId);
    const collection = this.collections.get(key);
    if (!collection) return null;

    const updated = { ...collection, ...patch, updatedAt: new Date() };
    this.collections.set(key, updated);
    return updated;
  }

  async deleteCollection(id: string, organizationId: string | null): Promise<boolean> {
    for (const [documentKey, document] of this.documents) {
      if (document.collectionId === id && document.organizationId === organizationId) {
        this.documents.delete(documentKey);
      }
    }
    return this.collections.delete(this.key(id, organizationId));
  }

  async upsertDocument(
    document: KnowledgeDocument,
  ): Promise<{ document: KnowledgeDocument; changed: boolean }> {
    const key = this.key(document.id, document.organizationId);
    const existed = this.documents.has(key);

    this.documents.set(key, document);

    const collectionKey = this.key(document.collectionId, document.organizationId);
    const collection = this.collections.get(collectionKey);

    if (collection && !existed) {
      this.collections.set(collectionKey, {
        ...collection,
        documentCount: collection.documentCount + 1,
      });
    }

    return { document, changed: true };
  }

  async findDocument(id: string, organizationId: string | null): Promise<KnowledgeDocument | null> {
    return this.documents.get(this.key(id, organizationId)) ?? null;
  }

  async listDocuments(
    collectionId: string,
    organizationId: string | null,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ items: KnowledgeDocument[]; total: number }> {
    const all = [...this.documents.values()]
      .filter(
        (document) =>
          document.collectionId === collectionId && document.organizationId === organizationId,
      )
      .sort((a, b) => a.title.localeCompare(b.title));

    const offset = options.offset ?? 0;
    return { items: all.slice(offset, offset + (options.limit ?? 50)), total: all.length };
  }

  async deleteDocument(id: string, organizationId: string | null): Promise<boolean> {
    const key = this.key(id, organizationId);
    const document = this.documents.get(key);
    if (!document) return false;

    this.documents.delete(key);

    const collectionKey = this.key(document.collectionId, document.organizationId);
    const collection = this.collections.get(collectionKey);
    if (collection) {
      this.collections.set(collectionKey, {
        ...collection,
        documentCount: Math.max(0, collection.documentCount - 1),
      });
    }

    return true;
  }

  async findExpired(now: Date, organizationId?: string | null): Promise<KnowledgeDocument[]> {
    return [...this.documents.values()].filter((document) => {
      if (organizationId !== undefined && document.organizationId !== organizationId) return false;

      if (document.expiresAt && document.expiresAt <= now) return true;

      const collection = this.collections.get(
        this.key(document.collectionId, document.organizationId),
      );
      if (!collection?.maxDocumentAgeDays) return false;

      const ageDays = (now.getTime() - document.updatedAt.getTime()) / 86_400_000;
      return ageDays > collection.maxDocumentAgeDays;
    });
  }
}
