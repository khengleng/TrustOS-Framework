import { createHash } from 'node:crypto';
import { productError } from '@trustsystem/financial-product-core';

/**
 * Idempotency.
 *
 * Every operation that creates a transaction takes a key, and the store enforces it with a
 * **unique constraint**. A read-then-write check passes every single-threaded test and creates
 * two transactions the moment two workers retry together — which is the normal case, because the
 * reason a client retries is that something was slow enough for two workers to be involved.
 *
 * Three behaviours, and the third is the one people get wrong:
 *
 *   1. **Same key, same payload, completed** — return the stored result. The caller's retry
 *      succeeds and nothing moves twice.
 *   2. **Same key, same payload, still running** — refuse with a conflict. The first attempt has
 *      not finished, and returning a partial result would tell the caller an operation completed
 *      that has not.
 *   3. **Same key, different payload** — refuse. Never replay the first result: that tells the
 *      caller an operation succeeded that never ran *for their request*, which is worse than any
 *      error because they act on it.
 *
 * The key is scoped to the tenant and the operation. A key scoped only to its own value lets one
 * tenant's retry collide with another tenant's first attempt, which returns one tenant the
 * other's transaction and looks like a successful idempotent replay.
 */

export interface IdempotencyRecord {
  organizationId: string | null;
  productId: string;
  operation: string;
  key: string;
  /** SHA-256 of the canonical request. Never the request itself. */
  requestHash: string;
  status: 'in_progress' | 'completed' | 'failed';
  /** The execution this key produced. */
  executionId: string;
  /** The stored result, replayed on a matching retry. */
  result: Record<string, unknown> | null;
  createdAt: Date;
  /** When the key stops being honoured. A key kept forever is a key that collides eventually. */
  expiresAt: Date;
}

export interface IdempotencyStore {
  /**
   * Claims a key.
   *
   * **Must be atomic** — a single insert with a unique constraint on
   * `(COALESCE(organizationId, ''), productId, operation, key)`, not a select followed by an
   * insert. `COALESCE` because PostgreSQL treats NULL as distinct from NULL, so a platform-tenant
   * key would never collide with itself.
   *
   * Returns the existing record when the key is already claimed, and null when the claim
   * succeeded.
   */
  claim(record: IdempotencyRecord): Promise<IdempotencyRecord | null>;

  complete(
    organizationId: string | null,
    productId: string,
    operation: string,
    key: string,
    status: 'completed' | 'failed',
    result: Record<string, unknown> | null,
  ): Promise<void>;

  find(
    organizationId: string | null,
    productId: string,
    operation: string,
    key: string,
  ): Promise<IdempotencyRecord | null>;
}

/**
 * The hash of a request.
 *
 * Over a canonical rendering, so key order does not change the hash and a client that
 * re-serialises its own payload is not told its retry is a different request. The values are
 * stringified rather than JSON-encoded because a JSON number round-trips through a double, and an
 * amount that hashes differently on a retry produces a conflict the caller cannot explain.
 */
export function requestHash(payload: Record<string, unknown>): string {
  const canonical = Object.entries(payload)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${stringify(value)}`)
    .join('&');

  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function stringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') {
    return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
  }
  return String(value);
}

export type IdempotencyOutcome =
  | { kind: 'proceed' }
  | { kind: 'replay'; record: IdempotencyRecord }
  | { kind: 'conflict'; record: IdempotencyRecord };

/**
 * Decides what a claimed key means.
 *
 * Pure, so the three cases can be tested without a store, and so the store implementation cannot
 * accidentally make a different decision.
 */
export function classifyClaim(
  existing: IdempotencyRecord | null,
  incomingHash: string,
  now: Date,
): IdempotencyOutcome {
  if (!existing) return { kind: 'proceed' };

  if (existing.expiresAt <= now) return { kind: 'proceed' };

  if (existing.requestHash !== incomingHash) {
    return { kind: 'conflict', record: existing };
  }

  if (existing.status === 'in_progress') {
    return { kind: 'conflict', record: existing };
  }

  return { kind: 'replay', record: existing };
}

/** Turns a conflict into the refusal a caller sees. */
export function idempotencyConflict(record: IdempotencyRecord, sameHash: boolean): Error {
  return productError(
    'product_idempotency_conflict',
    sameHash
      ? `Idempotency key "${record.key}" is still in progress on execution ${record.executionId}. ` +
          'Returning a partial result would tell you an operation completed that has not.'
      : `Idempotency key "${record.key}" was used for a different request. Reusing a key with a ` +
          'changed payload would tell you an operation succeeded that never ran for your request.',
    { productId: record.productId, expected: record.requestHash },
  );
}

/**
 * The in-memory store.
 *
 * For tests, the sandbox and the simulator. The claim is a `Map.has` followed by a `Map.set`
 * inside one synchronous block, which is atomic on a single-threaded event loop — and is
 * emphatically **not** what a database implementation may do. The contract above says "must be
 * atomic" and means a unique constraint.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async claim(record: IdempotencyRecord): Promise<IdempotencyRecord | null> {
    const id = keyOf(record.organizationId, record.productId, record.operation, record.key);
    const existing = this.records.get(id);

    if (existing && existing.expiresAt > record.createdAt) return { ...existing };

    this.records.set(id, { ...record });
    return null;
  }

  async complete(
    organizationId: string | null,
    productId: string,
    operation: string,
    key: string,
    status: 'completed' | 'failed',
    result: Record<string, unknown> | null,
  ): Promise<void> {
    const id = keyOf(organizationId, productId, operation, key);
    const existing = this.records.get(id);
    if (!existing) return;

    this.records.set(id, { ...existing, status, result });
  }

  async find(
    organizationId: string | null,
    productId: string,
    operation: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const existing = this.records.get(keyOf(organizationId, productId, operation, key));
    return existing ? { ...existing } : null;
  }

  size(): number {
    return this.records.size;
  }
}

function keyOf(
  organizationId: string | null,
  productId: string,
  operation: string,
  key: string,
): string {
  return `${organizationId ?? ''}|${productId}|${operation}|${key}`;
}
