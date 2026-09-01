import {
  productError,
  type ProductDefinition,
  type ProductLifecycleStatus,
} from '@trustsystem/financial-product-core';
import type { PublishedVersion } from '@trustsystem/financial-product-versioning';
import type { ProductDecision } from '@trustsystem/financial-product-governance';
import type { ProductVariant } from '@trustsystem/financial-product-variants';

/**
 * The store contract, and an in-memory implementation of it.
 *
 * The contract is the deliverable; the implementation is for tests, the sandbox and the
 * simulator. A deployment binds this to Prisma, and three of the method contracts below say
 * "must be atomic" — which means it, in the sense phase 6 established: a single statement with a
 * unique constraint or a conditional update, never a read followed by a write. A read-then-write
 * implementation passes every single-threaded test and produces two active versions the moment
 * two operators activate at once.
 *
 * Every method takes `organizationId` explicitly, and it is `string | null` rather than optional
 * so a caller cannot omit it. Null is the platform tenant, not a wildcard.
 */

export interface ProductRecord {
  productId: string;
  organizationId: string | null;
  /** The draft being edited, if one exists. At most one per product. */
  draft: ProductDefinition | null;
  /** Who composed the draft. The maker, loaded server-side and never sent by a client. */
  draftAuthorId: string | null;
  draftSubmittedById: string | null;
  /** Published versions, newest last. */
  versions: PublishedVersion[];
  /** The version new executions bind to. Null when nothing is live. */
  activeVersion: string | null;
  /** Decisions recorded against the draft. */
  decisions: ProductDecision[];
  /** Optimistic concurrency. Every write is conditional on the value the read saw. */
  revision: number;
}

export interface ProductStore {
  find(organizationId: string | null, productId: string): Promise<ProductRecord | null>;

  list(organizationId: string | null): Promise<ProductRecord[]>;

  /**
   * Creates a product.
   *
   * **Must be atomic.** A unique constraint on `(organizationId, productId)`, not a
   * read-then-insert — two operators creating the same product id concurrently must produce one
   * product and one conflict, never two records that later diverge.
   */
  create(record: ProductRecord): Promise<ProductRecord>;

  /**
   * Writes a record.
   *
   * **Must be conditional on `expectedRevision`.** Zero rows updated is the signal that somebody
   * else won, and the caller must be told rather than retried into — a retry here re-applies a
   * decision made against a page that is now stale.
   */
  update(record: ProductRecord, expectedRevision: number): Promise<ProductRecord>;

  findVariant(organizationId: string | null, variantId: string): Promise<ProductVariant | null>;

  listVariants(organizationId: string | null, productId: string): Promise<ProductVariant[]>;

  saveVariant(organizationId: string | null, variant: ProductVariant): Promise<ProductVariant>;

  /** How many executions are currently bound to a version. Read by the rollback plan. */
  countInFlight(organizationId: string | null, productId: string, version: string): Promise<number>;
}

/**
 * The in-memory store.
 *
 * Deep-copies on read and on write. That looks wasteful and is the point: a store that handed out
 * references would let a caller mutate a "persisted" record without going through `update`, and
 * every concurrency test would pass because there is no concurrency in a shared object graph.
 * The Prisma implementation cannot hand out references, so neither does this one.
 */
export class InMemoryProductStore implements ProductStore {
  private readonly records = new Map<string, ProductRecord>();
  private readonly variants = new Map<string, ProductVariant>();
  private readonly inFlight = new Map<string, number>();

  async find(organizationId: string | null, productId: string): Promise<ProductRecord | null> {
    const record = this.records.get(key(organizationId, productId));
    return record ? clone(record) : null;
  }

  async list(organizationId: string | null): Promise<ProductRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.organizationId === organizationId)
      .map(clone)
      .sort((left, right) => left.productId.localeCompare(right.productId));
  }

  async create(record: ProductRecord): Promise<ProductRecord> {
    const id = key(record.organizationId, record.productId);

    if (this.records.has(id)) {
      throw productError(
        'product_definition_invalid',
        `A product with the id "${record.productId}" already exists for this tenant.`,
        { productId: record.productId },
      );
    }

    this.records.set(id, clone(record));
    return clone(record);
  }

  async update(record: ProductRecord, expectedRevision: number): Promise<ProductRecord> {
    const id = key(record.organizationId, record.productId);
    const current = this.records.get(id);

    if (!current) {
      throw productError('product_not_found', `No product "${record.productId}" for this tenant.`, {
        productId: record.productId,
      });
    }

    if (current.revision !== expectedRevision) {
      throw productError(
        'product_definition_immutable',
        `The product changed while you were working on it (revision ${current.revision}, you ` +
          `read ${expectedRevision}). Reload and reapply — retrying would re-apply a decision ` +
          'made against a page that is now stale.',
        {
          productId: record.productId,
          expected: String(expectedRevision),
          actual: String(current.revision),
        },
      );
    }

    const next = { ...clone(record), revision: current.revision + 1 };
    this.records.set(id, next);
    return clone(next);
  }

  async findVariant(
    organizationId: string | null,
    variantId: string,
  ): Promise<ProductVariant | null> {
    const variant = this.variants.get(key(organizationId, variantId));
    return variant ? structuredClone(variant) : null;
  }

  async listVariants(organizationId: string | null, productId: string): Promise<ProductVariant[]> {
    return [...this.variants.entries()]
      .filter(
        ([id, variant]) =>
          id.startsWith(`${organizationId ?? 'platform'}|`) && variant.baseProductId === productId,
      )
      .map(([, variant]) => structuredClone(variant));
  }

  async saveVariant(
    organizationId: string | null,
    variant: ProductVariant,
  ): Promise<ProductVariant> {
    this.variants.set(key(organizationId, variant.variantId), structuredClone(variant));
    return structuredClone(variant);
  }

  async countInFlight(
    organizationId: string | null,
    productId: string,
    version: string,
  ): Promise<number> {
    return this.inFlight.get(`${key(organizationId, productId)}|${version}`) ?? 0;
  }

  /** Test seam: record that executions are bound to a version, so a rollback plan can report it. */
  setInFlight(
    organizationId: string | null,
    productId: string,
    version: string,
    count: number,
  ): void {
    this.inFlight.set(`${key(organizationId, productId)}|${version}`, count);
  }
}

function key(organizationId: string | null, id: string): string {
  return `${organizationId ?? 'platform'}|${id}`;
}

function clone(record: ProductRecord): ProductRecord {
  return {
    ...record,
    draft: record.draft ? structuredClone(record.draft) : null,
    versions: record.versions.map((version) => ({
      ...version,
      definition: structuredClone(version.definition),
      approvedBy: [...version.approvedBy],
      changedPaths: [...version.changedPaths],
    })),
    decisions: record.decisions.map((decision) => ({ ...decision })),
  };
}

/** A lifecycle status shared by the product record and its active version, for the catalog. */
export function effectiveStatus(record: ProductRecord): ProductLifecycleStatus {
  if (record.activeVersion) {
    const active = record.versions.find((version) => version.version === record.activeVersion);
    if (active) return active.definition.lifecycleStatus;
  }
  return record.draft?.lifecycleStatus ?? 'retired';
}
