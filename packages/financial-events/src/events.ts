import { z } from 'zod';
import { buildEvent, type EventActor, type EventEnvelope } from '@trustsystem/event-sdk';
import { formatMoney, moneySchema, moneyToJson, type Money } from '@trustsystem/financial-core';

/**
 * The financial event catalog.
 *
 * Every event a financial system publishes, with a payload schema for each. Registered with
 * `@trustsystem/event-registry` at start-up, which is what makes a renamed field fail at the publisher
 * rather than at three consumers.
 *
 * **Amounts travel as strings, never as numbers.** A JSON number goes through a double on the way
 * out and again on the way in, and a subscriber that computes a total from event payloads gets a
 * number that disagrees with the ledger. Every amount here is `{ currency, amount }` with a string
 * amount, the same shape the rest of the phase uses.
 *
 * **Events carry ids and outcomes, not balances.** A `WalletCredited` event does not include the
 * resulting balance, and that is deliberate: by the time a subscriber reads it, the balance may
 * have changed twice. An event that carries a balance invites a subscriber to display a stale one.
 */

export const FINANCIAL_EVENTS = {
  WALLET_CREATED: 'financial.wallet.created',
  WALLET_FROZEN: 'financial.wallet.frozen',
  WALLET_UNFROZEN: 'financial.wallet.unfrozen',
  WALLET_CREDITED: 'financial.wallet.credited',
  WALLET_DEBITED: 'financial.wallet.debited',

  TRANSACTION_CREATED: 'financial.transaction.created',
  TRANSACTION_AUTHORIZED: 'financial.transaction.authorized',
  TRANSACTION_CAPTURED: 'financial.transaction.captured',
  TRANSACTION_COMPLETED: 'financial.transaction.completed',
  TRANSACTION_FAILED: 'financial.transaction.failed',
  TRANSACTION_REVERSED: 'financial.transaction.reversed',
  TRANSACTION_REFUNDED: 'financial.transaction.refunded',

  JOURNAL_POSTED: 'financial.journal.posted',
  JOURNAL_REVERSED: 'financial.journal.reversed',

  SETTLEMENT_SENT: 'financial.settlement.sent',
  SETTLEMENT_COMPLETED: 'financial.settlement.completed',
  SETTLEMENT_FAILED: 'financial.settlement.failed',

  FEE_APPLIED: 'financial.fee.applied',

  LIMIT_EXCEEDED: 'financial.limit.exceeded',
  LIMIT_WARNING: 'financial.limit.warning',

  RECONCILIATION_COMPLETED: 'financial.reconciliation.completed',
  RECONCILIATION_EXCEPTION_RAISED: 'financial.reconciliation.exception_raised',

  PAYMENT_REQUEST_CREATED: 'financial.payment_request.created',
  PAYMENT_REQUEST_PAID: 'financial.payment_request.paid',
  PAYMENT_REQUEST_EXPIRED: 'financial.payment_request.expired',
} as const;

export type FinancialEventName = (typeof FINANCIAL_EVENTS)[keyof typeof FINANCIAL_EVENTS];

const base = {
  /** Which tenant. Always present, and a subscriber must scope on it. */
  organizationId: z.string().nullable(),
};

export const walletCreatedSchema = z
  .object({
    ...base,
    walletId: z.string(),
    ownerId: z.string(),
    currency: z.string(),
    accountId: z.string(),
  })
  .strict();

export const walletFrozenSchema = z
  .object({ ...base, walletId: z.string(), ownerId: z.string(), reason: z.string() })
  .strict();

export const walletMovementSchema = z
  .object({
    ...base,
    walletId: z.string(),
    amount: moneySchema,
    journalId: z.string(),
    reference: z.string().nullable(),
  })
  .strict();

export const transactionEventSchema = z
  .object({
    ...base,
    transactionId: z.string(),
    type: z.string(),
    status: z.string(),
    amount: moneySchema,
    feeAmount: moneySchema.nullable(),
    reference: z.string().nullable(),
    /** Set on failure. A short code, never a stack trace. */
    failureCode: z.string().nullable(),
  })
  .strict();

export const journalPostedSchema = z
  .object({
    ...base,
    journalId: z.string(),
    ledgerId: z.string(),
    reference: z.string().nullable(),
    description: z.string(),
    entryCount: z.number().int(),
    /** Totals per currency, so a subscriber does not have to re-add the entries. */
    totals: z.array(z.object({ currency: z.string(), amount: z.string() })),
    effectiveAt: z.string(),
  })
  .strict();

export const journalReversedSchema = z
  .object({
    ...base,
    journalId: z.string(),
    reversalJournalId: z.string(),
    reason: z.string(),
  })
  .strict();

export const settlementEventSchema = z
  .object({
    ...base,
    batchId: z.string(),
    reference: z.string(),
    currency: z.string(),
    instructionCount: z.number().int(),
    totalAmount: moneySchema,
    settledAmount: moneySchema.nullable(),
    returnedAmount: moneySchema.nullable(),
    failureReason: z.string().nullable(),
  })
  .strict();

export const feeAppliedSchema = z
  .object({
    ...base,
    transactionId: z.string().nullable(),
    scheduleKey: z.string(),
    scheduleVersion: z.number().int(),
    baseAmount: moneySchema,
    feeAmount: moneySchema,
  })
  .strict();

export const limitEventSchema = z
  .object({
    ...base,
    limitKey: z.string(),
    limitName: z.string(),
    scope: z.string(),
    subjectId: z.string(),
    kind: z.enum(['amount', 'count']),
    used: z.string(),
    allowed: z.string(),
  })
  .strict();

export const reconciliationCompletedSchema = z
  .object({
    ...base,
    runId: z.string(),
    key: z.string(),
    matched: z.number().int(),
    exceptions: z.number().int(),
    difference: moneySchema,
  })
  .strict();

export const reconciliationExceptionSchema = z
  .object({
    ...base,
    runId: z.string(),
    exceptionId: z.string(),
    kind: z.string(),
    reference: z.string(),
    detail: z.string(),
  })
  .strict();

export const paymentRequestEventSchema = z
  .object({
    ...base,
    paymentRequestId: z.string(),
    reference: z.string(),
    amount: moneySchema,
    paidAmount: moneySchema.nullable(),
    status: z.string(),
    invoiceReference: z.string().nullable(),
  })
  .strict();

/**
 * The catalog, ready to register.
 *
 * Every event with its schema and a one-line description of when it fires. `register` in
 * `@trustsystem/event-registry` takes this shape, so the whole phase's contract is one call.
 */
export const FINANCIAL_EVENT_DEFINITIONS = [
  {
    name: FINANCIAL_EVENTS.WALLET_CREATED,
    version: '1',
    schema: walletCreatedSchema,
    description: 'A wallet was opened, along with the ledger account behind it.',
  },
  {
    name: FINANCIAL_EVENTS.WALLET_FROZEN,
    version: '1',
    schema: walletFrozenSchema,
    description: 'A wallet was frozen. Money can still leave it; nothing new may arrive.',
  },
  {
    name: FINANCIAL_EVENTS.WALLET_UNFROZEN,
    version: '1',
    schema: walletFrozenSchema,
    description: 'A frozen wallet was returned to normal.',
  },
  {
    name: FINANCIAL_EVENTS.WALLET_CREDITED,
    version: '1',
    schema: walletMovementSchema,
    description: 'Money arrived in a wallet. Carries the journal, not the resulting balance.',
  },
  {
    name: FINANCIAL_EVENTS.WALLET_DEBITED,
    version: '1',
    schema: walletMovementSchema,
    description: 'Money left a wallet, against its available balance rather than its total.',
  },
  {
    name: FINANCIAL_EVENTS.TRANSACTION_CREATED,
    version: '1',
    schema: transactionEventSchema,
    description: 'A transaction was created. Nothing has moved yet.',
  },
  {
    name: FINANCIAL_EVENTS.TRANSACTION_AUTHORIZED,
    version: '1',
    schema: transactionEventSchema,
    description: 'Funds were held against the payer. Still nothing has moved.',
  },
  {
    name: FINANCIAL_EVENTS.TRANSACTION_CAPTURED,
    version: '1',
    schema: transactionEventSchema,
    description: 'The money moved. A journal was posted and the balances changed.',
  },
  {
    name: FINANCIAL_EVENTS.TRANSACTION_COMPLETED,
    version: '1',
    schema: transactionEventSchema,
    description: 'The transaction finished and is eligible for settlement.',
  },
  {
    name: FINANCIAL_EVENTS.TRANSACTION_FAILED,
    version: '1',
    schema: transactionEventSchema,
    description: 'The transaction failed. Any hold has been released.',
  },
  {
    name: FINANCIAL_EVENTS.TRANSACTION_REVERSED,
    version: '1',
    schema: transactionEventSchema,
    description: 'A completed transaction was undone by a compensating journal.',
  },
  {
    name: FINANCIAL_EVENTS.TRANSACTION_REFUNDED,
    version: '1',
    schema: transactionEventSchema,
    description: 'Money was returned to the payer by a separate transaction.',
  },
  {
    name: FINANCIAL_EVENTS.JOURNAL_POSTED,
    version: '1',
    schema: journalPostedSchema,
    description: 'A balanced journal was posted. Immutable from this point.',
  },
  {
    name: FINANCIAL_EVENTS.JOURNAL_REVERSED,
    version: '1',
    schema: journalReversedSchema,
    description: 'A posted journal was reversed by its mirror image. Both records remain.',
  },
  {
    name: FINANCIAL_EVENTS.SETTLEMENT_SENT,
    version: '1',
    schema: settlementEventSchema,
    description: 'A batch was sent. The money is in the settlement account until it is confirmed.',
  },
  {
    name: FINANCIAL_EVENTS.SETTLEMENT_COMPLETED,
    version: '1',
    schema: settlementEventSchema,
    description: 'A counterparty confirmed a batch, wholly or with returns.',
  },
  {
    name: FINANCIAL_EVENTS.SETTLEMENT_FAILED,
    version: '1',
    schema: settlementEventSchema,
    description: 'A counterparty rejected a batch. The send has been reversed.',
  },
  {
    name: FINANCIAL_EVENTS.FEE_APPLIED,
    version: '1',
    schema: feeAppliedSchema,
    description: 'A fee was computed and charged, naming the schedule version that priced it.',
  },
  {
    name: FINANCIAL_EVENTS.LIMIT_EXCEEDED,
    version: '1',
    schema: limitEventSchema,
    description: 'A movement was refused because it would exceed a limit.',
  },
  {
    name: FINANCIAL_EVENTS.LIMIT_WARNING,
    version: '1',
    schema: limitEventSchema,
    description: 'A warn-only limit was crossed. Nothing was refused.',
  },
  {
    name: FINANCIAL_EVENTS.RECONCILIATION_COMPLETED,
    version: '1',
    schema: reconciliationCompletedSchema,
    description: 'A reconciliation run finished, with its match count and its difference.',
  },
  {
    name: FINANCIAL_EVENTS.RECONCILIATION_EXCEPTION_RAISED,
    version: '1',
    schema: reconciliationExceptionSchema,
    description: 'A reconciliation difference needs somebody to look at it.',
  },
  {
    name: FINANCIAL_EVENTS.PAYMENT_REQUEST_CREATED,
    version: '1',
    schema: paymentRequestEventSchema,
    description: 'A payment request was raised.',
  },
  {
    name: FINANCIAL_EVENTS.PAYMENT_REQUEST_PAID,
    version: '1',
    schema: paymentRequestEventSchema,
    description: 'A payment request was settled, wholly or partly.',
  },
  {
    name: FINANCIAL_EVENTS.PAYMENT_REQUEST_EXPIRED,
    version: '1',
    schema: paymentRequestEventSchema,
    description: 'A payment request was not paid within its window.',
  },
] as const;

/**
 * Builds a financial event envelope.
 *
 * A thin wrapper over `buildEvent` that fills in the source and validates the payload against the
 * catalog before it is published — so a payload that does not match its schema fails at the
 * publisher rather than at whichever subscriber notices first.
 */
export function financialEvent<TPayload extends Record<string, unknown>>(input: {
  name: FinancialEventName;
  payload: TPayload;
  organizationId: string | null;
  actor: EventActor;
  aggregate?: { type: string; id: string } | null;
  correlationId?: string;
  idempotencyKey?: string;
  occurredAt?: Date;
}): EventEnvelope<TPayload> {
  const definition = FINANCIAL_EVENT_DEFINITIONS.find((entry) => entry.name === input.name);

  if (definition) {
    // Validated here, at the publisher. A subscriber discovering a malformed payload cannot tell
    // whether it is a bad publisher or a stale schema.
    definition.schema.parse({ ...input.payload, organizationId: input.organizationId });
  }

  return buildEvent<TPayload>({
    name: input.name,
    version: definition?.version ?? '1',
    payload: input.payload,
    organizationId: input.organizationId,
    actor: input.actor,
    aggregate: input.aggregate ?? null,
    source: 'financial',
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  });
}

/** Money as an event payload carries it: a string amount, never a number. */
export function eventMoney(amount: Money): z.infer<typeof moneySchema> {
  return moneyToJson(amount);
}

/** A one-line description of an event, for a log or an operator screen. */
export function describeFinancialEvent(envelope: EventEnvelope): string {
  const payload = envelope.payload as Record<string, unknown>;
  const amount = payload.amount as { amount?: string; currency?: string } | undefined;

  return (
    `${envelope.name}` +
    (amount?.amount ? ` ${amount.amount} ${amount.currency}` : '') +
    (payload.reference ? ` (${String(payload.reference)})` : '')
  );
}

/** Formats money for a payload field that takes a display string rather than a structure. */
export function displayAmount(amount: Money): string {
  return formatMoney(amount);
}
