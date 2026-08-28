import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import type { AuditService } from '@trustos/audit';
import type { LoggerPort } from '@trustos/logging';
import {
  formatMoney,
  moneyFromJson,
  moneySchema,
  moneyToJson,
  newReference,
  type CurrencyRegistry,
  type Money,
} from '@trustos/financial-core';
import type { TransactionService } from '@trustos/transactions';

/**
 * Payment requests.
 *
 * "Somebody owes this, here is how to pay it." An invoice, a checkout, a QR code, a payment link —
 * the object a payer is pointed at, before any money moves.
 *
 * **No provider integrations.** There is a `providerReference` field and a callback hook, and
 * nothing that speaks to a payment network. That is the framework's usual rule, and here it also
 * keeps the object honest: a payment request is a *claim on a payer*, and it means the same thing
 * whether it is settled by card, by bank transfer or by cash at a counter.
 *
 * Two rules the package enforces:
 *
 *   1. **Every request expires.** Not nullable. A payment request with no expiry is a claim that
 *      can be paid a year later at a price nobody honours, and it sits in every report of
 *      outstanding receivables forever.
 *   2. **Paying is idempotent by construction.** The request's own id is the idempotency key for
 *      the transaction it creates, so a payer who submits twice pays once — which is exactly what
 *      a payer with a slow connection does.
 */

export const PAYMENT_REQUEST_STATUSES = [
  /** Created, not yet paid. */
  'pending',
  /** A payment is in flight. */
  'processing',
  'paid',
  /** Partially paid. Only when `allowPartial` is set. */
  'partially_paid',
  'failed',
  'cancelled',
  'expired',
  'refunded',
] as const;

export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

export const paymentRequestSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),

    /** The public reference: what appears on an invoice and is quoted over the phone. */
    reference: z.string().min(4).max(64),

    amount: moneySchema,
    /** How much has been paid so far. */
    paidAmount: moneySchema.nullable().default(null),

    status: z.enum(PAYMENT_REQUEST_STATUSES).default('pending'),

    /** Who is owed. A merchant account or a wallet. */
    payeeAccountId: z.string().max(120).nullable().default(null),
    payeeWalletId: z.string().max(120).nullable().default(null),

    /** Who owes, when it is known in advance. Null for an open link anyone can pay. */
    payerId: z.string().max(120).nullable().default(null),

    /** The invoice or order this settles. */
    invoiceReference: z.string().max(120).nullable().default(null),
    description: z.string().max(1000).default(''),

    /**
     * When the request stops being payable. Required — see the header.
     */
    expiresAt: z.coerce.date(),

    /** Whether part-payment is accepted. Off by default: most invoices are paid in full. */
    allowPartial: z.boolean().default(false),

    /**
     * Where to notify when the status changes.
     *
     * A URL the application calls; the framework does not call it. Delivery, retry and signing
     * are `@trustos/webhooks`, which already does all three properly.
     */
    callbackUrl: z.string().max(2000).nullable().default(null),

    /** The provider's own id for this, when one is involved. Recorded, never interpreted. */
    providerReference: z.string().max(200).nullable().default(null),
    provider: z.string().max(60).nullable().default(null),

    /** Transactions raised against this request. Usually one; several if partial. */
    transactionIds: z.array(z.string().max(120)).max(100).default([]),

    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),

    createdAt: z.coerce.date(),
    createdById: z.string().nullable().default(null),
    updatedAt: z.coerce.date(),
    paidAt: z.coerce.date().nullable().default(null),
    cancelledAt: z.coerce.date().nullable().default(null),
    cancelledReason: z.string().max(500).nullable().default(null),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.payeeAccountId === null && request.payeeWalletId === null) {
      /*
       * A payment request with no payee.
       *
       * The money would arrive with nowhere to go, and the transaction it raises cannot post. A
       * request like this is payable right up until the moment somebody pays it.
       */
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payeeAccountId'],
        message:
          'A payment request needs a payee. Without one the money arrives with nowhere to go, and ' +
          'the request stays payable right up until somebody pays it.',
      });
    }
  });

export type PaymentRequest = z.infer<typeof paymentRequestSchema>;

/** Terminal statuses. Paying one of these is refused. */
const TERMINAL: ReadonlySet<PaymentRequestStatus> = new Set([
  'paid',
  'cancelled',
  'expired',
  'refunded',
]);

export interface PaymentRequestStore {
  create(request: PaymentRequest): Promise<PaymentRequest>;
  find(id: string, organizationId: string | null): Promise<PaymentRequest | null>;
  findByReference(reference: string, organizationId: string | null): Promise<PaymentRequest | null>;
  update(id: string, patch: Partial<PaymentRequest>): Promise<PaymentRequest | null>;
  list(input: {
    organizationId: string | null;
    status?: PaymentRequestStatus;
    payerId?: string;
    invoiceReference?: string;
    limit?: number;
  }): Promise<PaymentRequest[]>;
  /** Pending requests past their expiry, for the sweeper. */
  expired(organizationId: string | null, at: Date, limit?: number): Promise<PaymentRequest[]>;
}

export interface PaymentServiceOptions {
  store: PaymentRequestStore;
  transactions: TransactionService;
  currencies?: CurrencyRegistry;
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  /** Default lifetime. 24 hours: long enough to pay, short enough not to linger. */
  defaultTtlMs?: number;
  /** Called when a request's status changes, for the application to deliver a webhook. */
  onStatusChange?: (request: PaymentRequest, previous: PaymentRequestStatus) => Promise<void>;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class PaymentService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly defaultTtlMs: number;

  constructor(private readonly options: PaymentServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID().replace(/-/g, '')}`);
    this.defaultTtlMs = options.defaultTtlMs ?? 86_400_000;
  }

  async create(input: {
    organizationId: string | null;
    amount: Money;
    payeeAccountId?: string | null;
    payeeWalletId?: string | null;
    payerId?: string | null;
    invoiceReference?: string | null;
    description?: string;
    reference?: string;
    expiresAt?: Date;
    allowPartial?: boolean;
    callbackUrl?: string | null;
    provider?: string | null;
    providerReference?: string | null;
    metadata?: PaymentRequest['metadata'];
    actorId?: string | null;
  }): Promise<PaymentRequest> {
    const now = this.now();

    const parsed = paymentRequestSchema.safeParse({
      id: this.newId('pay'),
      organizationId: input.organizationId,
      // Readable, because it goes on an invoice and gets read aloud. See `newReference`.
      reference: input.reference ?? newReference('PAY'),
      amount: moneyToJson(input.amount),
      status: 'pending',
      payeeAccountId: input.payeeAccountId ?? null,
      payeeWalletId: input.payeeWalletId ?? null,
      payerId: input.payerId ?? null,
      invoiceReference: input.invoiceReference ?? null,
      description: input.description ?? '',
      expiresAt: input.expiresAt ?? new Date(now.getTime() + this.defaultTtlMs),
      allowPartial: input.allowPartial ?? false,
      callbackUrl: input.callbackUrl ?? null,
      provider: input.provider ?? null,
      providerReference: input.providerReference ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      createdById: input.actorId ?? null,
      updatedAt: now,
    });

    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'request',
          message: issue.message,
        })),
        'This payment request is not valid.',
      );
    }

    const created = await this.options.store.create(parsed.data);

    await this.options.audit?.record({
      action: 'transactions.request.created',
      entityType: 'PaymentRequest',
      entityId: created.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      after: {
        reference: created.reference,
        amount: formatMoney(input.amount),
        payerId: created.payerId,
        invoiceReference: created.invoiceReference,
        expiresAt: created.expiresAt.toISOString(),
      },
    });

    return created;
  }

  /**
   * Pays a request from a wallet.
   *
   * The request's id is the idempotency key, so a payer who submits twice pays once. That is not a
   * nicety: a payer on a slow connection presses the button again, and the version without this
   * takes the money twice and is discovered by the customer.
   */
  async pay(input: {
    id: string;
    organizationId: string | null;
    payerWalletId: string;
    amount?: Money;
    feeScheduleKey?: string | null;
    actorId?: string | null;
  }): Promise<{ request: PaymentRequest; transactionId: string }> {
    const request = await this.require(input.id, input.organizationId);
    const now = this.now();

    this.assertPayable(request, now);

    const outstanding = this.outstandingOf(request);
    const amount = input.amount ?? outstanding;

    if (amount.amount.units > outstanding.amount.units) {
      throw ApiError.validation(
        [
          {
            path: 'amount',
            message:
              `${formatMoney(amount)} is more than the ${formatMoney(outstanding)} outstanding on ` +
              `${request.reference}. Overpaying is a separate transaction, not a payment of this ` +
              'request.',
          },
        ],
        'Payment exceeds the amount due.',
      );
    }

    if (!request.allowPartial && amount.amount.units < outstanding.amount.units) {
      throw ApiError.validation(
        [
          {
            path: 'amount',
            message:
              `${request.reference} does not accept partial payment. It is for ` +
              `${formatMoney(outstanding)}.`,
          },
        ],
        'Partial payment is not accepted.',
      );
    }

    const transaction = await this.options.transactions.create({
      organizationId: input.organizationId,
      type: 'payment',
      amount,
      sourceWalletId: input.payerWalletId,
      destinationAccountId: request.payeeAccountId,
      destinationWalletId: request.payeeWalletId,
      reference: request.reference,
      description: request.description || `Payment for ${request.reference}`,
      feeScheduleKey: input.feeScheduleKey ?? null,
      // The request id, so a resubmission is the same transaction rather than a second payment.
      idempotencyKey: `payreq:${request.id}:${formatMoney(amount)}`,
      metadata: { paymentRequestId: request.id },
      actorId: input.actorId,
    });

    const updated = await this.transition(request, 'processing', {
      transactionIds: [...new Set([...request.transactionIds, transaction.id])],
    });

    return { request: updated, transactionId: transaction.id };
  }

  /**
   * Records that a payment settled.
   *
   * Separate from `pay`, because the two happen at different times: `pay` raises the transaction,
   * and this is called when it completes. Collapsing them assumes payment is synchronous, which it
   * is for an internal wallet and is not for anything else.
   */
  async settle(input: {
    id: string;
    organizationId: string | null;
    amount: Money;
    providerReference?: string | null;
    actorId?: string | null;
  }): Promise<PaymentRequest> {
    const request = await this.require(input.id, input.organizationId);

    const alreadyPaid = request.paidAmount
      ? moneyFromJson(request.paidAmount, this.options.currencies)
      : {
          currency: input.amount.currency,
          amount: { units: 0n, scale: input.amount.amount.scale },
        };

    const paid = {
      currency: input.amount.currency,
      amount: {
        units: alreadyPaid.amount.units + input.amount.amount.units,
        scale: input.amount.amount.scale,
      },
    };

    const total = moneyFromJson(request.amount, this.options.currencies);
    const fullyPaid = paid.amount.units >= total.amount.units;

    const updated = await this.transition(request, fullyPaid ? 'paid' : 'partially_paid', {
      paidAmount: moneyToJson(paid),
      paidAt: fullyPaid ? this.now() : null,
      providerReference: input.providerReference ?? request.providerReference,
    });

    await this.options.audit?.record({
      action: 'transactions.request.settled',
      entityType: 'PaymentRequest',
      entityId: request.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      after: {
        reference: request.reference,
        amount: formatMoney(input.amount),
        totalPaid: formatMoney(paid),
        fullyPaid,
        providerReference: input.providerReference ?? null,
      },
    });

    return updated;
  }

  async cancel(input: {
    id: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
  }): Promise<PaymentRequest> {
    const request = await this.require(input.id, input.organizationId);

    if (TERMINAL.has(request.status)) {
      throw ApiError.conflict(
        `${request.reference} is already ${request.status} and cannot be cancelled.`,
        { reason: 'request_terminal', id: request.id, status: request.status },
      );
    }

    const updated = await this.transition(request, 'cancelled', {
      cancelledAt: this.now(),
      cancelledReason: input.reason,
    });

    await this.options.audit?.record({
      action: 'transactions.request.cancelled',
      entityType: 'PaymentRequest',
      entityId: request.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      before: { status: request.status },
      after: { status: 'cancelled', reason: input.reason },
    });

    return updated;
  }

  /**
   * Expires requests nobody paid.
   *
   * Run on a schedule. Without it, every unpaid request sits in the outstanding-receivables report
   * forever, and the report stops being a list of things anybody will act on.
   */
  async expireStale(input: {
    organizationId: string | null;
    limit?: number;
  }): Promise<{ expired: number; ids: string[] }> {
    const now = this.now();
    const stale = await this.options.store.expired(input.organizationId, now, input.limit ?? 100);
    const ids: string[] = [];

    for (const request of stale) {
      if (TERMINAL.has(request.status)) continue;

      await this.transition(request, 'expired', {});
      ids.push(request.id);
    }

    if (ids.length > 0) {
      this.options.logger?.info(
        { organizationId: input.organizationId, expired: ids.length },
        'expired payment requests',
      );
    }

    return { expired: ids.length, ids };
  }

  async get(id: string, organizationId: string | null): Promise<PaymentRequest> {
    return this.require(id, organizationId);
  }

  async getByReference(reference: string, organizationId: string | null): Promise<PaymentRequest> {
    const request = await this.options.store.findByReference(reference, organizationId);
    if (!request) throw ApiError.notFound(`No payment request with reference "${reference}".`);
    return request;
  }

  async list(input: Parameters<PaymentRequestStore['list']>[0]): Promise<PaymentRequest[]> {
    return this.options.store.list(input);
  }

  /** How much is still owed. */
  outstandingOf(request: PaymentRequest): Money {
    const total = moneyFromJson(request.amount, this.options.currencies);

    if (!request.paidAmount) return total;

    const paid = moneyFromJson(request.paidAmount, this.options.currencies);

    return {
      currency: total.currency,
      amount: { units: total.amount.units - paid.amount.units, scale: total.amount.scale },
    };
  }

  private assertPayable(request: PaymentRequest, at: Date): void {
    if (TERMINAL.has(request.status)) {
      throw ApiError.conflict(
        `${request.reference} is ${request.status} and cannot be paid.` +
          (request.status === 'paid' ? ' It has already been settled.' : ''),
        { reason: 'request_not_payable', id: request.id, status: request.status },
      );
    }

    if (request.expiresAt <= at) {
      /*
       * Expiry is checked on payment, not only by the sweeper.
       *
       * The sweeper runs on a schedule, so between two runs there is a window in which an expired
       * request still says `pending`. Checking here closes it.
       */
      throw ApiError.conflict(
        `${request.reference} expired at ${request.expiresAt.toISOString()}. Raise a new request ` +
          'rather than paying this one — the amount may no longer be right.',
        { reason: 'request_expired', id: request.id },
      );
    }
  }

  private async transition(
    request: PaymentRequest,
    status: PaymentRequestStatus,
    patch: Partial<PaymentRequest>,
  ): Promise<PaymentRequest> {
    const updated = await this.options.store.update(request.id, {
      ...patch,
      status,
      updatedAt: this.now(),
    });

    if (!updated) throw ApiError.notFound(`No payment request with id "${request.id}".`);

    if (status !== request.status && this.options.onStatusChange) {
      try {
        await this.options.onStatusChange(updated, request.status);
      } catch (error) {
        /*
         * A callback failure must not undo the payment.
         *
         * The money moved. Failing here would leave the caller believing it did not, and the
         * retry would be a second payment. Delivery is `@trustos/webhooks`, which retries
         * properly.
         */
        this.options.logger?.error(
          {
            requestId: updated.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'payment request status callback failed',
        );
      }
    }

    return updated;
  }

  private async require(id: string, organizationId: string | null): Promise<PaymentRequest> {
    const request = await this.options.store.find(id, organizationId);
    if (!request) throw ApiError.notFound(`No payment request with id "${id}".`);
    return request;
  }
}
