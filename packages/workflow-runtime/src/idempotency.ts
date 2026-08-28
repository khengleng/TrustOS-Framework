import { createHash } from 'node:crypto';
import {
  idempotencyInProgress,
  idempotencyKeyReused,
  type IdempotencyRecord,
} from '@trustos/workflow-core';

/**
 * Idempotency for externally triggered workflow actions.
 *
 * The problem is specific. A client submits an approval, the response is lost to a
 * timeout, and the client retries. Without idempotency the approval is recorded twice —
 * which for a threshold model means one person's retry counted as two approvals.
 *
 * The design has three properties, and each one exists because the obvious simpler
 * version is wrong:
 *
 *   * **The request is hashed.** Same key, same payload → return the first result.
 *     Same key, *different* payload → refuse. Returning the first result for a
 *     different payload would tell the caller an operation succeeded that never ran,
 *     which is worse than any error.
 *   * **The record is claimed before the work starts.** A key that is `in_progress`
 *     means somebody is mid-flight; a second request with it is refused rather than
 *     racing. Two concurrent approvals with one key would both pass a
 *     "has this completed?" check.
 *   * **Records expire.** A key is a promise to remember, and remembering forever is a
 *     table that grows without bound. 24 hours is longer than any client retry window
 *     and short enough that the table stays small.
 */

/**
 * Hashes a request payload.
 *
 * Keys are sorted recursively, so two structurally identical payloads that differ only
 * in key order hash the same — otherwise a client that serialises its object
 * differently on a retry would be told its key was reused.
 *
 * `undefined` values are dropped, because a field present-and-undefined and a field
 * absent are the same request as far as any API is concerned.
 */
export function hashRequest(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

export interface IdempotencyStore {
  /**
   * Claims a key, or returns the existing record.
   *
   * Must be a single atomic insert relying on a unique constraint over
   * `(organizationId, idempotencyKey)`. A `SELECT` followed by an `INSERT` has a window
   * between them, and two concurrent requests with the same key both find nothing and
   * both insert — which is the exact race this file exists to prevent.
   *
   * Returns `{ claimed: true }` when this caller won and should do the work, or
   * `{ claimed: false, existing }` when somebody else already has the key.
   */
  claim(
    input: Omit<IdempotencyRecord, 'id' | 'createdAt' | 'completedAt' | 'status'>,
  ): Promise<{ claimed: boolean; existing: IdempotencyRecord | null }>;

  complete(input: {
    organizationId: string;
    idempotencyKey: string;
    responseReference: string;
  }): Promise<void>;

  /**
   * Marks a claim failed.
   *
   * Failed rather than deleted, deliberately: deleting would let an immediate retry
   * with the same key through, and a caller retrying a request that failed for a
   * business reason — a self-approval refusal, say — would get the same refusal. Keeping
   * the row means the retry is refused as a reuse, which tells the caller the truth: a
   * new attempt needs a new key.
   */
  fail(input: { organizationId: string; idempotencyKey: string; reason: string }): Promise<void>;

  find(organizationId: string, idempotencyKey: string): Promise<IdempotencyRecord | null>;

  /** Deletes expired records. Run by a scheduler. */
  purgeExpired(asOf: Date, limit: number): Promise<number>;
}

/**
 * In-memory store, for tests and for a single-process development run.
 *
 * The clock is injectable, and it has to be. `expiresAt` is computed by `runIdempotent` from the
 * *engine's* clock, and the expiry check here compares it against this store's — so a store that
 * read the wall clock while the engine ran on an injected one would treat every record as
 * expired the moment real time passed the fixed clock plus the TTL.
 *
 * That is not hypothetical: it is what happened. A suite pinned to a date in the near future
 * passed for a month and then began failing on a Tuesday, with no change to any of the code it
 * was testing, because the two clocks had drifted past each other. Injecting it means the two
 * time sources are the same one by construction.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();
  private counter = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private key(organizationId: string, idempotencyKey: string): string {
    return `${organizationId}::${idempotencyKey}`;
  }

  async claim(
    input: Omit<IdempotencyRecord, 'id' | 'createdAt' | 'completedAt' | 'status'>,
  ): Promise<{ claimed: boolean; existing: IdempotencyRecord | null }> {
    const mapKey = this.key(input.organizationId, input.idempotencyKey);
    const existing = this.records.get(mapKey);

    // Expired records are treated as absent, so a key is reusable after its window.
    if (existing && existing.expiresAt.getTime() > this.now().getTime()) {
      return { claimed: false, existing };
    }

    this.counter += 1;
    const record: IdempotencyRecord = {
      ...input,
      id: `idem_${this.counter}`,
      status: 'in_progress',
      createdAt: this.now(),
      completedAt: null,
    };
    this.records.set(mapKey, record);
    return { claimed: true, existing: null };
  }

  async complete(input: {
    organizationId: string;
    idempotencyKey: string;
    responseReference: string;
  }): Promise<void> {
    const record = this.records.get(this.key(input.organizationId, input.idempotencyKey));
    if (!record) return;
    this.records.set(this.key(input.organizationId, input.idempotencyKey), {
      ...record,
      status: 'completed',
      responseReference: input.responseReference,
      completedAt: this.now(),
    });
  }

  async fail(input: { organizationId: string; idempotencyKey: string }): Promise<void> {
    const record = this.records.get(this.key(input.organizationId, input.idempotencyKey));
    if (!record) return;
    this.records.set(this.key(input.organizationId, input.idempotencyKey), {
      ...record,
      status: 'failed',
      completedAt: this.now(),
    });
  }

  async find(organizationId: string, idempotencyKey: string): Promise<IdempotencyRecord | null> {
    return this.records.get(this.key(organizationId, idempotencyKey)) ?? null;
  }

  async purgeExpired(asOf: Date, limit: number): Promise<number> {
    let purged = 0;
    for (const [key, record] of this.records) {
      if (purged >= limit) break;
      if (record.expiresAt.getTime() <= asOf.getTime()) {
        this.records.delete(key);
        purged += 1;
      }
    }
    return purged;
  }
}

/**
 * How long a key is remembered.
 *
 * Longer than any sensible client retry window, short enough that the table stays
 * small. A caller needing a longer guarantee should use a key derived from their own
 * business identifier, which is idempotent for as long as that identifier exists.
 */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export interface IdempotentExecution<T> {
  /** True when this caller won the claim and the operation ran. */
  executed: boolean;
  /** The result, or the recorded reference from the first attempt. */
  result: T | null;
  /** Where the first attempt's result lives, when this was a replay. */
  responseReference: string | null;
}

export interface RunIdempotentInput<T> {
  store: IdempotencyStore;
  organizationId: string;
  actorId: string;
  operation: string;
  /** Null skips the whole mechanism. Not every caller needs it. */
  idempotencyKey: string | null;
  /** Hashed and compared against the recorded hash. */
  payload: unknown;
  /** The work. Runs only if this caller claims the key. */
  execute: () => Promise<{ result: T; reference: string }>;
  now?: () => Date;
}

/**
 * Runs an operation at most once per key.
 *
 * The four outcomes, and why each is what it is:
 *
 *   * **No key** — run it. Idempotency is opt-in per request; forcing it would break
 *     every existing caller and most internal ones do not need it.
 *   * **Key claimed** — run it, then record where the result went.
 *   * **Key exists, same payload, completed** — return the reference without running.
 *     The caller gets what they would have got.
 *   * **Key exists, different payload** — refuse. A caller bug, and replaying the first
 *     result would report a success that never happened for this request.
 *
 * The fifth case, `in_progress`, is also a refusal: somebody is mid-flight, and racing
 * them would be the double-execution this exists to prevent.
 */
export async function runIdempotent<T>(
  input: RunIdempotentInput<T>,
): Promise<IdempotentExecution<T>> {
  if (!input.idempotencyKey) {
    const { result, reference } = await input.execute();
    return { executed: true, result, responseReference: reference };
  }

  const now = input.now ?? (() => new Date());
  const requestHash = hashRequest(input.payload);

  const { claimed, existing } = await input.store.claim({
    organizationId: input.organizationId,
    idempotencyKey: input.idempotencyKey,
    actorId: input.actorId,
    operation: input.operation,
    requestHash,
    responseReference: null,
    expiresAt: new Date(now().getTime() + IDEMPOTENCY_TTL_SECONDS * 1000),
  });

  if (!claimed && existing) {
    // The payload check comes first. A different payload is a bug whatever the
    // record's status, and reporting "in progress" for it would send the caller into a
    // retry loop that can never succeed.
    if (existing.requestHash !== requestHash) {
      throw idempotencyKeyReused(input.idempotencyKey);
    }

    if (existing.status === 'in_progress') {
      throw idempotencyInProgress(input.idempotencyKey);
    }

    if (existing.status === 'failed') {
      // The first attempt failed, and this is the same request. Refused rather than
      // retried: the failure was almost certainly deterministic — a policy refusal, a
      // validation error — and retrying it silently would hide that from the caller.
      throw idempotencyKeyReused(input.idempotencyKey);
    }

    return {
      executed: false,
      result: null,
      responseReference: existing.responseReference,
    };
  }

  try {
    const { result, reference } = await input.execute();

    await input.store.complete({
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      responseReference: reference,
    });

    return { executed: true, result, responseReference: reference };
  } catch (error) {
    await input.store.fail({
      organizationId: input.organizationId,
      idempotencyKey: input.idempotencyKey,
      reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
    });
    throw error;
  }
}
