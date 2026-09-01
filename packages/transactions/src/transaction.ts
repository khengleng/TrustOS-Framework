import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import { moneySchema, type FinancialStatus } from '@trustsystem/financial-core';

/**
 * The transaction lifecycle.
 *
 * A transaction is the *business* record of a movement; the journal is the accounting record. They
 * are separate because one transaction can produce several journals — an authorization, a capture,
 * a fee, a refund — and because a transaction can fail before any journal exists.
 *
 * **The state machine is declared, not implied.** Every allowed transition is in the table below,
 * and everything else is refused. The alternative is a set of `if (status === ...)` checks spread
 * across a service, and the transition nobody thought about is the one that lets a refunded
 * transaction be captured again.
 */

export const TRANSACTION_TYPES = [
  /** Money into the platform from outside. */
  'deposit',
  /** Money out of the platform. */
  'withdrawal',
  /** Between two wallets inside the platform. */
  'transfer',
  /** A customer paying a merchant. */
  'payment',
  /** Money returned to a payer. */
  'refund',
  /** A fee charged. */
  'fee',
  /** A correction posted by an operator. */
  'adjustment',
] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * Allowed transitions.
 *
 * Read it as: from this state, only these. A state with an empty list is terminal.
 *
 * Two are worth pointing at. `completed → refunded` exists because a refund is a state of the
 * original transaction as well as a transaction of its own. `captured → completed` is separate
 * from `captured → reversed` because a capture that settles and one that is undone are different
 * outcomes, and collapsing them loses which happened.
 */
export const TRANSITIONS: Record<FinancialStatus, readonly FinancialStatus[]> = {
  pending: ['authorized', 'captured', 'completed', 'failed', 'cancelled', 'expired'],
  authorized: ['captured', 'completed', 'cancelled', 'expired', 'failed'],
  captured: ['completed', 'reversed', 'failed'],
  completed: ['reversed', 'refunded'],
  failed: [],
  cancelled: [],
  expired: [],
  reversed: [],
  refunded: ['refunded'],
};

export function canTransition(from: FinancialStatus, to: FinancialStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Refuses a transition that is not in the table.
 *
 * The message says what *is* allowed, because the caller trying an illegal transition usually has
 * the wrong transaction rather than the wrong idea.
 */
export function assertTransition(from: FinancialStatus, to: FinancialStatus, id: string): void {
  if (canTransition(from, to)) return;

  const allowed = TRANSITIONS[from];

  throw ApiError.conflict(
    `Transaction ${id} is ${from} and cannot become ${to}. ` +
      (allowed.length === 0
        ? `${from} is a final state; a correction is a new transaction.`
        : `From ${from} it can only become: ${allowed.join(', ')}.`),
    { reason: 'invalid_transition', transactionId: id, from, to },
  );
}

export const transactionSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),

    type: z.enum(TRANSACTION_TYPES),
    status: z
      .enum([
        'pending',
        'authorized',
        'captured',
        'completed',
        'failed',
        'cancelled',
        'expired',
        'reversed',
        'refunded',
      ])
      .default('pending'),

    amount: moneySchema,
    /** The fee charged on this transaction, if any. Separate, so net and gross are both visible. */
    feeAmount: moneySchema.nullable().default(null),
    /** The fee calculation, stored whole. See `@trustsystem/fees` — it shows its working. */
    feeBreakdown: z.record(z.unknown()).nullable().default(null),

    /** Where the money came from and went. Wallet ids, account ids, or an external marker. */
    sourceWalletId: z.string().max(120).nullable().default(null),
    sourceAccountId: z.string().max(120).nullable().default(null),
    destinationWalletId: z.string().max(120).nullable().default(null),
    destinationAccountId: z.string().max(120).nullable().default(null),

    /** A hold placed at authorization, captured at capture. */
    holdId: z.string().max(120).nullable().default(null),

    /** Every journal this transaction produced, in order. */
    journalIds: z.array(z.string().max(120)).max(100).default([]),

    /**
     * The idempotency key.
     *
     * Stored on the row and unique per tenant. This is what makes a retried payment one payment,
     * and it is a database constraint rather than a check — two workers retrying together both
     * pass a check.
     */
    idempotencyKey: z.string().max(200).nullable().default(null),

    /** A human reference: an invoice number, an order id. */
    reference: z.string().max(120).nullable().default(null),
    description: z.string().max(1000).default(''),

    /** The transaction this one refunds or reverses. */
    parentTransactionId: z.string().max(120).nullable().default(null),
    /** How much of this transaction has been refunded, across all refunds. */
    refundedAmount: moneySchema.nullable().default(null),

    /** Why it failed. Never a stack trace. */
    failureReason: z.string().max(500).nullable().default(null),
    failureCode: z.string().max(60).nullable().default(null),

    /** Set by a risk hook. The platform records it and does not compute it. */
    riskScore: z.number().min(0).max(100).nullable().default(null),
    riskDecision: z.enum(['approve', 'review', 'decline']).nullable().default(null),

    /** When an authorized transaction expires if not captured. */
    expiresAt: z.coerce.date().nullable().default(null),

    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),

    createdAt: z.coerce.date(),
    createdById: z.string().nullable().default(null),
    updatedAt: z.coerce.date(),
    completedAt: z.coerce.date().nullable().default(null),
  })
  .strict()
  .superRefine((transaction, ctx) => {
    const hasSource = transaction.sourceWalletId !== null || transaction.sourceAccountId !== null;
    const hasDestination =
      transaction.destinationWalletId !== null || transaction.destinationAccountId !== null;

    if (!hasSource && !hasDestination) {
      /*
       * A transaction with neither end.
       *
       * It can never post a journal, because there is nothing to debit or credit — so it sits in
       * `pending` forever and appears on every operations report as work in progress.
       */
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceWalletId'],
        message:
          'A transaction needs a source or a destination. With neither it can never post a ' +
          'journal, so it stays pending forever.',
      });
    }

    if (transaction.type === 'refund' && transaction.parentTransactionId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parentTransactionId'],
        message: 'A refund must name the transaction it refunds.',
      });
    }
  });

export type Transaction = z.infer<typeof transactionSchema>;

/** One step in a transaction's life. The audit trail a support agent reads. */
export const transactionEventSchema = z
  .object({
    at: z.coerce.date(),
    from: z.string().max(40),
    to: z.string().max(40),
    actorId: z.string().nullable(),
    reason: z.string().max(500).nullable().default(null),
    journalId: z.string().max(120).nullable().default(null),
  })
  .strict();

export type TransactionEvent = z.infer<typeof transactionEventSchema>;

/**
 * Whether a transaction still holds funds that should be released.
 *
 * An authorized transaction that failed, expired or was cancelled has a hold nobody is coming
 * back for. Used by the sweeper.
 */
export function shouldReleaseHold(transaction: Transaction): boolean {
  return (
    transaction.holdId !== null && ['failed', 'cancelled', 'expired'].includes(transaction.status)
  );
}
