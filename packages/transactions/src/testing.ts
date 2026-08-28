import { ApiError } from '@trustos/errors';
import type { FinancialStatus } from '@trustos/financial-core';
import type { Transaction, TransactionEvent, TransactionType } from './transaction';
import type { TransactionStore } from './service';

/**
 * An in-memory transaction store, for tests and development.
 *
 * `create` throws on a duplicate idempotency key, which is what a unique index does. A fake that
 * silently overwrote would let every idempotency test pass against a store that has none.
 */
export class InMemoryTransactionStore implements TransactionStore {
  readonly transactions = new Map<string, Transaction>();
  readonly eventLog = new Map<string, TransactionEvent[]>();
  private readonly byKey = new Map<string, string>();

  async create(transaction: Transaction): Promise<Transaction> {
    if (transaction.idempotencyKey) {
      const scoped = `${transaction.organizationId ?? 'platform'}:${transaction.idempotencyKey}`;

      if (this.byKey.has(scoped)) {
        throw ApiError.conflict(`Duplicate idempotency key "${transaction.idempotencyKey}".`, {
          reason: 'duplicate_idempotency_key',
        });
      }

      this.byKey.set(scoped, transaction.id);
    }

    this.transactions.set(transaction.id, transaction);
    return transaction;
  }

  async findByIdempotencyKey(
    key: string,
    organizationId: string | null,
  ): Promise<Transaction | null> {
    const id = this.byKey.get(`${organizationId ?? 'platform'}:${key}`);
    return id ? (this.transactions.get(id) ?? null) : null;
  }

  async find(id: string, organizationId: string | null): Promise<Transaction | null> {
    const transaction = this.transactions.get(id);
    if (!transaction || transaction.organizationId !== organizationId) return null;
    return transaction;
  }

  async update(id: string, patch: Partial<Transaction>): Promise<Transaction | null> {
    const transaction = this.transactions.get(id);
    if (!transaction) return null;

    const updated = { ...transaction, ...patch } as Transaction;
    this.transactions.set(id, updated);
    return updated;
  }

  async appendEvent(transactionId: string, event: TransactionEvent): Promise<void> {
    const events = this.eventLog.get(transactionId) ?? [];
    events.push(event);
    this.eventLog.set(transactionId, events);
  }

  async events(transactionId: string, organizationId: string | null): Promise<TransactionEvent[]> {
    const transaction = this.transactions.get(transactionId);
    if (!transaction || transaction.organizationId !== organizationId) return [];
    return this.eventLog.get(transactionId) ?? [];
  }

  async list(input: {
    organizationId: string | null;
    walletId?: string;
    status?: FinancialStatus;
    type?: TransactionType;
    reference?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<Transaction[]> {
    return [...this.transactions.values()]
      .filter((transaction) => transaction.organizationId === input.organizationId)
      .filter(
        (transaction) =>
          !input.walletId ||
          transaction.sourceWalletId === input.walletId ||
          transaction.destinationWalletId === input.walletId,
      )
      .filter((transaction) => !input.status || transaction.status === input.status)
      .filter((transaction) => !input.type || transaction.type === input.type)
      .filter((transaction) => !input.reference || transaction.reference === input.reference)
      .filter((transaction) => !input.from || transaction.createdAt >= input.from)
      .filter((transaction) => !input.to || transaction.createdAt <= input.to)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, input.limit ?? 200);
  }

  async expired(organizationId: string | null, at: Date, limit = 100): Promise<Transaction[]> {
    return [...this.transactions.values()]
      .filter((transaction) => transaction.organizationId === organizationId)
      .filter((transaction) => transaction.status === 'authorized')
      .filter((transaction) => transaction.expiresAt !== null && transaction.expiresAt <= at)
      .slice(0, limit);
  }
}
