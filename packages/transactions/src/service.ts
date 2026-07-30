import { randomUUID } from 'node:crypto';
import { ApiError } from '@trustos/errors';
import type { AuditService } from '@trustos/audit';
import type { LoggerPort } from '@trustos/logging';
import {
  addMoney,
  compareMoney,
  formatMoney,
  isPositiveMoney,
  moneyFromJson,
  moneyToJson,
  subtractMoney,
  zeroMoney,
  type CurrencyRegistry,
  type FinancialStatus,
  type Money,
} from '@trustos/financial-core';
import type { AccountService } from '@trustos/accounts';
import type { Journal, Ledger } from '@trustos/ledger';
import type { WalletService } from '@trustos/wallet';
import type { FeeService } from '@trustos/fees';
import type { RiskAssessor } from '@trustos/financial-risk';
import {
  assertTransition,
  transactionSchema,
  type Transaction,
  type TransactionEvent,
  type TransactionType,
} from './transaction';

/**
 * The transaction service.
 *
 * Orchestrates the pieces: risk, fees, limits, holds and the ledger. It owns the *lifecycle*; the
 * ledger owns the money and the wallet owns the balance.
 *
 * **Idempotency is the load-bearing property.** Every operation that creates or advances a
 * transaction takes a key, and the store enforces it uniquely. A retried payment must be one
 * payment, and "retried" is the normal case — a client with a 30-second timeout against a service
 * with a 35-second p99 retries a meaningful fraction of everything.
 */

export interface TransactionStore {
  /** **Must enforce `idempotencyKey` uniquely per tenant.** See the header. */
  create(transaction: Transaction): Promise<Transaction>;
  findByIdempotencyKey(key: string, organizationId: string | null): Promise<Transaction | null>;

  find(id: string, organizationId: string | null): Promise<Transaction | null>;
  update(id: string, patch: Partial<Transaction>): Promise<Transaction | null>;

  appendEvent(transactionId: string, event: TransactionEvent): Promise<void>;
  events(transactionId: string, organizationId: string | null): Promise<TransactionEvent[]>;

  list(input: {
    organizationId: string | null;
    walletId?: string;
    status?: FinancialStatus;
    type?: TransactionType;
    reference?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<Transaction[]>;

  /** Authorized transactions past their expiry, for the sweeper. */
  expired(organizationId: string | null, at: Date, limit?: number): Promise<Transaction[]>;
}

export interface TransactionServiceOptions {
  store: TransactionStore;
  ledger: Ledger;
  wallets: WalletService;
  accounts: AccountService;
  fees?: FeeService;
  risk?: RiskAssessor;
  currencies?: CurrencyRegistry;
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  /** How long an authorization lives before the sweeper releases it. */
  authorizationTtlMs?: number;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class TransactionService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly authorizationTtlMs: number;

  constructor(private readonly options: TransactionServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID().replace(/-/g, '')}`);
    this.authorizationTtlMs = options.authorizationTtlMs ?? 7 * 86_400_000;
  }

  /**
   * Creates a transaction in `pending`.
   *
   * Nothing has moved yet. Risk runs here — before any money moves and before a hold is placed —
   * because a declined transaction should cost nothing and leave nothing behind.
   */
  async create(input: {
    organizationId: string | null;
    type: TransactionType;
    amount: Money;
    sourceWalletId?: string | null;
    sourceAccountId?: string | null;
    destinationWalletId?: string | null;
    destinationAccountId?: string | null;
    reference?: string | null;
    description?: string;
    feeScheduleKey?: string | null;
    parentTransactionId?: string | null;
    idempotencyKey?: string | null;
    metadata?: Transaction['metadata'];
    actorId?: string | null;
  }): Promise<Transaction> {
    if (!isPositiveMoney(input.amount)) {
      throw ApiError.validation(
        [
          {
            path: 'amount',
            message:
              `${formatMoney(input.amount)} is not a transaction. A negative amount is the ` +
              'opposite transaction written backwards, and it bypasses every balance check on ' +
              'the way through.',
          },
        ],
        'Invalid transaction amount.',
      );
    }

    // The idempotent replay, checked before anything else costs anything.
    if (input.idempotencyKey) {
      const existing = await this.options.store.findByIdempotencyKey(
        input.idempotencyKey,
        input.organizationId,
      );

      if (existing) {
        this.assertReplayMatches(existing, input);
        return existing;
      }
    }

    const now = this.now();

    const fee =
      input.feeScheduleKey && this.options.fees
        ? await this.options.fees.calculate({
            organizationId: input.organizationId,
            key: input.feeScheduleKey,
            amount: input.amount,
            at: now,
          })
        : null;

    const risk = this.options.risk
      ? await this.options.risk.assess({
          organizationId: input.organizationId,
          amount: input.amount,
          type: input.type,
          sourceWalletId: input.sourceWalletId ?? null,
          destinationWalletId: input.destinationWalletId ?? null,
          actorId: input.actorId ?? null,
          reference: input.reference ?? null,
          at: now,
        })
      : null;

    const transaction = transactionSchema.parse({
      id: this.newId('txn'),
      organizationId: input.organizationId,
      type: input.type,
      status: 'pending',
      amount: moneyToJson(input.amount),
      feeAmount: fee ? moneyToJson(fee.total) : null,
      feeBreakdown: fee ? { ...feeToJson(fee) } : null,
      sourceWalletId: input.sourceWalletId ?? null,
      sourceAccountId: input.sourceAccountId ?? null,
      destinationWalletId: input.destinationWalletId ?? null,
      destinationAccountId: input.destinationAccountId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      reference: input.reference ?? null,
      description: input.description ?? '',
      parentTransactionId: input.parentTransactionId ?? null,
      riskScore: risk?.score ?? null,
      riskDecision: risk?.decision ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      createdById: input.actorId ?? null,
      updatedAt: now,
    });

    let created: Transaction;

    try {
      created = await this.options.store.create(transaction);
    } catch (error) {
      // A unique-key conflict means the retry lost the race. The winner's transaction is the
      // right answer; rethrowing would make the caller retry a third time.
      const existing = input.idempotencyKey
        ? await this.options.store.findByIdempotencyKey(input.idempotencyKey, input.organizationId)
        : null;

      if (!existing) throw error;
      return existing;
    }

    await this.record(created, 'pending', 'pending', input.actorId ?? null, 'Created.');

    /*
     * A declined transaction fails immediately.
     *
     * Not left pending for somebody to act on: a declined transaction that sits in `pending` is
     * indistinguishable on every screen from one waiting for a provider.
     */
    if (risk?.decision === 'decline') {
      return this.fail({
        id: created.id,
        organizationId: input.organizationId,
        reason: risk.reason ?? 'Declined by risk assessment.',
        code: 'risk_declined',
        actorId: input.actorId,
      });
    }

    return created;
  }

  /**
   * Authorizes: places a hold on the source wallet.
   *
   * Money does not move. The hold is what makes the authorization mean something — see
   * `@trustos/wallet`.
   */
  async authorize(input: {
    id: string;
    organizationId: string | null;
    expiresAt?: Date;
    actorId?: string | null;
  }): Promise<Transaction> {
    const transaction = await this.require(input.id, input.organizationId);
    assertTransition(transaction.status, 'authorized', transaction.id);

    if (!transaction.sourceWalletId) {
      throw ApiError.validation(
        [
          {
            path: 'sourceWalletId',
            message:
              'Only a transaction with a source wallet can be authorized. There is nothing to ' +
              'hold funds against otherwise.',
          },
        ],
        'Cannot authorize this transaction.',
      );
    }

    const amount = this.amountOf(transaction);
    const total = transaction.feeAmount
      ? addMoney(amount, moneyFromJson(transaction.feeAmount, this.options.currencies))
      : amount;

    const expiresAt = input.expiresAt ?? new Date(this.now().getTime() + this.authorizationTtlMs);

    const { hold } = await this.options.wallets.hold({
      walletId: transaction.sourceWalletId,
      organizationId: input.organizationId,
      // The fee is held too. Authorizing the amount and discovering at capture that the fee does
      // not fit is a failure at the worst possible moment.
      amount: total,
      reason: `Authorization for ${transaction.id}`,
      reference: transaction.id,
      expiresAt,
      actorId: input.actorId,
    });

    return this.advance({
      transaction,
      to: 'authorized',
      patch: { holdId: hold.id, expiresAt },
      actorId: input.actorId ?? null,
      reason: `Held ${formatMoney(total)}.`,
    });
  }

  /**
   * Captures: the money moves.
   *
   * From an authorized transaction this captures the hold. From `pending` it moves directly, which
   * is the right shape for a transfer between two internal wallets — there is nothing to authorize
   * against an internal counterparty.
   */
  async capture(input: {
    id: string;
    organizationId: string | null;
    amount?: Money;
    actorId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ transaction: Transaction; journals: Journal[] }> {
    const transaction = await this.require(input.id, input.organizationId);
    assertTransition(transaction.status, 'captured', transaction.id);

    const amount = input.amount ?? this.amountOf(transaction);
    const journals: Journal[] = [];

    const destination = await this.destinationAccountId(transaction);

    if (transaction.holdId && transaction.sourceWalletId) {
      const captured = await this.options.wallets.capture({
        holdId: transaction.holdId,
        organizationId: input.organizationId,
        amount,
        toAccountId: destination,
        description: transaction.description || `Capture for ${transaction.id}`,
        reference: transaction.reference,
        idempotencyKey: input.idempotencyKey ?? `capture:${transaction.id}`,
        actorId: input.actorId,
      });

      journals.push(captured.journal);
    } else if (transaction.sourceWalletId) {
      const debited = await this.options.wallets.debit({
        walletId: transaction.sourceWalletId,
        organizationId: input.organizationId,
        amount,
        toAccountId: destination,
        description: transaction.description || `Capture for ${transaction.id}`,
        reference: transaction.reference,
        idempotencyKey: input.idempotencyKey ?? `capture:${transaction.id}`,
        actorId: input.actorId,
      });

      journals.push(debited.journal);
    } else if (transaction.destinationWalletId && transaction.sourceAccountId) {
      // A deposit: money arriving from outside into a wallet.
      const credited = await this.options.wallets.credit({
        walletId: transaction.destinationWalletId,
        organizationId: input.organizationId,
        amount,
        fromAccountId: transaction.sourceAccountId,
        description: transaction.description || `Deposit for ${transaction.id}`,
        reference: transaction.reference,
        idempotencyKey: input.idempotencyKey ?? `capture:${transaction.id}`,
        actorId: input.actorId,
      });

      journals.push(credited.journal);
    } else {
      throw ApiError.validation(
        [
          {
            path: 'transaction',
            message:
              `Transaction ${transaction.id} has no wallet on either side, so there is nothing ` +
              'for the service to move. Post the journal directly.',
          },
        ],
        'Nothing to capture.',
      );
    }

    const updated = await this.advance({
      transaction,
      to: 'captured',
      patch: { journalIds: [...transaction.journalIds, ...journals.map((journal) => journal.id)] },
      actorId: input.actorId ?? null,
      reason: `Captured ${formatMoney(amount)}.`,
      journalId: journals[0]?.id ?? null,
    });

    return { transaction: updated, journals };
  }

  /** Marks a captured transaction finished. The point at which it is included in settlement. */
  async complete(input: {
    id: string;
    organizationId: string | null;
    actorId?: string | null;
  }): Promise<Transaction> {
    const transaction = await this.require(input.id, input.organizationId);
    assertTransition(transaction.status, 'completed', transaction.id);

    return this.advance({
      transaction,
      to: 'completed',
      patch: { completedAt: this.now() },
      actorId: input.actorId ?? null,
      reason: 'Completed.',
    });
  }

  /**
   * Fails a transaction, releasing any hold.
   *
   * The hold release is not optional and not a follow-up call. A failed transaction whose hold
   * survives is money the customer cannot spend for a reason that no longer exists.
   */
  async fail(input: {
    id: string;
    organizationId: string | null;
    reason: string;
    code?: string;
    actorId?: string | null;
  }): Promise<Transaction> {
    const transaction = await this.require(input.id, input.organizationId);
    assertTransition(transaction.status, 'failed', transaction.id);

    await this.releaseHold(
      transaction,
      input.organizationId,
      `Transaction failed: ${input.reason}`,
    );

    return this.advance({
      transaction,
      to: 'failed',
      patch: { failureReason: input.reason, failureCode: input.code ?? null, holdId: null },
      actorId: input.actorId ?? null,
      reason: input.reason,
    });
  }

  async cancel(input: {
    id: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
  }): Promise<Transaction> {
    const transaction = await this.require(input.id, input.organizationId);
    assertTransition(transaction.status, 'cancelled', transaction.id);

    await this.releaseHold(
      transaction,
      input.organizationId,
      `Transaction cancelled: ${input.reason}`,
    );

    return this.advance({
      transaction,
      to: 'cancelled',
      patch: { holdId: null },
      actorId: input.actorId ?? null,
      reason: input.reason,
    });
  }

  /**
   * Reverses a captured or completed transaction.
   *
   * Posts the mirror journal. The original transaction stays, marked `reversed`, and both records
   * remain — which is what lets somebody a year later see that it happened and was undone.
   */
  async reverse(input: {
    id: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
  }): Promise<{ transaction: Transaction; journals: Journal[] }> {
    const transaction = await this.require(input.id, input.organizationId);
    assertTransition(transaction.status, 'reversed', transaction.id);

    const journals: Journal[] = [];

    for (const journalId of transaction.journalIds) {
      const { reversal } = await this.options.ledger.reverse({
        journalId,
        organizationId: input.organizationId,
        reason: input.reason,
        actorId: input.actorId,
      });

      journals.push(reversal);
    }

    const updated = await this.advance({
      transaction,
      to: 'reversed',
      patch: { journalIds: [...transaction.journalIds, ...journals.map((journal) => journal.id)] },
      actorId: input.actorId ?? null,
      reason: input.reason,
      journalId: journals[0]?.id ?? null,
    });

    return { transaction: updated, journals };
  }

  /**
   * Refunds a completed transaction, wholly or partly.
   *
   * A refund is a **new transaction**, not a state change on the original — the original still
   * happened, and a customer statement that erased it would be wrong. The original records how
   * much has been refunded so far, so a second refund cannot take it past the amount.
   */
  async refund(input: {
    id: string;
    organizationId: string | null;
    amount?: Money;
    reason: string;
    idempotencyKey?: string | null;
    actorId?: string | null;
  }): Promise<{ original: Transaction; refund: Transaction }> {
    const original = await this.require(input.id, input.organizationId);

    if (original.status !== 'completed' && original.status !== 'refunded') {
      throw ApiError.conflict(
        `Transaction ${original.id} is ${original.status}. Only a completed transaction can be ` +
          'refunded — an uncaptured one is cancelled, and a captured one is reversed.',
        { reason: 'not_refundable', transactionId: original.id, status: original.status },
      );
    }

    const total = this.amountOf(original);
    const alreadyRefunded = original.refundedAmount
      ? moneyFromJson(original.refundedAmount, this.options.currencies)
      : zeroMoney(total.currency, this.options.currencies);

    const remaining = subtractMoney(total, alreadyRefunded);
    const amount = input.amount ?? remaining;

    if (compareMoney(amount, remaining) > 0) {
      throw ApiError.validation(
        [
          {
            path: 'amount',
            message:
              `Cannot refund ${formatMoney(amount)}: ${formatMoney(total)} was charged and ` +
              `${formatMoney(alreadyRefunded)} has already been refunded, leaving ` +
              `${formatMoney(remaining)}. Refunding more than was charged is a payment, not a ` +
              'refund.',
          },
        ],
        'Refund exceeds the remaining amount.',
      );
    }

    // The refund reverses the direction: the destination pays the source back.
    const refund = await this.create({
      organizationId: input.organizationId,
      type: 'refund',
      amount,
      sourceWalletId: original.destinationWalletId,
      sourceAccountId: original.destinationAccountId,
      destinationWalletId: original.sourceWalletId,
      destinationAccountId: original.sourceAccountId,
      reference: original.reference,
      description: `Refund of ${original.id}: ${input.reason}`,
      parentTransactionId: original.id,
      idempotencyKey: input.idempotencyKey ?? `refund:${original.id}:${formatMoney(amount)}`,
      actorId: input.actorId,
    });

    const refunded = addMoney(alreadyRefunded, amount);

    const updated = await this.options.store.update(original.id, {
      refundedAmount: moneyToJson(refunded),
      status: 'refunded',
      updatedAt: this.now(),
    });

    await this.options.store.appendEvent(original.id, {
      at: this.now(),
      from: original.status,
      to: 'refunded',
      actorId: input.actorId ?? null,
      reason: `Refunded ${formatMoney(amount)}: ${input.reason}`,
      journalId: null,
    });

    await this.options.audit?.record({
      action: 'transactions.transaction.refunded',
      entityType: 'Transaction',
      entityId: original.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      after: {
        refundTransactionId: refund.id,
        amount: formatMoney(amount),
        totalRefunded: formatMoney(refunded),
        reason: input.reason,
      },
    });

    return { original: updated ?? original, refund };
  }

  /**
   * Expires authorizations nobody captured.
   *
   * Run on a schedule, and it releases the hold as well as marking the transaction. Marking one
   * without the other leaves the customer's money held against a transaction the system has given
   * up on.
   */
  async expireStale(input: {
    organizationId: string | null;
    limit?: number;
  }): Promise<{ expired: number; transactionIds: string[] }> {
    const now = this.now();
    const stale = await this.options.store.expired(input.organizationId, now, input.limit ?? 100);
    const transactionIds: string[] = [];

    for (const transaction of stale) {
      if (transaction.status !== 'authorized') continue;

      await this.releaseHold(
        transaction,
        input.organizationId,
        `Authorization expired at ${transaction.expiresAt?.toISOString()}.`,
      );

      await this.advance({
        transaction,
        to: 'expired',
        patch: { holdId: null },
        actorId: null,
        reason: 'Authorization expired without capture.',
      });

      transactionIds.push(transaction.id);
    }

    return { expired: transactionIds.length, transactionIds };
  }

  async get(id: string, organizationId: string | null): Promise<Transaction> {
    return this.require(id, organizationId);
  }

  async history(id: string, organizationId: string | null): Promise<TransactionEvent[]> {
    await this.require(id, organizationId);
    return this.options.store.events(id, organizationId);
  }

  async list(input: Parameters<TransactionStore['list']>[0]): Promise<Transaction[]> {
    return this.options.store.list(input);
  }

  /**
   * Refuses a replay whose parameters differ.
   *
   * An idempotency key that returns a *different* transaction's result is worse than no
   * idempotency: the caller believes their new payment succeeded and it was somebody else's. So a
   * key reused with different parameters is a conflict, not a replay.
   */
  private assertReplayMatches(
    existing: Transaction,
    input: { amount: Money; type: TransactionType },
  ): void {
    const sameAmount =
      existing.amount.currency === input.amount.currency &&
      compareMoney(this.amountOf(existing), input.amount) === 0;

    if (sameAmount && existing.type === input.type) return;

    throw ApiError.conflict(
      `The idempotency key "${existing.idempotencyKey}" was already used for a ` +
        `${existing.type} of ${formatMoney(this.amountOf(existing))}, and this request is a ` +
        `${input.type} of ${formatMoney(input.amount)}. Returning the earlier result would tell ` +
        'you a different payment succeeded.',
      { reason: 'idempotency_conflict', transactionId: existing.id },
    );
  }

  private async advance(input: {
    transaction: Transaction;
    to: FinancialStatus;
    patch: Partial<Transaction>;
    actorId: string | null;
    reason: string;
    journalId?: string | null;
  }): Promise<Transaction> {
    const now = this.now();

    const updated = await this.options.store.update(input.transaction.id, {
      ...input.patch,
      status: input.to,
      updatedAt: now,
    });

    if (!updated) throw ApiError.notFound(`No transaction with id "${input.transaction.id}".`);

    await this.record(
      input.transaction,
      input.transaction.status,
      input.to,
      input.actorId,
      input.reason,
      input.journalId ?? null,
    );

    await this.options.audit?.record({
      action: `transactions.transaction.${input.to}`,
      entityType: 'Transaction',
      entityId: input.transaction.id,
      actorId: input.actorId,
      organizationId: input.transaction.organizationId,
      before: { status: input.transaction.status },
      after: {
        status: input.to,
        amount: formatMoney(this.amountOf(input.transaction)),
        reason: input.reason,
        journalId: input.journalId ?? null,
      },
    });

    return updated;
  }

  private async record(
    transaction: Transaction,
    from: FinancialStatus,
    to: FinancialStatus,
    actorId: string | null,
    reason: string,
    journalId: string | null = null,
  ): Promise<void> {
    await this.options.store.appendEvent(transaction.id, {
      at: this.now(),
      from,
      to,
      actorId,
      reason,
      journalId,
    });
  }

  private async releaseHold(
    transaction: Transaction,
    organizationId: string | null,
    reason: string,
  ): Promise<void> {
    if (!transaction.holdId) return;

    try {
      await this.options.wallets.release({
        holdId: transaction.holdId,
        organizationId,
        reason,
      });
    } catch (error) {
      /*
       * A hold that was already released is not a failure.
       *
       * The alternative — rethrowing — means a transaction cannot be failed because its hold is
       * already gone, and it sits in `authorized` forever with nothing holding anything.
       */
      this.options.logger?.warn(
        {
          transactionId: transaction.id,
          holdId: transaction.holdId,
          error: error instanceof Error ? error.message : String(error),
        },
        'could not release the hold while resolving a transaction',
      );
    }
  }

  private async destinationAccountId(transaction: Transaction): Promise<string> {
    if (transaction.destinationAccountId) return transaction.destinationAccountId;

    if (transaction.destinationWalletId) {
      const wallet = await this.options.wallets.get(
        transaction.destinationWalletId,
        transaction.organizationId,
      );

      return wallet.accountId;
    }

    throw ApiError.validation(
      [
        {
          path: 'destination',
          message: `Transaction ${transaction.id} has no destination, so there is nowhere to post.`,
        },
      ],
      'No destination.',
    );
  }

  private amountOf(transaction: Transaction): Money {
    return moneyFromJson(transaction.amount, this.options.currencies);
  }

  private async require(id: string, organizationId: string | null): Promise<Transaction> {
    const transaction = await this.options.store.find(id, organizationId);
    if (!transaction) throw ApiError.notFound(`No transaction with id "${id}".`);
    return transaction;
  }
}

/** The fee calculation as plain JSON, for the transaction row. */
function feeToJson(fee: {
  scheduleKey: string;
  scheduleVersion: number;
  total: Money;
  lines: Array<{ name: string; amount: Money; explanation: string }>;
  adjustment: string | null;
}): Record<string, unknown> {
  return {
    scheduleKey: fee.scheduleKey,
    scheduleVersion: fee.scheduleVersion,
    total: moneyToJson(fee.total),
    adjustment: fee.adjustment,
    lines: fee.lines.map((line) => ({
      name: line.name,
      amount: moneyToJson(line.amount),
      explanation: line.explanation,
    })),
  };
}
