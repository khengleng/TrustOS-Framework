import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import type { AuditService } from '@trustos/audit';
import type { LoggerPort } from '@trustos/logging';
import {
  addMoney,
  formatMoney,
  isZeroMoney,
  moneyFromJson,
  moneySchema,
  moneyToJson,
  subtractMoney,
  zeroMoney,
  type CurrencyRegistry,
  type Money,
} from '@trustos/financial-core';
import type { AccountService } from '@trustos/accounts';
import { credit, debit, type Journal, type Ledger } from '@trustos/ledger';

/**
 * Settlement.
 *
 * Moving money between the platform and a counterparty in batches, on a schedule, and knowing
 * afterwards exactly which transactions were in which batch.
 *
 * **Asynchronous by construction.** A batch is created, instructed, sent, and confirmed — four
 * states, at least two of which involve waiting for somebody else. The most common design mistake
 * here is a synchronous `settle()` that assumes the counterparty answers, and it produces a system
 * that cannot represent the ordinary case where a batch is sent on Friday and confirmed on Monday.
 *
 * **The settlement account is the whole mechanism.** When a batch is sent, the merchant's balance
 * is debited and a *settlement* account is credited — a liability: instructed, not yet paid. It is
 * debited again only when the counterparty confirms, and the bank is credited then, because that
 * is when the cash actually leaves. So at any moment the settlement account holds exactly what has
 * been instructed and not paid, and that number is checkable against a bank statement. A system
 * that debits the merchant and credits the bank directly has no way to represent Friday-to-Monday
 * and no number to reconcile.
 */

export const SETTLEMENT_STATUSES = [
  /** Open: instructions can still be added. */
  'open',
  /** Closed to new instructions, not yet sent. */
  'pending',
  /** Sent to the counterparty. Money is in the settlement account. */
  'sent',
  /** The counterparty confirmed. Money has left the settlement account. */
  'settled',
  /** The counterparty rejected it, wholly. */
  'failed',
  'cancelled',
] as const;

export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const INSTRUCTION_STATUSES = ['pending', 'sent', 'settled', 'failed', 'returned'] as const;
export type InstructionStatus = (typeof INSTRUCTION_STATUSES)[number];

export const ADJUSTMENT_KINDS = [
  /** The counterparty deducted a fee the batch did not account for. */
  'counterparty_fee',
  /** The amount received differs from the amount instructed, for any other reason. */
  'amount_difference',
  /** An exchange difference between instruction and settlement. */
  'fx_difference',
  /** A chargeback or return arriving after the batch settled. */
  'chargeback',
  /** Anything else, described in the reason. */
  'other',
] as const;

export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/**
 * A correction against a batch that has already settled.
 *
 * The case this exists for: the batch confirmed on Monday, and on Thursday the bank's statement
 * shows 4.50 less than the batch said, because they deducted a fee nobody modelled. The batch is
 * settled and immutable; the difference is real; and the only honest way to record it is a new
 * posting that says what it corrects.
 *
 * **Never by editing the batch.** A settled batch is what the counterparty was told and what the
 * reconciliation was run against. Editing it to match the statement makes the two agree by
 * destroying the evidence of the disagreement, and the fee the counterparty deducted becomes
 * invisible.
 */
export const settlementAdjustmentSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),
    batchId: z.string().min(1).max(120),
    /** The instruction this adjusts, when it is attributable to one. */
    instructionId: z.string().max(120).nullable().default(null),

    kind: z.enum(ADJUSTMENT_KINDS),

    /**
     * Signed, and this is the one place in the phase where an amount is.
     *
     * Positive means the counterparty paid *more* than the batch said; negative means less. A
     * direction field would need every reader to know whose point of view it is from, and an
     * adjustment is read by whoever is holding a bank statement.
     */
    amount: moneySchema,

    /** Required. A difference with no explanation is a difference nobody can close. */
    reason: z.string().min(1).max(1000),

    /** The account the difference is booked to: a fee expense, an FX loss, a suspense account. */
    counterAccountId: z.string().min(1).max(120),

    /** The correcting journal. */
    journalId: z.string().max(120).nullable().default(null),

    /** The counterparty's reference for the difference, when they gave one. */
    externalReference: z.string().max(200).nullable().default(null),

    createdAt: z.coerce.date(),
    createdById: z.string().nullable().default(null),
  })
  .strict();

export type SettlementAdjustment = z.infer<typeof settlementAdjustmentSchema>;

export const settlementInstructionSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),
    batchId: z.string().min(1).max(120),

    /** Who is being paid. */
    counterpartyId: z.string().min(1).max(120),
    counterpartyName: z.string().max(200).default(''),

    /** The account the money comes from — a merchant balance, usually. */
    sourceAccountId: z.string().min(1).max(120),

    amount: moneySchema,

    status: z.enum(INSTRUCTION_STATUSES).default('pending'),

    /** The transactions this instruction settles. What makes a batch explicable afterwards. */
    transactionIds: z.array(z.string().max(120)).max(10_000).default([]),

    /** The counterparty's own reference, once they give one. */
    externalReference: z.string().max(200).nullable().default(null),

    /** Why it failed or was returned. */
    failureReason: z.string().max(500).nullable().default(null),

    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),

    createdAt: z.coerce.date(),
    settledAt: z.coerce.date().nullable().default(null),
  })
  .strict();

export type SettlementInstruction = z.infer<typeof settlementInstructionSchema>;

export const settlementBatchSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),

    /** Readable: `SETTLE-2026-03-01-USD`. Quoted to a counterparty. */
    reference: z.string().min(1).max(120),

    currency: z.string().min(3).max(8),
    status: z.enum(SETTLEMENT_STATUSES).default('open'),

    /**
     * The window this batch covers.
     *
     * Both ends, and they are what makes a batch reproducible: "everything completed between these
     * two instants". A batch defined only by when it ran cannot be rebuilt after the fact.
     */
    windowStart: z.coerce.date(),
    windowEnd: z.coerce.date(),

    /** The settlement account money passes through. See the header. */
    settlementAccountId: z.string().min(1).max(120),

    /** Totals, denormalised for a report. Recomputed from instructions on every change. */
    instructionCount: z.number().int().min(0).default(0),
    totalAmount: moneySchema,

    /** Journals this batch posted: one on send, one on confirmation. */
    journalIds: z.array(z.string().max(120)).max(100).default([]),

    /** The counterparty's file or batch id. */
    externalReference: z.string().max(200).nullable().default(null),

    failureReason: z.string().max(500).nullable().default(null),

    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),

    createdAt: z.coerce.date(),
    createdById: z.string().nullable().default(null),
    updatedAt: z.coerce.date(),
    sentAt: z.coerce.date().nullable().default(null),
    settledAt: z.coerce.date().nullable().default(null),
  })
  .strict()
  .superRefine((batch, ctx) => {
    if (batch.windowEnd <= batch.windowStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['windowEnd'],
        message: 'A settlement window must end after it starts, or it covers nothing.',
      });
    }
  });

export type SettlementBatch = z.infer<typeof settlementBatchSchema>;

/** Allowed transitions. A state with an empty list is terminal. */
const TRANSITIONS: Record<SettlementStatus, readonly SettlementStatus[]> = {
  open: ['pending', 'cancelled'],
  pending: ['sent', 'cancelled'],
  sent: ['settled', 'failed'],
  settled: [],
  failed: [],
  cancelled: [],
};

export interface SettlementStore {
  createBatch(batch: SettlementBatch): Promise<SettlementBatch>;
  findBatch(id: string, organizationId: string | null): Promise<SettlementBatch | null>;
  updateBatch(id: string, patch: Partial<SettlementBatch>): Promise<SettlementBatch | null>;
  listBatches(input: {
    organizationId: string | null;
    status?: SettlementStatus;
    currency?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<SettlementBatch[]>;

  addAdjustment(adjustment: SettlementAdjustment): Promise<SettlementAdjustment>;
  adjustments(batchId: string, organizationId: string | null): Promise<SettlementAdjustment[]>;

  addInstruction(instruction: SettlementInstruction): Promise<SettlementInstruction>;
  findInstruction(id: string, organizationId: string | null): Promise<SettlementInstruction | null>;
  updateInstruction(
    id: string,
    patch: Partial<SettlementInstruction>,
  ): Promise<SettlementInstruction | null>;
  instructions(batchId: string, organizationId: string | null): Promise<SettlementInstruction[]>;
}

export interface SettlementServiceOptions {
  store: SettlementStore;
  ledger: Ledger;
  accounts: AccountService;
  currencies?: CurrencyRegistry;
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class SettlementService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: SettlementServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID().replace(/-/g, '')}`);
  }

  async openBatch(input: {
    organizationId: string | null;
    currency: string;
    windowStart: Date;
    windowEnd: Date;
    settlementAccountId: string;
    reference?: string;
    metadata?: SettlementBatch['metadata'];
    actorId?: string | null;
  }): Promise<SettlementBatch> {
    const now = this.now();

    const parsed = settlementBatchSchema.safeParse({
      id: this.newId('stb'),
      organizationId: input.organizationId,
      reference:
        input.reference ?? `SETTLE-${input.windowEnd.toISOString().slice(0, 10)}-${input.currency}`,
      currency: input.currency,
      status: 'open',
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      settlementAccountId: input.settlementAccountId,
      totalAmount: moneyToJson(zeroMoney(input.currency, this.options.currencies)),
      metadata: input.metadata ?? {},
      createdAt: now,
      createdById: input.actorId ?? null,
      updatedAt: now,
    });

    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'batch',
          message: issue.message,
        })),
        'This settlement batch is not valid.',
      );
    }

    return this.options.store.createBatch(parsed.data);
  }

  /**
   * Adds an instruction to an open batch.
   *
   * Only to an **open** batch. Adding to one that has been sent means the counterparty received a
   * file that no longer matches what the platform thinks it sent, and the difference is discovered
   * during reconciliation weeks later.
   */
  async addInstruction(input: {
    batchId: string;
    organizationId: string | null;
    counterpartyId: string;
    counterpartyName?: string;
    sourceAccountId: string;
    amount: Money;
    transactionIds?: string[];
    metadata?: SettlementInstruction['metadata'];
  }): Promise<{ batch: SettlementBatch; instruction: SettlementInstruction }> {
    const batch = await this.requireBatch(input.batchId, input.organizationId);

    if (batch.status !== 'open') {
      throw ApiError.conflict(
        `Batch ${batch.reference} is ${batch.status}, so no more instructions can be added. The ` +
          'counterparty would receive a file that no longer matches what we think we sent.',
        { reason: 'batch_not_open', batchId: batch.id, status: batch.status },
      );
    }

    if (input.amount.currency !== batch.currency) {
      throw ApiError.validation(
        [
          {
            path: 'amount',
            message:
              `Batch ${batch.reference} settles ${batch.currency} and this instruction is ` +
              `${input.amount.currency}. One batch, one currency — a mixed batch has a total that ` +
              'means nothing.',
          },
        ],
        'Currency mismatch with the batch.',
      );
    }

    const instruction = settlementInstructionSchema.parse({
      id: this.newId('sti'),
      organizationId: input.organizationId,
      batchId: batch.id,
      counterpartyId: input.counterpartyId,
      counterpartyName: input.counterpartyName ?? '',
      sourceAccountId: input.sourceAccountId,
      amount: moneyToJson(input.amount),
      status: 'pending',
      transactionIds: input.transactionIds ?? [],
      metadata: input.metadata ?? {},
      createdAt: this.now(),
    });

    const created = await this.options.store.addInstruction(instruction);
    const updated = await this.recomputeTotals(batch);

    return { batch: updated, instruction: created };
  }

  /** Closes a batch to new instructions. */
  async closeBatch(input: {
    id: string;
    organizationId: string | null;
    actorId?: string | null;
  }): Promise<SettlementBatch> {
    const batch = await this.requireBatch(input.id, input.organizationId);
    this.assertTransition(batch, 'pending');

    const instructions = await this.options.store.instructions(batch.id, input.organizationId);

    if (instructions.length === 0) {
      /*
       * An empty batch.
       *
       * Refused rather than sent. An empty file to a counterparty is at best noise and at worst a
       * signal that something upstream failed to produce instructions — and a batch that settles
       * nothing still appears on the settlement report as if it did something.
       */
      throw ApiError.conflict(
        `Batch ${batch.reference} has no instructions. An empty batch settles nothing and hides ` +
          'whatever failed upstream to produce instructions.',
        { reason: 'batch_empty', batchId: batch.id },
      );
    }

    return this.transition(
      batch,
      'pending',
      {},
      input.actorId ?? null,
      'Closed to new instructions.',
    );
  }

  /**
   * Sends a batch: money moves into the settlement account.
   *
   * One journal, debiting every source account and crediting the settlement account. From here the
   * money is *in transit* — it has left the merchant and not arrived at the bank, and the
   * settlement account balance is exactly that amount.
   */
  async sendBatch(input: {
    id: string;
    organizationId: string | null;
    externalReference?: string | null;
    actorId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ batch: SettlementBatch; journal: Journal }> {
    const batch = await this.requireBatch(input.id, input.organizationId);
    this.assertTransition(batch, 'sent');

    const instructions = await this.options.store.instructions(batch.id, input.organizationId);
    const total = this.totalOf(instructions, batch.currency);

    const journal = await this.options.ledger.post({
      organizationId: input.organizationId,
      description: `Settlement batch ${batch.reference} sent`,
      reference: batch.reference,
      entries: [
        ...instructions.map((instruction) =>
          debit(
            instruction.sourceAccountId,
            moneyFromJson(instruction.amount, this.options.currencies),
            {
              description: `Settlement to ${instruction.counterpartyName || instruction.counterpartyId}`,
              dimension: instruction.counterpartyId,
            },
          ),
        ),
        credit(batch.settlementAccountId, total, {
          description: `Batch ${batch.reference} in transit`,
        }),
      ],
      actorId: input.actorId,
      metadata: { batchId: batch.id },
      idempotencyKey: input.idempotencyKey ?? `settlement-send:${batch.id}`,
    });

    for (const instruction of instructions) {
      await this.options.store.updateInstruction(instruction.id, { status: 'sent' });
    }

    const updated = await this.transition(
      batch,
      'sent',
      {
        sentAt: this.now(),
        externalReference: input.externalReference ?? null,
        journalIds: [...batch.journalIds, journal.id],
      },
      input.actorId ?? null,
      `Sent ${formatMoney(total)} across ${instructions.length} instruction(s).`,
    );

    return { batch: updated, journal };
  }

  /**
   * Confirms a batch: the counterparty received it.
   *
   * The money leaves the settlement account. Partial confirmation is supported — a counterparty
   * returning three instructions out of two hundred is ordinary, and a system that can only accept
   * a batch wholly has to reverse and re-send the whole thing.
   */
  async confirmBatch(input: {
    id: string;
    organizationId: string | null;
    /** The destination — a bank account. */
    destinationAccountId: string;
    /** Instructions the counterparty rejected, with their reasons. */
    returned?: Array<{ instructionId: string; reason: string }>;
    externalReference?: string | null;
    actorId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ batch: SettlementBatch; journal: Journal; returnedAmount: Money }> {
    const batch = await this.requireBatch(input.id, input.organizationId);
    this.assertTransition(batch, 'settled');

    const instructions = await this.options.store.instructions(batch.id, input.organizationId);
    const returnedIds = new Set((input.returned ?? []).map((entry) => entry.instructionId));

    const settled = instructions.filter((instruction) => !returnedIds.has(instruction.id));
    const returned = instructions.filter((instruction) => returnedIds.has(instruction.id));

    const settledTotal = this.totalOf(settled, batch.currency);
    const returnedTotal = this.totalOf(returned, batch.currency);

    const entries = [
      debit(batch.settlementAccountId, this.totalOf(instructions, batch.currency), {
        description: `Batch ${batch.reference} confirmed`,
      }),
      ...(isZeroMoney(settledTotal)
        ? []
        : [
            credit(input.destinationAccountId, settledTotal, {
              description: `Batch ${batch.reference} settled`,
            }),
          ]),
      // Returned money goes back where it came from, per instruction, so each merchant's balance
      // is restored rather than a lump sum landing somewhere for somebody to allocate.
      ...returned.map((instruction) =>
        credit(
          instruction.sourceAccountId,
          moneyFromJson(instruction.amount, this.options.currencies),
          {
            description: `Returned from settlement: ${
              input.returned?.find((entry) => entry.instructionId === instruction.id)?.reason ??
              'unknown'
            }`,
            dimension: instruction.counterpartyId,
          },
        ),
      ),
    ];

    const journal = await this.options.ledger.post({
      organizationId: input.organizationId,
      description: `Settlement batch ${batch.reference} confirmed`,
      reference: batch.reference,
      entries,
      actorId: input.actorId,
      metadata: { batchId: batch.id },
      idempotencyKey: input.idempotencyKey ?? `settlement-confirm:${batch.id}`,
    });

    for (const instruction of settled) {
      await this.options.store.updateInstruction(instruction.id, {
        status: 'settled',
        settledAt: this.now(),
      });
    }

    for (const entry of input.returned ?? []) {
      await this.options.store.updateInstruction(entry.instructionId, {
        status: 'returned',
        failureReason: entry.reason,
      });
    }

    const updated = await this.transition(
      batch,
      'settled',
      {
        settledAt: this.now(),
        externalReference: input.externalReference ?? batch.externalReference,
        journalIds: [...batch.journalIds, journal.id],
      },
      input.actorId ?? null,
      `Settled ${formatMoney(settledTotal)}` +
        (returned.length > 0
          ? `, returned ${formatMoney(returnedTotal)} across ${returned.length}.`
          : '.'),
    );

    return { batch: updated, journal, returnedAmount: returnedTotal };
  }

  /**
   * Fails a sent batch: the counterparty rejected the whole thing.
   *
   * Reverses the send, so the money goes back to the merchants it came from and the settlement
   * account returns to zero for this batch.
   */
  async failBatch(input: {
    id: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
  }): Promise<{ batch: SettlementBatch; journals: Journal[] }> {
    const batch = await this.requireBatch(input.id, input.organizationId);
    this.assertTransition(batch, 'failed');

    const journals: Journal[] = [];

    for (const journalId of batch.journalIds) {
      const { reversal } = await this.options.ledger.reverse({
        journalId,
        organizationId: input.organizationId,
        reason: `Settlement batch ${batch.reference} failed: ${input.reason}`,
        actorId: input.actorId,
      });

      journals.push(reversal);
    }

    const instructions = await this.options.store.instructions(batch.id, input.organizationId);

    for (const instruction of instructions) {
      await this.options.store.updateInstruction(instruction.id, {
        status: 'failed',
        failureReason: input.reason,
      });
    }

    const updated = await this.transition(
      batch,
      'failed',
      {
        failureReason: input.reason,
        journalIds: [...batch.journalIds, ...journals.map((journal) => journal.id)],
      },
      input.actorId ?? null,
      input.reason,
    );

    return { batch: updated, journals };
  }

  async cancelBatch(input: {
    id: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
  }): Promise<SettlementBatch> {
    const batch = await this.requireBatch(input.id, input.organizationId);
    this.assertTransition(batch, 'cancelled');

    return this.transition(
      batch,
      'cancelled',
      { failureReason: input.reason },
      input.actorId ?? null,
      input.reason,
    );
  }

  /**
   * Records a correction against a settled batch.
   *
   * Posts a journal moving the difference between the settlement account and whichever account the
   * difference belongs to — a fee expense, an FX loss, a suspense account while somebody works out
   * what it was.
   *
   * The batch itself is untouched. It is what the counterparty was told and what the
   * reconciliation ran against, and editing it to match a later statement makes the two agree by
   * destroying the evidence of the disagreement.
   */
  async adjustBatch(input: {
    id: string;
    organizationId: string | null;
    kind: AdjustmentKind;
    /** Signed: positive means the counterparty paid more than the batch said. */
    amount: Money;
    reason: string;
    counterAccountId: string;
    instructionId?: string | null;
    externalReference?: string | null;
    actorId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ adjustment: SettlementAdjustment; journal: Journal }> {
    const batch = await this.requireBatch(input.id, input.organizationId);

    if (batch.status !== 'settled' && batch.status !== 'sent') {
      /*
       * Adjusting a batch that has not been sent.
       *
       * There is nothing to correct: no money has moved and the instruction can simply be changed
       * while the batch is open. An adjustment here would post a journal against a settlement that
       * never happened.
       */
      throw ApiError.conflict(
        `Batch ${batch.reference} is ${batch.status}, so there is nothing to adjust — no money has ` +
          'moved. Change the instruction while the batch is open.',
        { reason: 'batch_not_settled', batchId: batch.id, status: batch.status },
      );
    }

    if (input.amount.currency !== batch.currency) {
      throw ApiError.validation(
        [
          {
            path: 'amount',
            message:
              `Batch ${batch.reference} settles ${batch.currency} and this adjustment is ` +
              `${input.amount.currency}.`,
          },
        ],
        'Currency mismatch with the batch.',
      );
    }

    if (isZeroMoney(input.amount)) {
      throw ApiError.validation(
        [{ path: 'amount', message: 'An adjustment of zero corrects nothing.' }],
        'Nothing to adjust.',
      );
    }

    if (!input.reason.trim()) {
      throw ApiError.validation(
        [
          {
            path: 'reason',
            message:
              'An adjustment needs a reason. A difference with no explanation is a difference ' +
              'nobody can close, and it appears again on next month’s reconciliation.',
          },
        ],
        'An adjustment needs a reason.',
      );
    }

    const magnitude: Money = {
      currency: input.amount.currency,
      amount: {
        units:
          input.amount.amount.units < 0n ? -input.amount.amount.units : input.amount.amount.units,
        scale: input.amount.amount.scale,
      },
    };

    const shortfall = input.amount.amount.units < 0n;

    // Less received than instructed: the settlement account is short, so the difference is an
    // expense. More received: the settlement account is over, and the difference is a credit.
    const entries = shortfall
      ? [
          debit(input.counterAccountId, magnitude, { description: input.reason }),
          credit(batch.settlementAccountId, magnitude, {
            description: `Adjustment to ${batch.reference}`,
          }),
        ]
      : [
          debit(batch.settlementAccountId, magnitude, {
            description: `Adjustment to ${batch.reference}`,
          }),
          credit(input.counterAccountId, magnitude, { description: input.reason }),
        ];

    const journal = await this.options.ledger.post({
      organizationId: input.organizationId,
      description: `Settlement adjustment to ${batch.reference}: ${input.reason}`,
      reference: batch.reference,
      entries,
      actorId: input.actorId,
      metadata: { batchId: batch.id, adjustmentKind: input.kind },
      idempotencyKey: input.idempotencyKey ?? null,
    });

    const adjustment = settlementAdjustmentSchema.parse({
      id: this.newId('sta'),
      organizationId: input.organizationId,
      batchId: batch.id,
      instructionId: input.instructionId ?? null,
      kind: input.kind,
      amount: moneyToJson(input.amount),
      reason: input.reason,
      counterAccountId: input.counterAccountId,
      journalId: journal.id,
      externalReference: input.externalReference ?? null,
      createdAt: this.now(),
      createdById: input.actorId ?? null,
    });

    const created = await this.options.store.addAdjustment(adjustment);

    await this.options.store.updateBatch(batch.id, {
      journalIds: [...batch.journalIds, journal.id],
      updatedAt: this.now(),
    });

    await this.options.audit?.record({
      action: 'settlement.batch.adjusted',
      entityType: 'SettlementBatch',
      entityId: batch.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      after: {
        reference: batch.reference,
        adjustmentId: created.id,
        kind: input.kind,
        amount: formatMoney(input.amount),
        reason: input.reason,
        journalId: journal.id,
      },
    });

    return { adjustment: created, journal };
  }

  /** Every correction posted against a batch, and what each was for. */
  async adjustments(
    batchId: string,
    organizationId: string | null,
  ): Promise<SettlementAdjustment[]> {
    return this.options.store.adjustments(batchId, organizationId);
  }

  /**
   * What is in transit right now.
   *
   * The number to check against a bank statement: instructed to a counterparty and not yet paid.
   * A settlement account that is not zero after every batch has confirmed is a batch nobody
   * confirmed.
   */
  async inTransit(input: {
    organizationId: string | null;
    settlementAccountId: string;
    asOf?: Date;
  }): Promise<{ amount: Money; batches: SettlementBatch[] }> {
    const account = await this.options.accounts.get(
      input.settlementAccountId,
      input.organizationId,
    );
    const amount = await this.options.accounts.balance(account, input.asOf);

    const batches = await this.options.store.listBatches({
      organizationId: input.organizationId,
      status: 'sent',
    });

    return { amount, batches };
  }

  async getBatch(id: string, organizationId: string | null): Promise<SettlementBatch> {
    return this.requireBatch(id, organizationId);
  }

  async instructions(
    batchId: string,
    organizationId: string | null,
  ): Promise<SettlementInstruction[]> {
    return this.options.store.instructions(batchId, organizationId);
  }

  async listBatches(
    input: Parameters<SettlementStore['listBatches']>[0],
  ): Promise<SettlementBatch[]> {
    return this.options.store.listBatches(input);
  }

  /** The settlement report: what was in a batch and what became of each instruction. */
  async report(input: { id: string; organizationId: string | null }): Promise<SettlementReport> {
    const batch = await this.requireBatch(input.id, input.organizationId);
    const instructions = await this.options.store.instructions(batch.id, input.organizationId);
    const adjustments = await this.options.store.adjustments(batch.id, input.organizationId);

    const byStatus = (status: InstructionStatus) =>
      instructions.filter((instruction) => instruction.status === status);

    const adjusted = adjustments.reduce<Money>(
      (sum, adjustment) => addMoney(sum, moneyFromJson(adjustment.amount, this.options.currencies)),
      zeroMoney(batch.currency, this.options.currencies),
    );

    const settled = this.totalOf(byStatus('settled'), batch.currency);

    return {
      batch,
      instructionCount: instructions.length,
      total: this.totalOf(instructions, batch.currency),
      settled,
      returned: this.totalOf(byStatus('returned'), batch.currency),
      failed: this.totalOf(byStatus('failed'), batch.currency),
      pending: this.totalOf([...byStatus('pending'), ...byStatus('sent')], batch.currency),
      adjusted,
      // What the counterparty actually paid: settled instructions plus every correction. This is
      // the number a bank statement is compared against, and it is not the batch total.
      netSettled: addMoney(settled, adjusted),
      adjustments,
      counterparties: [...new Set(instructions.map((instruction) => instruction.counterpartyId))]
        .length,
      instructions,
    };
  }

  private totalOf(instructions: SettlementInstruction[], currency: string): Money {
    return instructions.reduce<Money>(
      (sum, instruction) =>
        addMoney(sum, moneyFromJson(instruction.amount, this.options.currencies)),
      zeroMoney(currency, this.options.currencies),
    );
  }

  private async recomputeTotals(batch: SettlementBatch): Promise<SettlementBatch> {
    const instructions = await this.options.store.instructions(batch.id, batch.organizationId);

    const updated = await this.options.store.updateBatch(batch.id, {
      instructionCount: instructions.length,
      totalAmount: moneyToJson(this.totalOf(instructions, batch.currency)),
      updatedAt: this.now(),
    });

    return updated ?? batch;
  }

  private assertTransition(batch: SettlementBatch, to: SettlementStatus): void {
    if (TRANSITIONS[batch.status].includes(to)) return;

    const allowed = TRANSITIONS[batch.status];

    throw ApiError.conflict(
      `Batch ${batch.reference} is ${batch.status} and cannot become ${to}. ` +
        (allowed.length === 0
          ? `${batch.status} is a final state; a correction is a new batch.`
          : `From ${batch.status} it can only become: ${allowed.join(', ')}.`),
      { reason: 'invalid_transition', batchId: batch.id, from: batch.status, to },
    );
  }

  private async transition(
    batch: SettlementBatch,
    status: SettlementStatus,
    patch: Partial<SettlementBatch>,
    actorId: string | null,
    reason: string,
  ): Promise<SettlementBatch> {
    const updated = await this.options.store.updateBatch(batch.id, {
      ...patch,
      status,
      updatedAt: this.now(),
    });

    if (!updated) throw ApiError.notFound(`No settlement batch with id "${batch.id}".`);

    await this.options.audit?.record({
      action: `settlement.batch.${status}`,
      entityType: 'SettlementBatch',
      entityId: batch.id,
      actorId,
      organizationId: batch.organizationId,
      before: { status: batch.status },
      after: {
        status,
        reference: batch.reference,
        reason,
        total: `${updated.totalAmount.amount} ${updated.totalAmount.currency}`,
      },
    });

    return updated;
  }

  private async requireBatch(id: string, organizationId: string | null): Promise<SettlementBatch> {
    const batch = await this.options.store.findBatch(id, organizationId);
    if (!batch) throw ApiError.notFound(`No settlement batch with id "${id}".`);
    return batch;
  }
}

export interface SettlementReport {
  batch: SettlementBatch;
  instructionCount: number;
  total: Money;
  settled: Money;
  returned: Money;
  failed: Money;
  pending: Money;
  /** The sum of every correction posted after settlement. Signed. */
  adjusted: Money;
  /** `settled + adjusted`. What the counterparty actually paid. */
  netSettled: Money;
  counterparties: number;
  instructions: SettlementInstruction[];
  adjustments: SettlementAdjustment[];
}

/**
 * The difference between what a batch says and what a counterparty reported.
 *
 * Compares against `netSettled`, not `settled` — a batch that has already been adjusted for the
 * counterparty's fee should reconcile clean, and comparing the unadjusted total would report the
 * same difference every month until somebody noticed the adjustment existed.
 */
export function settlementDifference(report: SettlementReport, counterpartyTotal: Money): Money {
  return subtractMoney(report.netSettled, counterpartyTotal);
}
