import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import type { AuditService } from '@trustos/audit';
import type { LoggerPort } from '@trustos/logging';
import {
  absolute,
  addMoney,
  compareMoney,
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
import type { Ledger } from '@trustos/ledger';

/**
 * Reconciliation.
 *
 * Comparing what the platform believes against what somebody else believes, and producing a list
 * of the differences that a person can work through.
 *
 * **The output is a queue, not a number.** A reconciliation that reports "£3.42 out" has told
 * nobody anything actionable. What is needed is: these four records are on the statement and not in
 * the ledger, these two are in the ledger and not on the statement, and these three match on
 * reference but differ on amount. Each of those is a different investigation.
 *
 * **Tolerance is per rule and stated.** A one-cent difference on a card settlement is rounding; a
 * one-cent difference on an internal transfer is a bug. A single global tolerance means either the
 * first floods the queue or the second never appears.
 *
 * **Matching is by reference first, amount second.** Amount-only matching pairs two unrelated
 * £50 payments and reports a clean reconciliation, which is worse than reporting two exceptions.
 */

export const RECONCILIATION_STATUSES = ['running', 'completed', 'failed'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const EXCEPTION_KINDS = [
  /** On the external statement, not in the ledger. */
  'missing_internal',
  /** In the ledger, not on the external statement. */
  'missing_external',
  /** Both present, amounts differ beyond tolerance. */
  'amount_mismatch',
  /** Both present, but dated far enough apart to be worth a look. */
  'date_mismatch',
  /** Two internal records claim the same external reference. */
  'duplicate_internal',
  /** Two external records claim the same reference. */
  'duplicate_external',
] as const;

export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const EXCEPTION_STATUSES = ['open', 'investigating', 'resolved', 'written_off'] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

/** One line from either side. The shape both a ledger export and a bank statement reduce to. */
export const reconciliationRecordSchema = z
  .object({
    /** The reference both sides should agree on. */
    reference: z.string().min(1).max(200),
    amount: moneySchema,
    at: z.coerce.date(),
    /** The side's own identifier, for the exception report. */
    sourceId: z.string().max(200),
    description: z.string().max(500).default(''),
    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  })
  .strict();

export type ReconciliationRecord = z.infer<typeof reconciliationRecordSchema>;

export const toleranceSchema = z
  .object({
    /** Absolute difference tolerated, as a decimal string in the run's currency. */
    amount: z.string().default('0'),
    /** How far apart two dates may be and still match, in milliseconds. */
    dateMs: z.number().int().min(0).default(0),
    /**
     * Why this tolerance exists.
     *
     * Required, and not decoration. A tolerance is a decision to stop looking at differences below
     * a size, and in a year the only question anybody asks about it is why.
     */
    reason: z.string().min(1).max(500),
  })
  .strict();

export type Tolerance = z.infer<typeof toleranceSchema>;

export const reconciliationExceptionSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),
    runId: z.string().min(1).max(120),

    kind: z.enum(EXCEPTION_KINDS),
    status: z.enum(EXCEPTION_STATUSES).default('open'),

    reference: z.string().max(200),

    /** What each side said. Null on the side that has nothing. */
    internalAmount: moneySchema.nullable().default(null),
    externalAmount: moneySchema.nullable().default(null),
    /** external − internal, when both are present. */
    difference: moneySchema.nullable().default(null),

    internalId: z.string().max(200).nullable().default(null),
    externalId: z.string().max(200).nullable().default(null),

    internalAt: z.coerce.date().nullable().default(null),
    externalAt: z.coerce.date().nullable().default(null),

    /** What to look at, in words. Written once, read by whoever picks it up. */
    detail: z.string().min(1).max(2000),

    assignedTo: z.string().max(64).nullable().default(null),
    /** How it was resolved. Required to leave `investigating`. */
    resolution: z.string().max(2000).nullable().default(null),
    /** A journal posted to correct it, when one was needed. */
    correctionJournalId: z.string().max(120).nullable().default(null),

    createdAt: z.coerce.date(),
    resolvedAt: z.coerce.date().nullable().default(null),
    resolvedById: z.string().max(64).nullable().default(null),
  })
  .strict();

export type ReconciliationException = z.infer<typeof reconciliationExceptionSchema>;

export const reconciliationRunSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),

    /** What is being reconciled: `bank.usd`, `provider-x.settlement`. */
    key: z.string().min(1).max(120),
    /** `internal` compares two of the platform's own views; `external` compares against a file. */
    kind: z.enum(['internal', 'external']),

    currency: z.string().min(3).max(8),
    windowStart: z.coerce.date(),
    windowEnd: z.coerce.date(),

    status: z.enum(RECONCILIATION_STATUSES).default('running'),

    internalCount: z.number().int().min(0).default(0),
    externalCount: z.number().int().min(0).default(0),
    matchedCount: z.number().int().min(0).default(0),
    exceptionCount: z.number().int().min(0).default(0),

    internalTotal: moneySchema,
    externalTotal: moneySchema,
    /** external − internal. Zero when the two sides agree in total. */
    difference: moneySchema,

    tolerance: toleranceSchema,

    failureReason: z.string().max(500).nullable().default(null),

    startedAt: z.coerce.date(),
    finishedAt: z.coerce.date().nullable().default(null),
    startedById: z.string().nullable().default(null),
  })
  .strict();

export type ReconciliationRun = z.infer<typeof reconciliationRunSchema>;

export interface ReconciliationStore {
  createRun(run: ReconciliationRun): Promise<ReconciliationRun>;
  findRun(id: string, organizationId: string | null): Promise<ReconciliationRun | null>;
  updateRun(id: string, patch: Partial<ReconciliationRun>): Promise<ReconciliationRun | null>;
  listRuns(input: {
    organizationId: string | null;
    key?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<ReconciliationRun[]>;

  addExceptions(exceptions: ReconciliationException[]): Promise<void>;
  findException(id: string, organizationId: string | null): Promise<ReconciliationException | null>;
  updateException(
    id: string,
    patch: Partial<ReconciliationException>,
  ): Promise<ReconciliationException | null>;
  exceptions(input: {
    organizationId: string | null;
    runId?: string;
    status?: ExceptionStatus;
    kind?: ExceptionKind;
    limit?: number;
  }): Promise<ReconciliationException[]>;
}

export interface ReconciliationServiceOptions {
  store: ReconciliationStore;
  ledger?: Ledger;
  currencies?: CurrencyRegistry;
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class ReconciliationService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: ReconciliationServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID().replace(/-/g, '')}`);
  }

  /**
   * Runs a reconciliation.
   *
   * Both sides are supplied by the caller: the platform cannot know how to read a counterparty's
   * file, and the ledger side depends on which accounts are in scope. What this owns is the
   * *comparison*, which is the part that is the same everywhere and the part that is easy to get
   * subtly wrong.
   */
  async run(input: {
    organizationId: string | null;
    key: string;
    kind: 'internal' | 'external';
    currency: string;
    windowStart: Date;
    windowEnd: Date;
    internal: unknown[];
    external: unknown[];
    tolerance?: Partial<Tolerance> & { reason: string };
    actorId?: string | null;
  }): Promise<{ run: ReconciliationRun; exceptions: ReconciliationException[] }> {
    const startedAt = this.now();

    const tolerance = toleranceSchema.parse({
      amount: input.tolerance?.amount ?? '0',
      dateMs: input.tolerance?.dateMs ?? 0,
      reason: input.tolerance?.reason ?? 'Exact matching: no difference is tolerated.',
    });

    const internal = input.internal.map((record) => reconciliationRecordSchema.parse(record));
    const external = input.external.map((record) => reconciliationRecordSchema.parse(record));

    this.assertOneCurrency([...internal, ...external], input.currency);

    const runId = this.newId('rec');
    const result = compare({
      internal,
      external,
      tolerance,
      currency: input.currency,
      currencies: this.options.currencies,
    });

    const exceptions = result.exceptions.map((exception) =>
      reconciliationExceptionSchema.parse({
        ...exception,
        id: this.newId('exc'),
        organizationId: input.organizationId,
        runId,
        createdAt: startedAt,
      }),
    );

    const run = reconciliationRunSchema.parse({
      id: runId,
      organizationId: input.organizationId,
      key: input.key,
      kind: input.kind,
      currency: input.currency,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      status: 'completed',
      internalCount: internal.length,
      externalCount: external.length,
      matchedCount: result.matched,
      exceptionCount: exceptions.length,
      internalTotal: moneyToJson(result.internalTotal),
      externalTotal: moneyToJson(result.externalTotal),
      difference: moneyToJson(result.difference),
      tolerance,
      startedAt,
      finishedAt: this.now(),
      startedById: input.actorId ?? null,
    });

    const created = await this.options.store.createRun(run);

    if (exceptions.length > 0) {
      await this.options.store.addExceptions(exceptions);
    }

    await this.options.audit?.record({
      action: 'reconciliation.run.completed',
      entityType: 'ReconciliationRun',
      entityId: created.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      after: {
        key: created.key,
        window: `${input.windowStart.toISOString()}..${input.windowEnd.toISOString()}`,
        internalCount: created.internalCount,
        externalCount: created.externalCount,
        matched: created.matchedCount,
        exceptions: created.exceptionCount,
        difference: formatMoney(result.difference),
        tolerance: tolerance.amount,
      },
    });

    if (exceptions.length > 0) {
      this.options.logger?.warn(
        {
          runId: created.id,
          key: created.key,
          exceptions: exceptions.length,
          difference: formatMoney(result.difference),
        },
        'reconciliation produced exceptions',
      );
    }

    return { run: created, exceptions };
  }

  /**
   * Assigns an exception to somebody.
   *
   * An exception queue that nobody owns is a list that grows. Assignment is the difference between
   * a queue and a graveyard.
   */
  async assign(input: {
    id: string;
    organizationId: string | null;
    assignTo: string;
    actorId?: string | null;
  }): Promise<ReconciliationException> {
    const exception = await this.requireException(input.id, input.organizationId);

    if (exception.status === 'resolved' || exception.status === 'written_off') {
      throw ApiError.conflict(`This exception is already ${exception.status}.`, {
        reason: 'exception_closed',
        id: exception.id,
      });
    }

    const updated = await this.options.store.updateException(exception.id, {
      assignedTo: input.assignTo,
      status: 'investigating',
    });

    if (!updated) throw ApiError.notFound(`No exception with id "${input.id}".`);
    return updated;
  }

  /**
   * Resolves an exception.
   *
   * Requires a resolution in words, and takes an optional correcting journal. A resolution with no
   * explanation is a closed ticket that tells the next reconciliation nothing — and the same
   * difference will appear again next month with nobody knowing it was looked at.
   */
  async resolve(input: {
    id: string;
    organizationId: string | null;
    resolution: string;
    correctionJournalId?: string | null;
    writeOff?: boolean;
    actorId?: string | null;
  }): Promise<ReconciliationException> {
    const exception = await this.requireException(input.id, input.organizationId);

    if (exception.status === 'resolved' || exception.status === 'written_off') {
      throw ApiError.conflict(`This exception is already ${exception.status}.`, {
        reason: 'exception_closed',
        id: exception.id,
      });
    }

    if (!input.resolution.trim()) {
      throw ApiError.validation(
        [
          {
            path: 'resolution',
            message:
              'A resolution needs an explanation. Without one the same difference appears next ' +
              'month with nobody knowing it was already looked at.',
          },
        ],
        'A resolution needs an explanation.',
      );
    }

    const updated = await this.options.store.updateException(exception.id, {
      status: input.writeOff ? 'written_off' : 'resolved',
      resolution: input.resolution,
      correctionJournalId: input.correctionJournalId ?? null,
      resolvedAt: this.now(),
      resolvedById: input.actorId ?? null,
    });

    if (!updated) throw ApiError.notFound(`No exception with id "${input.id}".`);

    await this.options.audit?.record({
      action: input.writeOff
        ? 'reconciliation.exception.written_off'
        : 'reconciliation.exception.resolved',
      entityType: 'ReconciliationException',
      entityId: exception.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      before: { status: exception.status },
      after: {
        status: updated.status,
        kind: exception.kind,
        reference: exception.reference,
        resolution: input.resolution,
        correctionJournalId: input.correctionJournalId ?? null,
      },
    });

    return updated;
  }

  async getRun(id: string, organizationId: string | null): Promise<ReconciliationRun> {
    const run = await this.options.store.findRun(id, organizationId);
    if (!run) throw ApiError.notFound(`No reconciliation run with id "${id}".`);
    return run;
  }

  async listRuns(
    input: Parameters<ReconciliationStore['listRuns']>[0],
  ): Promise<ReconciliationRun[]> {
    return this.options.store.listRuns(input);
  }

  async exceptions(
    input: Parameters<ReconciliationStore['exceptions']>[0],
  ): Promise<ReconciliationException[]> {
    return this.options.store.exceptions(input);
  }

  /**
   * The state of the exception queue.
   *
   * The oldest open exception is the number to watch. A queue with a six-week-old item is a queue
   * where somebody has decided, without saying so, that one difference is not worth investigating.
   */
  async queueHealth(organizationId: string | null): Promise<{
    open: number;
    investigating: number;
    oldestOpenAgeMs: number | null;
    byKind: Record<string, number>;
  }> {
    const open = await this.options.store.exceptions({
      organizationId,
      status: 'open',
      limit: 5000,
    });
    const investigating = await this.options.store.exceptions({
      organizationId,
      status: 'investigating',
      limit: 5000,
    });

    const byKind: Record<string, number> = {};
    for (const exception of [...open, ...investigating]) {
      byKind[exception.kind] = (byKind[exception.kind] ?? 0) + 1;
    }

    const oldest = open.reduce<Date | null>(
      (found, exception) => (!found || exception.createdAt < found ? exception.createdAt : found),
      null,
    );

    return {
      open: open.length,
      investigating: investigating.length,
      oldestOpenAgeMs: oldest ? this.now().getTime() - oldest.getTime() : null,
      byKind,
    };
  }

  private assertOneCurrency(records: ReconciliationRecord[], currency: string): void {
    const others = [...new Set(records.map((record) => record.amount.currency))].filter(
      (code) => code !== currency,
    );

    if (others.length > 0) {
      throw ApiError.validation(
        [
          {
            path: 'records',
            message:
              `This run reconciles ${currency} and the records include ${others.join(', ')}. A ` +
              'mixed run has a difference that means nothing.',
          },
        ],
        'Mixed currencies in a reconciliation.',
      );
    }
  }

  private async requireException(
    id: string,
    organizationId: string | null,
  ): Promise<ReconciliationException> {
    const exception = await this.options.store.findException(id, organizationId);
    if (!exception) throw ApiError.notFound(`No exception with id "${id}".`);
    return exception;
  }
}

/**
 * Compares two sides.
 *
 * Pure: two lists in, a result out. Same answer on every machine, which is what makes a
 * reconciliation reproducible — the most common question about one is "why did it match last month
 * and not this month", and a comparison that depends on anything but its inputs cannot answer it.
 *
 * **By reference first.** Amount-only matching pairs two unrelated £50 payments and reports a
 * clean reconciliation, which is worse than two exceptions.
 */
export function compare(input: {
  internal: ReconciliationRecord[];
  external: ReconciliationRecord[];
  tolerance: Tolerance;
  currency: string;
  currencies?: CurrencyRegistry;
}): {
  matched: number;
  exceptions: Array<Omit<ReconciliationException, 'id' | 'organizationId' | 'runId' | 'createdAt'>>;
  internalTotal: Money;
  externalTotal: Money;
  difference: Money;
} {
  const zero = zeroMoney(input.currency, input.currencies);
  const exceptions: Array<
    Omit<ReconciliationException, 'id' | 'organizationId' | 'runId' | 'createdAt'>
  > = [];

  const byReference = <T extends ReconciliationRecord>(records: T[]) => {
    const map = new Map<string, T[]>();

    for (const record of records) {
      const existing = map.get(record.reference) ?? [];
      existing.push(record);
      map.set(record.reference, existing);
    }

    return map;
  };

  const internalByReference = byReference(input.internal);
  const externalByReference = byReference(input.external);

  const toleranceAmount = input.tolerance.amount;
  let matched = 0;

  for (const [reference, internalRecords] of internalByReference) {
    const externalRecords = externalByReference.get(reference) ?? [];

    if (internalRecords.length > 1) {
      /*
       * Two internal records with one reference.
       *
       * Almost always a double posting. Reported before matching, because matching one of them
       * against the external record would leave the other looking like an orphan and hide the
       * duplication.
       */
      exceptions.push({
        kind: 'duplicate_internal',
        status: 'open',
        reference,
        internalAmount: moneyToJson(sumRecords(internalRecords, input.currency, input.currencies)),
        externalAmount: null,
        difference: null,
        internalId: internalRecords.map((record) => record.sourceId).join(', '),
        externalId: null,
        internalAt: internalRecords[0]!.at,
        externalAt: null,
        detail:
          `${internalRecords.length} internal records share the reference "${reference}": ` +
          `${internalRecords.map((record) => record.sourceId).join(', ')}. This is usually a ` +
          'double posting.',
        assignedTo: null,
        resolution: null,
        correctionJournalId: null,
        resolvedAt: null,
        resolvedById: null,
      });

      continue;
    }

    const internalRecord = internalRecords[0]!;

    if (externalRecords.length === 0) {
      exceptions.push({
        kind: 'missing_external',
        status: 'open',
        reference,
        internalAmount: internalRecord.amount,
        externalAmount: null,
        difference: null,
        internalId: internalRecord.sourceId,
        externalId: null,
        internalAt: internalRecord.at,
        externalAt: null,
        detail:
          `${formatMoney(moneyFromJson(internalRecord.amount, input.currencies))} was posted ` +
          `internally as "${reference}" and does not appear on the external statement.`,
        assignedTo: null,
        resolution: null,
        correctionJournalId: null,
        resolvedAt: null,
        resolvedById: null,
      });

      continue;
    }

    if (externalRecords.length > 1) {
      exceptions.push({
        kind: 'duplicate_external',
        status: 'open',
        reference,
        internalAmount: internalRecord.amount,
        externalAmount: moneyToJson(sumRecords(externalRecords, input.currency, input.currencies)),
        difference: null,
        internalId: internalRecord.sourceId,
        externalId: externalRecords.map((record) => record.sourceId).join(', '),
        internalAt: internalRecord.at,
        externalAt: externalRecords[0]!.at,
        detail:
          `${externalRecords.length} external records share the reference "${reference}". The ` +
          'counterparty may have sent the same item twice.',
        assignedTo: null,
        resolution: null,
        correctionJournalId: null,
        resolvedAt: null,
        resolvedById: null,
      });

      continue;
    }

    const externalRecord = externalRecords[0]!;

    const internalAmount = moneyFromJson(internalRecord.amount, input.currencies);
    const externalAmount = moneyFromJson(externalRecord.amount, input.currencies);
    const difference = subtractMoney(externalAmount, internalAmount);
    const limit = moneyFromJson(
      { currency: input.currency, amount: toleranceAmount },
      input.currencies,
    );

    if (compareAbsolute(difference, limit) > 0) {
      exceptions.push({
        kind: 'amount_mismatch',
        status: 'open',
        reference,
        internalAmount: internalRecord.amount,
        externalAmount: externalRecord.amount,
        difference: moneyToJson(difference),
        internalId: internalRecord.sourceId,
        externalId: externalRecord.sourceId,
        internalAt: internalRecord.at,
        externalAt: externalRecord.at,
        detail:
          `"${reference}": internal ${formatMoney(internalAmount)}, external ` +
          `${formatMoney(externalAmount)}, a difference of ${formatMoney(difference)}` +
          (isZeroMoney(limit) ? '.' : ` against a tolerance of ${formatMoney(limit)}.`),
        assignedTo: null,
        resolution: null,
        correctionJournalId: null,
        resolvedAt: null,
        resolvedById: null,
      });

      continue;
    }

    const dateGap = Math.abs(externalRecord.at.getTime() - internalRecord.at.getTime());

    if (input.tolerance.dateMs > 0 && dateGap > input.tolerance.dateMs) {
      /*
       * Matched on amount and reference, far apart in time.
       *
       * Not a failure — settlement genuinely takes days — but worth a line, because a gap that
       * grows month over month is a counterparty whose processing is slipping.
       */
      exceptions.push({
        kind: 'date_mismatch',
        status: 'open',
        reference,
        internalAmount: internalRecord.amount,
        externalAmount: externalRecord.amount,
        difference: moneyToJson(difference),
        internalId: internalRecord.sourceId,
        externalId: externalRecord.sourceId,
        internalAt: internalRecord.at,
        externalAt: externalRecord.at,
        detail:
          `"${reference}" matches on amount but the two sides are ${Math.round(dateGap / 3_600_000)} ` +
          `hours apart, against a tolerance of ${Math.round(input.tolerance.dateMs / 3_600_000)}.`,
        assignedTo: null,
        resolution: null,
        correctionJournalId: null,
        resolvedAt: null,
        resolvedById: null,
      });
    }

    matched += 1;
  }

  // Anything on the external side that no internal reference claimed.
  for (const [reference, externalRecords] of externalByReference) {
    if (internalByReference.has(reference)) continue;

    for (const externalRecord of externalRecords) {
      exceptions.push({
        kind: 'missing_internal',
        status: 'open',
        reference,
        internalAmount: null,
        externalAmount: externalRecord.amount,
        difference: null,
        internalId: null,
        externalId: externalRecord.sourceId,
        internalAt: null,
        externalAt: externalRecord.at,
        detail:
          `${formatMoney(moneyFromJson(externalRecord.amount, input.currencies))} appears on the ` +
          `external statement as "${reference}" with nothing matching it internally. Money the ` +
          'platform does not know about is the most urgent kind of exception.',
        assignedTo: null,
        resolution: null,
        correctionJournalId: null,
        resolvedAt: null,
        resolvedById: null,
      });
    }
  }

  const internalTotal = sumRecords(input.internal, input.currency, input.currencies);
  const externalTotal = sumRecords(input.external, input.currency, input.currencies);

  void zero;

  return {
    matched,
    exceptions,
    internalTotal,
    externalTotal,
    difference: subtractMoney(externalTotal, internalTotal),
  };
}

function sumRecords(
  records: ReconciliationRecord[],
  currency: string,
  currencies?: CurrencyRegistry,
): Money {
  return records.reduce<Money>(
    (sum, record) => addMoney(sum, moneyFromJson(record.amount, currencies)),
    zeroMoney(currency, currencies),
  );
}

/** Compares |difference| against a limit. Both are money in the same currency. */
function compareAbsolute(difference: Money, limit: Money): number {
  const magnitude: Money = {
    currency: difference.currency,
    amount: absolute(difference.amount),
  };

  return compareMoney(magnitude, limit);
}
