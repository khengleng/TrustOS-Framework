import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import type { AuditService } from '@trustsystem/audit';
import type { LoggerPort } from '@trustsystem/logging';
import type { VectorStore } from '@trustsystem/vector-store';

/**
 * Knowledge collections and documents.
 *
 * The management layer over a vector store: what a collection contains, who may read it, when a
 * document expires, and what happened to it.
 *
 * The reason this is a package rather than a table: **a knowledge base is an access-control
 * surface that does not look like one.** A document in a collection an agent can search is a
 * document that agent can quote to whoever it is talking to. HR policies, contract terms, internal
 * pricing — all reasonable things to put in a knowledge base, and all things that must not reach
 * every customer through a support assistant.
 *
 * So a collection carries an access policy, and retrieval goes through this rather than straight
 * to the vector store. The vector store enforces the *tenant* boundary; this enforces everything
 * finer.
 */

export const KNOWLEDGE_VISIBILITIES = [
  /** Any authenticated user of the tenant. Customer-facing content. */
  'organization',
  /** Named roles only. Internal policy, pricing, procedures. */
  'restricted',
  /** Named agents only, and no direct user access. For an agent's private working set. */
  'agent_only',
] as const;
export type KnowledgeVisibility = (typeof KNOWLEDGE_VISIBILITIES)[number];

export const knowledgeCollectionSchema = z
  .object({
    id: z.string().min(1).max(120),
    organizationId: z.string().nullable(),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).default(''),

    /** The embedding model. Fixed at creation — changing it means re-embedding everything. */
    embeddingModelId: z.string().min(1).max(120),

    visibility: z.enum(KNOWLEDGE_VISIBILITIES).default('restricted'),
    /** Roles that may read, for `restricted`. */
    allowedRoles: z.array(z.string().max(120)).max(100).default([]),
    /** Agents that may search, for `agent_only` and as an addition to the others. */
    allowedAgentIds: z.array(z.string().max(120)).max(100).default([]),

    /**
     * How stale a document may be before it is excluded from retrieval.
     *
     * Null for evergreen content. Set for anything with a review cycle: a policy from three years
     * ago is worse than no policy, because the model quotes it with the same confidence.
     */
    maxDocumentAgeDays: z.number().int().min(1).max(3650).nullable().default(null),

    documentCount: z.number().int().min(0).default(0),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    createdById: z.string().nullable().default(null),
  })
  .strict();

export type KnowledgeCollection = z.infer<typeof knowledgeCollectionSchema>;

export const knowledgeDocumentSchema = z
  .object({
    id: z.string().min(1).max(200),
    collectionId: z.string().min(1).max(120),
    organizationId: z.string().nullable(),

    title: z.string().min(1).max(500),
    uri: z.string().max(2000).nullable().default(null),
    /** Content is stored so a re-embedding does not need the original source. */
    content: z.string().max(5_000_000),

    /** Bumped on every content change. What a citation can pin to. */
    version: z.number().int().min(1).default(1),
    /** SHA-256 of the content, so an unchanged re-ingestion is a no-op. */
    contentHash: z.string().max(64),

    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),

    /**
     * When this document stops being retrievable.
     *
     * Explicit expiry rather than only the collection's age rule, because some documents have a
     * known end date — a price list valid for a quarter, a policy superseded on a date.
     */
    expiresAt: z.coerce.date().nullable().default(null),

    /** Chunks currently in the vector store. Zero means it is stored but not indexed. */
    chunkCount: z.number().int().min(0).default(0),

    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    createdById: z.string().nullable().default(null),
  })
  .strict();

export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

export interface KnowledgeStore {
  createCollection(collection: KnowledgeCollection): Promise<KnowledgeCollection>;
  findCollection(id: string, organizationId: string | null): Promise<KnowledgeCollection | null>;
  listCollections(organizationId: string | null): Promise<KnowledgeCollection[]>;
  updateCollection(
    id: string,
    organizationId: string | null,
    patch: Partial<KnowledgeCollection>,
  ): Promise<KnowledgeCollection | null>;
  deleteCollection(id: string, organizationId: string | null): Promise<boolean>;

  upsertDocument(
    document: KnowledgeDocument,
  ): Promise<{ document: KnowledgeDocument; changed: boolean }>;
  findDocument(id: string, organizationId: string | null): Promise<KnowledgeDocument | null>;
  listDocuments(
    collectionId: string,
    organizationId: string | null,
    options?: { limit?: number; offset?: number },
  ): Promise<{ items: KnowledgeDocument[]; total: number }>;
  deleteDocument(id: string, organizationId: string | null): Promise<boolean>;
  /** Documents past their expiry or the collection's age rule. */
  findExpired(now: Date, organizationId?: string | null): Promise<KnowledgeDocument[]>;
}

/** Who is asking. Every read takes one — access is not optional. */
export interface KnowledgeAccessContext {
  organizationId: string | null;
  roles: string[];
  /** Set when an agent is searching rather than a person. */
  agentId?: string;
}

export interface KnowledgeServiceOptions {
  store: KnowledgeStore;
  vectors: VectorStore;
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class KnowledgeService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: KnowledgeServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  async createCollection(input: {
    id?: string;
    organizationId: string | null;
    name: string;
    description?: string;
    embeddingModelId: string;
    visibility?: KnowledgeVisibility;
    allowedRoles?: string[];
    allowedAgentIds?: string[];
    maxDocumentAgeDays?: number | null;
    dimensions: number;
    embeddingVersion?: string;
    metric?: 'cosine' | 'euclidean' | 'dot_product';
    actorId: string | null;
  }): Promise<KnowledgeCollection> {
    const id = input.id ?? this.newId('kb');
    const now = this.now();

    const collection = knowledgeCollectionSchema.parse({
      id,
      organizationId: input.organizationId,
      name: input.name,
      description: input.description ?? '',
      embeddingModelId: input.embeddingModelId,
      // Defaults to `restricted`, not `organization`. A knowledge base is an access-control
      // surface, and defaulting it open would make every new collection readable by every user
      // of the tenant until somebody noticed.
      visibility: input.visibility ?? 'restricted',
      allowedRoles: input.allowedRoles ?? [],
      allowedAgentIds: input.allowedAgentIds ?? [],
      maxDocumentAgeDays: input.maxDocumentAgeDays ?? null,
      documentCount: 0,
      createdAt: now,
      updatedAt: now,
      createdById: input.actorId,
    });

    // The vector collection is created alongside, so the embedding model is recorded in both
    // places and a mismatch is detectable from either.
    await this.options.vectors.createCollection({
      id,
      organizationId: input.organizationId,
      modelId: input.embeddingModelId,
      dimensions: input.dimensions,
      version: input.embeddingVersion ?? '1',
      metric: input.metric ?? 'cosine',
    });

    const created = await this.options.store.createCollection(collection);

    await this.options.audit?.record({
      action: 'rag.collection.created',
      entityType: 'KnowledgeCollection',
      entityId: id,
      actorId: input.actorId,
      organizationId: input.organizationId,
      after: {
        name: input.name,
        visibility: collection.visibility,
        embeddingModelId: input.embeddingModelId,
      },
    });

    return created;
  }

  /**
   * Whether a caller may read a collection.
   *
   * Returns a reason rather than a boolean, so a refusal can say which rule refused — "you do not
   * have the compliance role" is actionable, "forbidden" is a support ticket.
   */
  canRead(
    collection: KnowledgeCollection,
    context: KnowledgeAccessContext,
  ): { allowed: boolean; reason: string | null } {
    if (collection.organizationId !== context.organizationId) {
      return { allowed: false, reason: 'This collection belongs to another organization.' };
    }

    if (collection.visibility === 'organization') {
      return { allowed: true, reason: null };
    }

    if (collection.visibility === 'agent_only') {
      if (!context.agentId) {
        return {
          allowed: false,
          reason:
            'This collection is for agent use only and is not directly readable by a person. It ' +
            'is an agent’s working set rather than reference material.',
        };
      }
      if (!collection.allowedAgentIds.includes(context.agentId)) {
        return {
          allowed: false,
          reason: `The agent "${context.agentId}" is not permitted to search this collection.`,
        };
      }
      return { allowed: true, reason: null };
    }

    // `restricted`: a role, or a named agent.
    if (context.agentId && collection.allowedAgentIds.includes(context.agentId)) {
      return { allowed: true, reason: null };
    }

    const matched = context.roles.filter((role) => collection.allowedRoles.includes(role));
    if (matched.length > 0) return { allowed: true, reason: null };

    return {
      allowed: false,
      reason:
        `This collection requires one of these roles: ${collection.allowedRoles.join(', ') || '(none configured)'}. ` +
        'A knowledge base is an access-control surface — a document an agent can search is one it ' +
        'can quote to whoever it is talking to.',
    };
  }

  /** Throws when a caller may not read. Reports not-found rather than forbidden across tenants. */
  async requireReadable(
    collectionId: string,
    context: KnowledgeAccessContext,
  ): Promise<KnowledgeCollection> {
    const collection = await this.options.store.findCollection(
      collectionId,
      context.organizationId,
    );

    if (!collection) {
      // Not-found rather than forbidden: confirming it exists tells a caller about another
      // tenant's collections.
      throw ApiError.notFound(`No knowledge collection "${collectionId}".`);
    }

    const access = this.canRead(collection, context);
    if (!access.allowed) {
      throw ApiError.forbidden(access.reason ?? 'You may not read this collection.', {
        reason: 'knowledge_access_denied',
        collectionId,
      });
    }

    return collection;
  }

  /**
   * Adds or updates a document.
   *
   * Returns `changed: false` when the content hash matches, so a re-ingestion of unchanged
   * material does not re-embed. Embedding is the expensive part of ingestion, and a nightly sync
   * of a thousand documents where three changed should cost three embeddings.
   */
  async putDocument(input: {
    collectionId: string;
    organizationId: string | null;
    id?: string;
    title: string;
    uri?: string | null;
    content: string;
    metadata?: Record<string, string | number | boolean | null>;
    expiresAt?: Date | null;
    actorId: string | null;
  }): Promise<{ document: KnowledgeDocument; changed: boolean }> {
    const collection = await this.options.store.findCollection(
      input.collectionId,
      input.organizationId,
    );

    if (!collection) {
      throw ApiError.notFound(`No knowledge collection "${input.collectionId}".`);
    }

    const { createHash } = await import('node:crypto');
    const contentHash = createHash('sha256').update(input.content).digest('hex');

    const id = input.id ?? this.newId('kdoc');
    const existing = await this.options.store.findDocument(id, input.organizationId);
    const now = this.now();

    if (existing && existing.contentHash === contentHash) {
      // Unchanged. Metadata may still have moved, so it is updated, but nothing is re-embedded.
      return { document: existing, changed: false };
    }

    const document = knowledgeDocumentSchema.parse({
      id,
      collectionId: input.collectionId,
      organizationId: input.organizationId,
      title: input.title,
      uri: input.uri ?? null,
      content: input.content,
      version: (existing?.version ?? 0) + 1,
      contentHash,
      metadata: input.metadata ?? {},
      expiresAt: input.expiresAt ?? null,
      chunkCount: 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      createdById: existing?.createdById ?? input.actorId,
    });

    const result = await this.options.store.upsertDocument(document);

    await this.options.audit?.record({
      action: existing ? 'ai.knowledge.document_updated' : 'ai.knowledge.document_added',
      entityType: 'KnowledgeDocument',
      entityId: id,
      actorId: input.actorId,
      organizationId: input.organizationId,
      // The title and the version, never the content: a knowledge document can be a contract.
      after: {
        collectionId: input.collectionId,
        title: input.title,
        version: document.version,
      },
    });

    return { document: result.document, changed: true };
  }

  /**
   * Removes a document and its vectors.
   *
   * Both, in that order. A document removed from the catalogue but left in the index is still
   * retrievable and still quotable, which is the exact failure a deletion request is meant to
   * prevent.
   */
  async removeDocument(
    id: string,
    organizationId: string | null,
    actorId: string | null,
  ): Promise<{ removed: boolean; vectorsRemoved: number }> {
    const document = await this.options.store.findDocument(id, organizationId);
    if (!document) return { removed: false, vectorsRemoved: 0 };

    const vectorsRemoved = await this.options.vectors.deleteByDocument(
      id,
      organizationId,
      document.collectionId,
    );

    const removed = await this.options.store.deleteDocument(id, organizationId);

    await this.options.audit?.record({
      action: 'rag.document.removed',
      entityType: 'KnowledgeDocument',
      entityId: id,
      actorId,
      organizationId,
      before: { collectionId: document.collectionId, title: document.title },
      after: { vectorsRemoved },
    });

    return { removed, vectorsRemoved };
  }

  /**
   * Removes expired documents and their vectors.
   *
   * Run on a schedule. A policy from three years ago is worse than no policy, because the model
   * quotes it with exactly the same confidence as a current one — and nothing in a generated
   * answer indicates the source was stale.
   */
  async purgeExpired(organizationId?: string | null): Promise<{
    documents: number;
    vectors: number;
    titles: string[];
  }> {
    const expired = await this.options.store.findExpired(this.now(), organizationId);

    let vectors = 0;
    const titles: string[] = [];

    for (const document of expired) {
      const result = await this.removeDocument(document.id, document.organizationId, null);
      vectors += result.vectorsRemoved;
      titles.push(document.title);
    }

    if (expired.length > 0) {
      this.options.logger?.info(
        { documents: expired.length, vectors },
        'purged expired knowledge documents',
      );
    }

    return { documents: expired.length, vectors, titles };
  }

  /** Whether a document is still retrievable. Explicit expiry, then the collection's age rule. */
  isCurrent(document: KnowledgeDocument, collection: KnowledgeCollection): boolean {
    const now = this.now();

    if (document.expiresAt && document.expiresAt <= now) return false;

    if (collection.maxDocumentAgeDays !== null) {
      const ageDays = (now.getTime() - document.updatedAt.getTime()) / 86_400_000;
      if (ageDays > collection.maxDocumentAgeDays) return false;
    }

    return true;
  }

  async listCollections(context: KnowledgeAccessContext): Promise<KnowledgeCollection[]> {
    const all = await this.options.store.listCollections(context.organizationId);
    // Filtered by access, so a listing does not reveal the existence of collections the caller
    // cannot read.
    return all.filter((collection) => this.canRead(collection, context).allowed);
  }

  async listDocuments(
    collectionId: string,
    context: KnowledgeAccessContext,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ items: KnowledgeDocument[]; total: number }> {
    await this.requireReadable(collectionId, context);
    return this.options.store.listDocuments(collectionId, context.organizationId, options);
  }

  /** Which collections an agent may search. What the agent runtime asks before retrieving. */
  async searchableBy(agentId: string, organizationId: string | null): Promise<string[]> {
    const collections = await this.options.store.listCollections(organizationId);

    return collections
      .filter(
        (collection) => this.canRead(collection, { organizationId, roles: [], agentId }).allowed,
      )
      .map((collection) => collection.id)
      .sort();
  }
}
