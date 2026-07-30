import {
  addMoney,
  subtractMoney,
  zeroMoney,
  type CurrencyRegistry,
  type Money,
} from '@trustos/financial-core';
import type { Limit, LimitScope, LimitStore, LimitUsage } from './limits';

/**
 * An in-memory limit store, for tests and development.
 *
 * The idempotency set is the part that matters: a `consume` with a key that has already been seen
 * is a no-op, so a retried transaction does not consume the customer's daily limit twice. A real
 * store gets this from a unique index.
 */
export class InMemoryLimitStore implements LimitStore {
  readonly limits: Limit[] = [];
  private readonly records = new Map<string, LimitUsage>();
  private readonly consumed = new Set<string>();

  constructor(private readonly currencies?: CurrencyRegistry) {}

  add(limit: Limit): Limit {
    this.limits.push(limit);
    return limit;
  }

  async applicable(input: {
    organizationId: string | null;
    scope: LimitScope;
    currency?: string;
  }): Promise<Limit[]> {
    return this.limits
      .filter((limit) => limit.organizationId === input.organizationId)
      .filter((limit) => limit.scope === input.scope);
  }

  async usage(input: {
    limit: Limit;
    subjectId: string;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<LimitUsage | null> {
    return this.records.get(this.key(input.limit, input.subjectId, input.windowStart)) ?? null;
  }

  async consume(input: {
    limit: Limit;
    subjectId: string;
    windowStart: Date;
    windowEnd: Date;
    amount: Money | null;
    count: number;
    idempotencyKey: string | null;
  }): Promise<LimitUsage> {
    const key = this.key(input.limit, input.subjectId, input.windowStart);

    if (input.idempotencyKey) {
      const scoped = `${key}:${input.idempotencyKey}`;
      // A retried transaction must not consume the limit twice.
      if (this.consumed.has(scoped)) return this.records.get(key)!;
      this.consumed.add(scoped);
    }

    const current =
      this.records.get(key) ??
      ({
        limitId: input.limit.id,
        subjectId: input.subjectId,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        amount: input.limit.currency ? zeroMoney(input.limit.currency, this.currencies) : null,
        count: 0,
      } satisfies LimitUsage);

    const updated: LimitUsage = {
      ...current,
      amount:
        input.amount && current.amount ? addMoney(current.amount, input.amount) : current.amount,
      count: current.count + input.count,
    };

    this.records.set(key, updated);
    return updated;
  }

  async wasConsumed(input: {
    organizationId: string | null;
    idempotencyKey: string;
  }): Promise<boolean> {
    // A real store queries a unique index on (organizationId, idempotencyKey). The suffix match
    // here is the same question asked of an in-memory set.
    return [...this.consumed].some((entry) => entry.endsWith(`:${input.idempotencyKey}`));
  }

  async release(input: {
    limit: Limit;
    subjectId: string;
    windowStart: Date;
    amount: Money | null;
    count: number;
    idempotencyKey: string;
  }): Promise<void> {
    const key = this.key(input.limit, input.subjectId, input.windowStart);
    const current = this.records.get(key);
    if (!current) return;

    this.records.set(key, {
      ...current,
      amount:
        input.amount && current.amount
          ? subtractMoney(current.amount, input.amount)
          : current.amount,
      count: Math.max(0, current.count - input.count),
    });

    this.consumed.delete(`${key}:${input.idempotencyKey}`);
  }

  private key(limit: Limit, subjectId: string, windowStart: Date): string {
    return `${limit.id}:${subjectId}:${windowStart.toISOString()}`;
  }
}
