import { ApiError } from '@trustos/errors';
import {
  addMoney,
  moneyFromJson,
  subtractMoney,
  zeroMoney,
  type CurrencyRegistry,
  type Money,
} from '@trustos/financial-core';
import type { AccountBalance, LedgerStore } from './ledger';
import type { Journal } from './journal';
import { contains, type AccountingPeriod, type PeriodStatus, type PeriodStore } from './closing';

/**
 * An in-memory ledger store, for tests and development.
 *
 * The idempotency map is the part worth reading: it is a `Map` keyed on
 * `organizationId:idempotencyKey` and the insert throws on a duplicate, which is what a real
 * store's unique index does. Making the fake behave like the constraint is the only way a test
 * exercises the retry path rather than a code path that only exists in tests.
 */
export class InMemoryLedgerStore implements LedgerStore {
  readonly journals = new Map<string, Journal>();
  private readonly byIdempotencyKey = new Map<string, string>();

  constructor(private readonly currencies?: CurrencyRegistry) {}

  async insert(journal: Journal, idempotencyKey: string | null): Promise<Journal> {
    if (idempotencyKey) {
      const scoped = `${journal.organizationId ?? 'platform'}:${idempotencyKey}`;

      if (this.byIdempotencyKey.has(scoped)) {
        // What a unique index does. The service catches this and returns the original.
        throw ApiError.conflict(`Duplicate idempotency key "${idempotencyKey}".`, {
          reason: 'duplicate_idempotency_key',
        });
      }

      this.byIdempotencyKey.set(scoped, journal.id);
    }

    this.journals.set(journal.id, journal);
    return journal;
  }

  async findByIdempotencyKey(key: string, organizationId: string | null): Promise<Journal | null> {
    const id = this.byIdempotencyKey.get(`${organizationId ?? 'platform'}:${key}`);
    return id ? (this.journals.get(id) ?? null) : null;
  }

  async find(id: string, organizationId: string | null): Promise<Journal | null> {
    const journal = this.journals.get(id);
    if (!journal || journal.organizationId !== organizationId) return null;
    return journal;
  }

  async markReversed(id: string, reversedByJournalId: string): Promise<Journal | null> {
    const journal = this.journals.get(id);
    if (!journal) return null;

    // The only permitted mutation of a posted journal, and it does not touch the entries — which
    // is why the content hash still verifies afterwards.
    const updated: Journal = { ...journal, status: 'reversed', reversedByJournalId };
    this.journals.set(id, updated);
    return updated;
  }

  async list(input: {
    organizationId: string | null;
    ledgerId?: string;
    accountId?: string;
    reference?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<Journal[]> {
    return [...this.journals.values()]
      .filter((journal) => journal.organizationId === input.organizationId)
      .filter((journal) => !input.ledgerId || journal.ledgerId === input.ledgerId)
      .filter(
        (journal) =>
          !input.accountId || journal.entries.some((entry) => entry.accountId === input.accountId),
      )
      .filter((journal) => !input.reference || journal.reference === input.reference)
      .filter((journal) => !input.from || journal.effectiveAt >= input.from)
      .filter((journal) => !input.to || journal.effectiveAt <= input.to)
      .sort((a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, input.limit ?? 500);
  }

  async balances(input: {
    organizationId: string | null;
    ledgerId?: string;
    accountIds?: string[];
    asOf?: Date;
  }): Promise<AccountBalance[]> {
    const totals = new Map<string, { debits: Money; credits: Money; entryCount: number }>();

    for (const journal of this.journals.values()) {
      if (journal.organizationId !== input.organizationId) continue;
      if (input.ledgerId && journal.ledgerId !== input.ledgerId) continue;
      if (input.asOf && journal.effectiveAt > input.asOf) continue;
      // A draft affects no balance. Only posted and reversed journals count, and a reversed one
      // still counts — its reversal is a separate journal that offsets it.
      if (journal.status === 'draft') continue;

      for (const entry of journal.entries) {
        if (input.accountIds && !input.accountIds.includes(entry.accountId)) continue;

        const key = `${entry.accountId}:${entry.amount.currency}`;
        const current = totals.get(key) ?? {
          debits: zeroMoney(entry.amount.currency, this.currencies),
          credits: zeroMoney(entry.amount.currency, this.currencies),
          entryCount: 0,
        };

        const amount = moneyFromJson(entry.amount, this.currencies);

        totals.set(key, {
          debits: entry.direction === 'debit' ? addMoney(current.debits, amount) : current.debits,
          credits:
            entry.direction === 'credit' ? addMoney(current.credits, amount) : current.credits,
          entryCount: current.entryCount + 1,
        });
      }
    }

    return [...totals.entries()]
      .map(([key, value]) => {
        const [accountId, currency] = key.split(':') as [string, string];

        return {
          accountId,
          currency,
          debits: value.debits,
          credits: value.credits,
          balance: subtractMoney(value.debits, value.credits),
          entryCount: value.entryCount,
        };
      })
      .sort(
        (a, b) => a.accountId.localeCompare(b.accountId) || a.currency.localeCompare(b.currency),
      );
  }
}

/**
 * An in-memory period store, for tests and development.
 *
 * `containing` is called on every posting. A real implementation indexes on
 * `(organizationId, ledgerId, startsAt, endsAt)`; a linear scan here is fine for a handful of
 * periods and would not be at volume.
 */
export class InMemoryPeriodStore implements PeriodStore {
  readonly periods = new Map<string, AccountingPeriod>();

  async create(period: AccountingPeriod): Promise<AccountingPeriod> {
    this.periods.set(period.id, period);
    return period;
  }

  async find(id: string, organizationId: string | null): Promise<AccountingPeriod | null> {
    const period = this.periods.get(id);
    if (!period || period.organizationId !== organizationId) return null;
    return period;
  }

  async update(id: string, patch: Partial<AccountingPeriod>): Promise<AccountingPeriod | null> {
    const period = this.periods.get(id);
    if (!period) return null;

    const updated = { ...period, ...patch } as AccountingPeriod;
    this.periods.set(id, updated);
    return updated;
  }

  async containing(input: {
    organizationId: string | null;
    ledgerId: string;
    at: Date;
  }): Promise<AccountingPeriod | null> {
    return (
      [...this.periods.values()]
        .filter((period) => period.organizationId === input.organizationId)
        .filter((period) => period.ledgerId === input.ledgerId)
        .find((period) => contains(period, input.at)) ?? null
    );
  }

  async list(input: {
    organizationId: string | null;
    ledgerId?: string;
    status?: PeriodStatus;
    limit?: number;
  }): Promise<AccountingPeriod[]> {
    return [...this.periods.values()]
      .filter((period) => period.organizationId === input.organizationId)
      .filter((period) => !input.ledgerId || period.ledgerId === input.ledgerId)
      .filter((period) => !input.status || period.status === input.status)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .slice(0, input.limit ?? 200);
  }
}
