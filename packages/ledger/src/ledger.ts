import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '@trustos/errors';
import type { AuditService } from '@trustos/audit';
import type { LoggerPort } from '@trustos/logging';
import {
  addMoney,
  formatMoney,
  isZeroMoney,
  moneyFromJson,
  moneyToJson,
  subtractMoney,
  zeroMoney,
  type CurrencyRegistry,
  type Money,
} from '@trustos/financial-core';
import {
  assertBalanced,
  journalEntrySchema,
  journalSchema,
  mirrorEntries,
  type Journal,
  type JournalEntry,
} from './journal';
import {
  accountingPeriodSchema,
  assertPeriodOpen,
  overlapping,
  type AccountingPeriod,
  type PeriodStore,
} from './closing';

/**
 * The ledger service.
 *
 * Posting is the only operation that changes what a balance is, and it does four things in a fixed
 * order: validate, balance, hash, write. Every one of them happens before anything is durable, so
 * a journal that fails validation never existed rather than existing in a bad state.
 *
 * **Idempotency is not optional here.** A retried posting that posts twice doubles a movement of
 * money, and the second posting is indistinguishable from a legitimate second transaction for the
 * same amount. So `post` takes an idempotency key, the store enforces it with a unique constraint,
 * and a repeat returns the original journal rather than a new one.
 */

export interface LedgerStore {
  /**
   * Writes a posted journal.
   *
   * **Must be atomic and must enforce the idempotency key uniquely.** A read-then-write
   * implementation passes every single-threaded test and posts twice the moment two workers
   * retry together. The Prisma implementation uses a unique index and lets the database decide
   * the winner.
   */
  insert(journal: Journal, idempotencyKey: string | null): Promise<Journal>;

  /** Returns the existing journal for a key, or null. Called only after an insert conflict. */
  findByIdempotencyKey(key: string, organizationId: string | null): Promise<Journal | null>;

  find(id: string, organizationId: string | null): Promise<Journal | null>;

  /** Marks the original as reversed. The only permitted mutation of a posted journal. */
  markReversed(id: string, reversedByJournalId: string): Promise<Journal | null>;

  list(input: {
    organizationId: string | null;
    ledgerId?: string;
    accountId?: string;
    reference?: string;
    from?: Date;
    to?: Date;
    limit?: number;
    cursor?: string;
  }): Promise<Journal[]>;

  /**
   * Aggregated balances per account.
   *
   * Aggregated in the store rather than by summing journals in memory, because a busy account has
   * millions of entries and a balance query that reads them all is a balance query that times out
   * at exactly the moment somebody needs it.
   */
  balances(input: {
    organizationId: string | null;
    ledgerId?: string;
    accountIds?: string[];
    asOf?: Date;
  }): Promise<AccountBalance[]>;
}

export interface AccountBalance {
  accountId: string;
  currency: string;
  debits: Money;
  credits: Money;
  /** debits − credits. Its meaning depends on the account's normal side — see `@trustos/accounts`. */
  balance: Money;
  entryCount: number;
}

export interface LedgerOptions {
  store: LedgerStore;
  /**
   * Where accounting periods live.
   *
   * Optional. Without it nothing is ever closed, which is a legitimate configuration for a
   * platform that does not run periods — and the honest default, because a framework that
   * invented periods would refuse postings for a reason nobody configured.
   */
  periods?: PeriodStore;
  currencies?: CurrencyRegistry;
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  /** Currencies this ledger accepts. Empty means whatever the registry knows. */
  allowedCurrencies?: string[];
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export interface PostInput {
  organizationId: string | null;
  ledgerId?: string;
  description: string;
  entries: Omit<JournalEntry, 'id'>[];
  reference?: string | null;
  effectiveAt?: Date;
  actorId?: string | null;
  metadata?: Journal['metadata'];
  /** Required in practice. See the header. */
  idempotencyKey?: string | null;
}

export class Ledger {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: LedgerOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID().replace(/-/g, '')}`);
  }

  /**
   * Posts a journal.
   *
   * Posted journals are immutable from this point. There is no `update`, and there will not be
   * one: a correction is `reverse` or `adjust`, both of which post a new journal and leave the
   * original standing.
   */
  async post(input: PostInput): Promise<Journal> {
    const now = this.now();

    const entries = input.entries.map((entry) =>
      journalEntrySchema.parse({ ...entry, id: this.newId('ent') }),
    );

    this.assertCurrenciesAllowed(entries);

    // Balance before anything else that costs time. An unbalanced journal is the common mistake
    // and it should fail in microseconds.
    assertBalanced(entries, this.options.currencies);

    this.assertDistinctSides(entries);

    // The period check reads a row, so it comes after the free checks and before the write.
    await this.assertPeriodOpenFor(
      input.organizationId,
      input.ledgerId ?? 'default',
      input.effectiveAt ?? now,
    );

    const journal = journalSchema.parse({
      id: this.newId('jrn'),
      organizationId: input.organizationId,
      ledgerId: input.ledgerId ?? 'default',
      reference: input.reference ?? null,
      description: input.description,
      entries,
      status: 'posted',
      effectiveAt: input.effectiveAt ?? now,
      postedAt: now,
      postedById: input.actorId ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      createdById: input.actorId ?? null,
    });

    const hashed = { ...journal, contentHash: contentHashOf(journal) };

    let stored: Journal;

    try {
      stored = await this.options.store.insert(hashed, input.idempotencyKey ?? null);
    } catch (error) {
      /*
       * A conflict on the idempotency key is a *success*.
       *
       * The caller retried, the first attempt won, and returning that journal is the correct
       * answer. Rethrowing would make the caller retry again, and a caller that treats a
       * duplicate-key error as a failure eventually posts the journal a third way round.
       */
      const existing = input.idempotencyKey
        ? await this.options.store.findByIdempotencyKey(input.idempotencyKey, input.organizationId)
        : null;

      if (!existing) throw error;

      this.options.logger?.info(
        { journalId: existing.id, idempotencyKey: input.idempotencyKey },
        'ledger post returned the existing journal for this idempotency key',
      );

      return existing;
    }

    await this.options.audit?.record({
      action: 'ledger.journal.posted',
      entityType: 'Journal',
      entityId: stored.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      after: {
        ledgerId: stored.ledgerId,
        reference: stored.reference,
        description: stored.description,
        effectiveAt: stored.effectiveAt.toISOString(),
        contentHash: stored.contentHash,
        // Amounts and accounts, so the audit record alone shows what moved.
        entries: stored.entries.map((entry) => ({
          accountId: entry.accountId,
          direction: entry.direction,
          amount: `${entry.amount.amount} ${entry.amount.currency}`,
        })),
      },
    });

    return stored;
  }

  /**
   * Reverses a posted journal by posting its mirror image.
   *
   * The original is untouched except for a pointer to the reversal. Both journals remain in every
   * report; they net to zero, which is what a reversal means.
   */
  async reverse(input: {
    journalId: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
    effectiveAt?: Date;
    idempotencyKey?: string | null;
  }): Promise<{ original: Journal; reversal: Journal }> {
    const original = await this.require(input.journalId, input.organizationId);

    if (original.status === 'draft') {
      throw ApiError.conflict(
        'This journal has not been posted, so there is nothing to reverse. A draft is discarded, ' +
          'not reversed.',
        { reason: 'journal_not_posted', journalId: input.journalId },
      );
    }

    if (original.reversedByJournalId) {
      /*
       * Reversing a reversal is how a ledger doubles a correction.
       *
       * The second reversal balances on its own, posts cleanly, and leaves the account off by the
       * original amount in the other direction. Refused, and the message names the journal that
       * already did it.
       */
      throw ApiError.conflict(
        `This journal was already reversed by ${original.reversedByJournalId}. Reversing it again ` +
          'would move the money a second time. To undo the reversal, post its own reversal.',
        { reason: 'journal_already_reversed', journalId: input.journalId },
      );
    }

    if (!input.reason.trim()) {
      throw ApiError.validation(
        [
          {
            path: 'reason',
            message:
              'A reversal needs a reason. It is the only record of why the money moved back, and ' +
              'a year later the amounts alone do not say.',
          },
        ],
        'A reversal needs a reason.',
      );
    }

    this.assertUntampered(original);

    const reversal = await this.post({
      organizationId: input.organizationId,
      ledgerId: original.ledgerId,
      description: `Reversal of ${original.id}: ${input.reason}`,
      reference: original.reference,
      entries: mirrorEntries(original.entries, this.newId).map(({ id: _id, ...entry }) => entry),
      // The reversal's own effective date, defaulting to now rather than to the original's — a
      // reversal posted in March for a January journal belongs in March, or January's closed
      // period changes after it closed.
      effectiveAt: input.effectiveAt ?? this.now(),
      actorId: input.actorId,
      metadata: { ...original.metadata, reversesJournalId: original.id },
      idempotencyKey: input.idempotencyKey ?? `reverse:${original.id}`,
    });

    const marked = await this.options.store.markReversed(original.id, reversal.id);

    await this.options.audit?.record({
      action: 'ledger.journal.reversed',
      entityType: 'Journal',
      entityId: original.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      before: { status: original.status },
      after: { status: 'reversed', reversalJournalId: reversal.id, reason: input.reason },
    });

    return { original: marked ?? original, reversal };
  }

  /**
   * Posts an adjustment: a new journal that moves the difference.
   *
   * Distinct from a reversal, and the distinction is not cosmetic. A reversal says "this did not
   * happen"; an adjustment says "this happened, and this much more". A fee under-charged by 0.10
   * is an adjustment — reversing and reposting the whole fee makes the statement show a charge, a
   * refund and a charge, which a customer reads as an error.
   */
  async adjust(input: {
    journalId: string;
    organizationId: string | null;
    reason: string;
    entries: Omit<JournalEntry, 'id'>[];
    actorId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<Journal> {
    const original = await this.require(input.journalId, input.organizationId);
    this.assertUntampered(original);

    return this.post({
      organizationId: input.organizationId,
      ledgerId: original.ledgerId,
      description: `Adjustment to ${original.id}: ${input.reason}`,
      reference: original.reference,
      entries: input.entries,
      actorId: input.actorId,
      metadata: { adjustsJournalId: original.id },
      idempotencyKey: input.idempotencyKey ?? null,
    });
  }

  async get(id: string, organizationId: string | null): Promise<Journal> {
    const journal = await this.require(id, organizationId);
    this.assertUntampered(journal);
    return journal;
  }

  /**
   * Opens an accounting period.
   *
   * Refuses one that overlaps an existing period: two periods covering one instant means a journal
   * belongs to both, and which one a report uses depends on which query ran.
   */
  async openPeriod(input: {
    organizationId: string | null;
    code: string;
    startsAt: Date;
    endsAt: Date;
    ledgerId?: string;
  }): Promise<AccountingPeriod> {
    const periods = this.requirePeriods();
    const ledgerId = input.ledgerId ?? 'default';
    const now = this.now();

    const parsed = accountingPeriodSchema.safeParse({
      id: this.newId('per'),
      organizationId: input.organizationId,
      ledgerId,
      code: input.code,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    });

    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'period',
          message: issue.message,
        })),
        `The period "${input.code}" is not valid.`,
      );
    }

    const existing = await periods.list({ organizationId: input.organizationId, ledgerId });
    const clashes = overlapping(existing, {
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      ledgerId,
    });

    if (clashes.length > 0) {
      throw ApiError.conflict(
        `Period ${input.code} overlaps ${clashes.map((period) => period.code).join(', ')}. Two ` +
          'periods covering one instant means a journal belongs to both, and which one a report ' +
          'uses depends on which query ran.',
        { reason: 'period_overlap', code: input.code },
      );
    }

    return periods.create(parsed.data);
  }

  /**
   * Closes a period.
   *
   * Records the trial balance at the moment of closing, and refuses to close a period that does
   * not balance — closing a broken period freezes the break, and the report everybody then works
   * from is the wrong one.
   */
  async closePeriod(input: {
    id: string;
    organizationId: string | null;
    actorId?: string | null;
    note?: string;
    /** Closes anyway, recording that it was forced. For a period nobody can reconcile. */
    force?: boolean;
  }): Promise<AccountingPeriod> {
    const periods = this.requirePeriods();
    const period = await this.requirePeriod(input.id, input.organizationId);

    if (period.status === 'closed') {
      throw ApiError.conflict(`Period ${period.code} is already closed.`, {
        reason: 'period_already_closed',
        periodId: period.id,
      });
    }

    const trial = await this.trialBalance({
      organizationId: input.organizationId,
      ledgerId: period.ledgerId,
      asOf: period.endsAt,
    });

    if (!trial.balanced && input.force !== true) {
      throw ApiError.conflict(
        `Period ${period.code} does not balance, so closing it would freeze the break: ` +
          `${trial.problems.join(' ')} Investigate first, or close with force and record why.`,
        { reason: 'period_unbalanced', periodId: period.id },
      );
    }

    const now = this.now();

    const closed = await periods.update(period.id, {
      status: 'closed',
      closedAt: now,
      closedById: input.actorId ?? null,
      closingNote: input.note ?? null,
      closingTotals: trial.totals.map((total) => ({
        currency: total.currency,
        debits: formatMoney(total.debits).split(' ')[0]!,
        credits: formatMoney(total.credits).split(' ')[0]!,
      })),
      updatedAt: now,
    });

    if (!closed) throw ApiError.notFound(`No period with id "${input.id}".`);

    await this.options.audit?.record({
      action: 'ledger.period.closed',
      entityType: 'AccountingPeriod',
      entityId: period.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      before: { status: 'open' },
      after: {
        status: 'closed',
        code: period.code,
        balanced: trial.balanced,
        forced: input.force === true,
        note: input.note ?? null,
        totals: closed.closingTotals,
      },
    });

    return closed;
  }

  /**
   * Reopens a closed period.
   *
   * Loud on purpose: a reason is required and every reopening is kept. Refusing outright sounds
   * stricter and is worse — the correction happens anyway, as a journal dated after the close
   * with a description explaining that it belongs in March, which is the same lie told less
   * legibly.
   */
  async reopenPeriod(input: {
    id: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
  }): Promise<AccountingPeriod> {
    const periods = this.requirePeriods();
    const period = await this.requirePeriod(input.id, input.organizationId);

    if (period.status !== 'closed') {
      throw ApiError.conflict(`Period ${period.code} is not closed.`, {
        reason: 'period_not_closed',
        periodId: period.id,
      });
    }

    if (!input.reason.trim()) {
      throw ApiError.validation(
        [
          {
            path: 'reason',
            message:
              'Reopening a closed period needs a reason. It is the only record of why a period ' +
              'somebody already reported on was changed.',
          },
        ],
        'Reopening a period needs a reason.',
      );
    }

    const now = this.now();

    const reopened = await periods.update(period.id, {
      status: 'open',
      reopenings: [
        ...period.reopenings,
        { at: now, actorId: input.actorId ?? null, reason: input.reason },
      ],
      updatedAt: now,
    });

    if (!reopened) throw ApiError.notFound(`No period with id "${input.id}".`);

    await this.options.audit?.record({
      action: 'ledger.period.reopened',
      entityType: 'AccountingPeriod',
      entityId: period.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      before: { status: 'closed', closedAt: period.closedAt?.toISOString() ?? null },
      after: { status: 'open', reason: input.reason },
    });

    return reopened;
  }

  async periods(input: {
    organizationId: string | null;
    ledgerId?: string;
    status?: 'open' | 'closed';
    limit?: number;
  }): Promise<AccountingPeriod[]> {
    return this.requirePeriods().list(input);
  }

  async list(input: Parameters<LedgerStore['list']>[0]): Promise<Journal[]> {
    return this.options.store.list(input);
  }

  /**
   * Balances per account.
   *
   * `debits − credits`, which is positive for an asset or expense account with a normal balance
   * and negative for a liability, equity or revenue one. The interpretation belongs to
   * `@trustos/accounts`, which knows each account's normal side; the ledger reports the raw
   * arithmetic and does not guess.
   */
  async balances(input: Parameters<LedgerStore['balances']>[0]): Promise<AccountBalance[]> {
    return this.options.store.balances(input);
  }

  /**
   * The trial balance: every account, and whether the whole ledger balances.
   *
   * The single most useful integrity check in the system. If total debits do not equal total
   * credits, something has posted that should not have — and because every journal is checked at
   * posting, a trial balance that does not balance means the data was changed outside the
   * application.
   */
  async trialBalance(input: {
    organizationId: string | null;
    ledgerId?: string;
    asOf?: Date;
  }): Promise<TrialBalance> {
    const balances = await this.options.store.balances(input);
    const currencies = [...new Set(balances.map((entry) => entry.currency))].sort();

    const totals = currencies.map((currency) => {
      const relevant = balances.filter((entry) => entry.currency === currency);

      const debits = relevant.reduce<Money>(
        (total, entry) => addMoney(total, entry.debits),
        zeroMoney(currency, this.options.currencies),
      );
      const credits = relevant.reduce<Money>(
        (total, entry) => addMoney(total, entry.credits),
        zeroMoney(currency, this.options.currencies),
      );

      return { currency, debits, credits, difference: subtractMoney(debits, credits) };
    });

    const problems = totals
      .filter((total) => !isZeroMoney(total.difference))
      .map(
        (total) =>
          `${total.currency}: debits ${formatMoney(total.debits)} against credits ` +
          `${formatMoney(total.credits)}, out by ${formatMoney(total.difference)}. Every journal ` +
          'balances at posting, so a trial balance that does not balance means the ledger was ' +
          'changed outside the application.',
      );

    return {
      organizationId: input.organizationId ?? null,
      ledgerId: input.ledgerId ?? 'default',
      asOf: input.asOf ?? this.now(),
      accounts: balances,
      totals,
      balanced: problems.length === 0,
      problems,
    };
  }

  /**
   * Currencies this ledger accepts.
   *
   * Checked here rather than only at the account, because a journal is the thing that creates a
   * balance — and an account in a currency nobody configured produces a balance nobody can report
   * on or settle.
   */
  private assertCurrenciesAllowed(entries: JournalEntry[]): void {
    const allowed = this.options.allowedCurrencies;
    if (!allowed || allowed.length === 0) return;

    const used = [...new Set(entries.map((entry) => entry.amount.currency))];
    const rejected = used.filter((currency) => !allowed.includes(currency));

    if (rejected.length > 0) {
      throw ApiError.validation(
        rejected.map((currency) => ({
          path: 'entries.currency',
          message: `This ledger does not accept ${currency}. Accepted: ${allowed.join(', ')}.`,
        })),
        'Currency not permitted on this ledger.',
      );
    }
  }

  /**
   * Refuses a journal that debits and credits the same account for the same amount.
   *
   * It balances perfectly and moves nothing. Almost always a bug — a transfer where both sides
   * resolved to the same account, which is exactly the shape a mis-mapped account produces — and
   * it is invisible in every balance because it nets to zero.
   */
  private assertDistinctSides(entries: JournalEntry[]): void {
    const seen = new Map<string, { debit: bigint; credit: bigint }>();

    for (const entry of entries) {
      const key = `${entry.accountId}:${entry.amount.currency}`;
      const totals = seen.get(key) ?? { debit: 0n, credit: 0n };
      const units = BigInt(entry.amount.amount.replace('.', ''));

      totals[entry.direction] += units;
      seen.set(key, totals);
    }

    const noop = [...seen.entries()].filter(
      ([, totals]) => totals.debit > 0n && totals.debit === totals.credit,
    );

    if (noop.length > 0) {
      throw ApiError.validation(
        noop.map(([key]) => ({
          path: 'entries.accountId',
          message:
            `${key.split(':')[0]} is debited and credited for the same amount, which balances and ` +
            'moves nothing. This is usually a transfer where both sides resolved to the same ' +
            'account.',
        })),
        'A journal line cancels itself out.',
      );
    }
  }

  /**
   * Verifies the content hash.
   *
   * Called on every read that matters. The application's own database credentials can `UPDATE` a
   * posted journal, so the immutability enforced by this service is not the last word — this is.
   */
  private assertUntampered(journal: Journal): void {
    if (!journal.contentHash) return;

    const expected = contentHashOf(journal);

    if (expected !== journal.contentHash) {
      this.options.logger?.error(
        { journalId: journal.id, organizationId: journal.organizationId },
        'journal content hash mismatch',
      );

      throw ApiError.internal(
        `Journal ${journal.id} does not match its content hash. A posted journal is immutable, so ` +
          'this means the row was changed outside the application. Do not use this journal; ' +
          'investigate before anything else.',
        { reason: 'journal_tampered', journalId: journal.id },
      );
    }
  }

  private async require(id: string, organizationId: string | null): Promise<Journal> {
    const journal = await this.options.store.find(id, organizationId);
    if (!journal) throw ApiError.notFound(`No journal with id "${id}".`);
    return journal;
  }

  /**
   * Refuses a posting into a closed period.
   *
   * A no-op when no period store is configured, which is the honest default: a framework that
   * invented periods would refuse postings for a reason nobody configured.
   */
  private async assertPeriodOpenFor(
    organizationId: string | null,
    ledgerId: string,
    effectiveAt: Date,
  ): Promise<void> {
    if (!this.options.periods) return;

    const period = await this.options.periods.containing({
      organizationId,
      ledgerId,
      at: effectiveAt,
    });

    assertPeriodOpen(period, effectiveAt);
  }

  private requirePeriods(): PeriodStore {
    if (!this.options.periods) {
      throw ApiError.internal(
        'No period store is configured, so this ledger has no accounting periods. Wire one to use ' +
          'period closing.',
        { reason: 'periods_not_configured' },
      );
    }

    return this.options.periods;
  }

  private async requirePeriod(
    id: string,
    organizationId: string | null,
  ): Promise<AccountingPeriod> {
    const period = await this.requirePeriods().find(id, organizationId);
    if (!period) throw ApiError.notFound(`No period with id "${id}".`);
    return period;
  }
}

export interface TrialBalance {
  organizationId: string | null;
  ledgerId: string;
  asOf: Date;
  accounts: AccountBalance[];
  totals: Array<{ currency: string; debits: Money; credits: Money; difference: Money }>;
  balanced: boolean;
  problems: string[];
}

/**
 * The content hash.
 *
 * Over the fields that describe *what happened* — the entries, the effective date, the ledger and
 * the description — and not over status. A reversal sets `reversedByJournalId` and `status` on the
 * original, and that is a legitimate change; including them would make every reversal look like
 * tampering.
 */
export function contentHashOf(journal: Journal): string {
  const canonical = JSON.stringify({
    id: journal.id,
    organizationId: journal.organizationId,
    ledgerId: journal.ledgerId,
    reference: journal.reference,
    description: journal.description,
    effectiveAt: journal.effectiveAt.toISOString(),
    entries: journal.entries.map((entry) => ({
      accountId: entry.accountId,
      direction: entry.direction,
      amount: entry.amount,
      dimension: entry.dimension,
    })),
  });

  return createHash('sha256').update(canonical).digest('hex');
}

/** Money for an account balance, from raw sides. Shared so every store computes it identically. */
export function netBalance(debits: Money, credits: Money): Money {
  return subtractMoney(debits, credits);
}

/** Converts a stored entry's JSON money back to `Money`. */
export function entryAmount(entry: JournalEntry, registry?: CurrencyRegistry): Money {
  return moneyFromJson(entry.amount, registry);
}

/** For a store writing an entry back out. */
export function entryAmountToJson(amount: Money): JournalEntry['amount'] {
  return moneyToJson(amount);
}
