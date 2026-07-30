import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import {
  addMoney,
  formatMoney,
  isZeroMoney,
  moneySchema,
  moneyFromJson,
  moneyToJson,
  subtractMoney,
  zeroMoney,
  type CurrencyRegistry,
  type Money,
} from '@trustos/financial-core';

/**
 * Double-entry bookkeeping.
 *
 * Every movement of value is recorded twice: once as a debit and once as a credit, and the two
 * sides sum to zero. That is not an accounting convention for its own sake — it is the only
 * property that makes an error *findable*. A single-entry system that loses a transaction has a
 * wrong balance and no way to know; a double-entry system that loses one side has a trial balance
 * that does not balance, and the discrepancy names the account.
 *
 * Three rules are absolute here, and each is enforced rather than documented:
 *
 *   1. **A journal must balance before it posts.** Debits equal credits, per currency. An
 *      unbalanced journal is refused, and the error says by how much and in which currency.
 *   2. **A posted journal is immutable.** No edit, no delete, no status change other than to
 *      record that a *reversal* exists. Correcting a posted journal by editing it destroys the
 *      audit trail that is the whole point of keeping one.
 *   3. **A correction is a new journal.** Reversal posts the mirror image; adjustment posts a
 *      difference. Both leave the original standing, which is what lets somebody a year later
 *      reconstruct what was believed at the time.
 *
 * **On signs.** An entry carries a `direction` and a *positive* amount rather than a signed
 * amount. A signed representation invites `-` to mean credit in one place and "money going out"
 * in another, and the two are not the same thing — a credit to a liability account increases it.
 */

export const ENTRY_DIRECTIONS = ['debit', 'credit'] as const;
export type EntryDirection = (typeof ENTRY_DIRECTIONS)[number];

export const JOURNAL_STATUSES = [
  /** Written and not yet posted. Editable, and affects no balance. */
  'draft',
  /** Posted. Immutable, and included in every balance. */
  'posted',
  /** Posted, and later reversed by another journal. Still included; the reversal offsets it. */
  'reversed',
] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

export const journalEntrySchema = z
  .object({
    id: z.string(),
    accountId: z.string().min(1).max(120),
    direction: z.enum(ENTRY_DIRECTIONS),

    /** Always positive. The direction carries the sign. See the header. */
    amount: moneySchema,

    /** What this line is for, in words. Appears on a statement. */
    description: z.string().max(500).default(''),

    /**
     * Which side of the business this line belongs to.
     *
     * Optional and free-form: a cost centre, a product, a merchant. Reporting groups on it, and
     * nothing here interprets it.
     */
    dimension: z.string().max(120).nullable().default(null),

    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  })
  .strict();

export type JournalEntry = z.infer<typeof journalEntrySchema>;

export const journalSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),

    /** Which ledger. A tenant may keep several — operational, regulatory, management. */
    ledgerId: z.string().min(1).max(120).default('default'),

    /** A human reference: an invoice number, a settlement batch, a transaction id. */
    reference: z.string().max(120).nullable().default(null),
    description: z.string().min(1).max(1000),

    entries: z.array(journalEntrySchema).min(2).max(1000),

    status: z.enum(JOURNAL_STATUSES).default('draft'),

    /**
     * When this journal is *effective*, which is not when it was written.
     *
     * A settlement received on Monday for Friday's trading is effective Friday. Reports are run
     * on effective date; the audit trail uses `postedAt`. Conflating them makes a month-end report
     * change after the month has ended.
     */
    effectiveAt: z.coerce.date(),
    postedAt: z.coerce.date().nullable().default(null),
    postedById: z.string().nullable().default(null),

    /** Set on the original when a reversal posts. Points at the reversing journal. */
    reversedByJournalId: z.string().nullable().default(null),
    /** Set on the reversal. Points at what it reverses. */
    reversesJournalId: z.string().nullable().default(null),

    /**
     * SHA-256 over the entries, computed at posting.
     *
     * The tamper check. Recomputed whenever a journal is read for a balance, so a direct `UPDATE`
     * against the table — which the application's own credentials can perform — is detected rather
     * than trusted.
     */
    contentHash: z.string().nullable().default(null),

    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),

    createdAt: z.coerce.date(),
    createdById: z.string().nullable().default(null),
  })
  .strict();

export type Journal = z.infer<typeof journalSchema>;

/** Money per currency, by direction. What `checkBalance` returns and errors quote. */
export interface BalanceSummary {
  currency: string;
  debits: Money;
  credits: Money;
  /** debits − credits. Zero when the journal balances in this currency. */
  difference: Money;
}

/**
 * Whether a set of entries balances, per currency.
 *
 * **Per currency, not in total.** A journal with a 100 USD debit and a 400,000 KHR credit does not
 * balance, however close the two are at today's rate — the exchange goes through an FX account
 * with its own two entries, so the journal balances in both currencies separately. Netting across
 * currencies inside one journal hides the rate that was used, which is the number somebody will
 * need.
 */
export function checkBalance(
  entries: Pick<JournalEntry, 'direction' | 'amount'>[],
  registry?: CurrencyRegistry,
): BalanceSummary[] {
  const currencies = [...new Set(entries.map((entry) => entry.amount.currency))].sort();

  return currencies.map((currency) => {
    const of = (direction: EntryDirection) =>
      entries
        .filter((entry) => entry.amount.currency === currency && entry.direction === direction)
        .reduce<Money>(
          (total, entry) => addMoney(total, moneyFromJson(entry.amount, registry)),
          zeroMoney(currency, registry),
        );

    const debits = of('debit');
    const credits = of('credit');

    return { currency, debits, credits, difference: subtractMoney(debits, credits) };
  });
}

export function isBalanced(
  entries: Pick<JournalEntry, 'direction' | 'amount'>[],
  registry?: CurrencyRegistry,
): boolean {
  return checkBalance(entries, registry).every((summary) => isZeroMoney(summary.difference));
}

/**
 * Refuses an unbalanced journal, saying by how much and in which currency.
 *
 * "Journal does not balance" sends somebody to read every line. "Journal does not balance: USD
 * debits exceed credits by 0.01" sends them to the rounding.
 */
export function assertBalanced(
  entries: Pick<JournalEntry, 'direction' | 'amount'>[],
  registry?: CurrencyRegistry,
): void {
  const unbalanced = checkBalance(entries, registry).filter(
    (summary) => !isZeroMoney(summary.difference),
  );

  if (unbalanced.length === 0) return;

  throw ApiError.validation(
    unbalanced.map((summary) => ({
      path: `entries.${summary.currency}`,
      message:
        `${summary.currency} debits are ${formatMoney(summary.debits)} and credits are ` +
        `${formatMoney(summary.credits)}, a difference of ${formatMoney(summary.difference)}. ` +
        'Every journal must balance in every currency it touches — an exchange goes through an ' +
        'FX account with its own two entries rather than netting across currencies here.',
      code: 'journal_unbalanced',
    })),
    'This journal does not balance.',
  );
}

/**
 * Builds the mirror image of a journal.
 *
 * Every debit becomes a credit and every credit a debit, for the same amounts and accounts. The
 * result posts as a new journal, so the original stands untouched and the pair nets to zero.
 *
 * This is the *only* correct way to undo a posting. Deleting the original destroys the record that
 * it happened, and editing it produces a document that never existed at the time anybody acted on
 * it.
 */
export function mirrorEntries(
  entries: JournalEntry[],
  newId: (prefix: string) => string,
): JournalEntry[] {
  return entries.map((entry) =>
    journalEntrySchema.parse({
      ...entry,
      id: newId('ent'),
      direction: entry.direction === 'debit' ? 'credit' : 'debit',
      description: entry.description ? `Reversal: ${entry.description}` : 'Reversal',
    }),
  );
}

/**
 * A debit line.
 *
 * A helper rather than a raw object literal, because the two most common journal mistakes are a
 * transposed direction and an amount on the wrong account — and `debit(cash, amount)` reads as a
 * sentence in a way `{ direction: 'debit', accountId: cash }` does not.
 */
export function debit(
  accountId: string,
  amount: Money,
  options: {
    description?: string;
    dimension?: string | null;
    metadata?: JournalEntry['metadata'];
  } = {},
): Omit<JournalEntry, 'id'> {
  return line('debit', accountId, amount, options);
}

/** A credit line. */
export function credit(
  accountId: string,
  amount: Money,
  options: {
    description?: string;
    dimension?: string | null;
    metadata?: JournalEntry['metadata'];
  } = {},
): Omit<JournalEntry, 'id'> {
  return line('credit', accountId, amount, options);
}

function line(
  direction: EntryDirection,
  accountId: string,
  amount: Money,
  options: { description?: string; dimension?: string | null; metadata?: JournalEntry['metadata'] },
): Omit<JournalEntry, 'id'> {
  if (amount.amount.units < 0n) {
    /*
     * A negative amount on an entry.
     *
     * Refused rather than normalised, because a negative debit and a credit are the same movement
     * written two ways — and a ledger that accepts both has two representations of every posting,
     * so a report that groups by direction is wrong in a way nothing detects.
     */
    throw ApiError.validation(
      [
        {
          path: 'amount',
          message:
            `A ${direction} of ${formatMoney(amount)} is negative. Entry amounts are always ` +
            `positive and the direction carries the sign — a negative ${direction} is a ` +
            `${direction === 'debit' ? 'credit' : 'debit'} written backwards.`,
        },
      ],
      'Negative entry amount.',
    );
  }

  return {
    accountId,
    direction,
    amount: moneyToJson(amount),
    description: options.description ?? '',
    dimension: options.dimension ?? null,
    metadata: options.metadata ?? {},
  };
}
