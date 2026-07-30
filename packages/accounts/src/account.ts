import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import { formatMoney, negateMoney, type Money } from '@trustos/financial-core';
import type { AccountBalance } from '@trustos/ledger';

/**
 * The account tree.
 *
 * An account is where a balance lives, and its **type** is what makes the balance mean something.
 * The ledger reports `debits − credits` and refuses to guess; this package knows that a positive
 * number on a customer wallet is money the business *owes*, and a positive number on a cash
 * account is money it *has*.
 *
 * **The normal side is the whole idea.** Assets and expenses increase with debits; liabilities,
 * equity and revenue increase with credits. Get it backwards for one account type and every
 * balance in it is reported with the wrong sign — which looks like a bug in the ledger and is not.
 *
 * **A customer wallet is a liability.** This surprises people building their first ledger and it
 * is the most important line in this file: money a customer has deposited is money the business
 * owes them, so the wallet account is credited when they deposit and debited when they spend. A
 * system that models it as an asset reports its own obligations as its own money.
 */

export const ACCOUNT_CLASSES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
export type AccountClass = (typeof ACCOUNT_CLASSES)[number];

/** Which side increases the account. Derived from the class; never set by hand. */
export const NORMAL_SIDE: Record<AccountClass, 'debit' | 'credit'> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
};

export const ACCOUNT_TYPES = {
  /** A customer's balance. A liability: the business owes it. See the header. */
  customer: { class: 'liability', description: "A customer's balance. Money the business owes." },
  /** A merchant's balance, pending payout. Also a liability. */
  merchant: { class: 'liability', description: "A merchant's balance awaiting payout." },
  /** The business's own money: a bank account, a cash drawer, a provider float. */
  system: { class: 'asset', description: "The business's own funds." },
  /**
   * Amounts instructed to a counterparty and not yet paid.
   *
   * A **liability**, and the choice is worth stating because the other model is defensible and
   * incompatible. "Cash in transit" is an asset: money that has left your bank and not arrived.
   * This is settlement *payable*: you have instructed the bank, the cash is still in your bank
   * account, and you owe it to the counterparty until it leaves.
   *
   * The platform instructs rather than moves cash itself, so payable is the accurate model — and
   * the settlement journals in `@trustos/settlement` are written to match. Changing this class
   * without changing those journals reports every in-transit balance with the wrong sign.
   */
  settlement: {
    class: 'liability',
    description: 'Amounts instructed to a counterparty and not yet paid out.',
  },
  /**
   * Money that arrived and has not been identified.
   *
   * Every real financial system needs one, and a system without one puts unidentified money
   * somewhere it does not belong. A suspense balance that is not zero at close is a queue of work,
   * which is exactly what it should be.
   */
  suspense: { class: 'liability', description: 'Money received and not yet identified.' },
  /** Fees the business has earned. Revenue. */
  fee: { class: 'revenue', description: 'Fees earned.' },
  /** Funds held back against chargebacks or risk. A liability: still the counterparty's money. */
  reserve: { class: 'liability', description: 'Funds withheld against future obligations.' },
  /** Anything else the deployment needs. Class is declared explicitly. */
  general: { class: 'asset', description: 'A general-purpose account.' },
} as const;

export type AccountType = keyof typeof ACCOUNT_TYPES;

export const ACCOUNT_STATUSES = [
  'active',
  /** No new postings. Existing balance stands, and can be moved out. */
  'frozen',
  /** No postings at all, in or out. For an account under investigation. */
  'blocked',
  /** Zero balance, retained for history. Re-opening is a new account. */
  'closed',
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const accountSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),

    /** Stable, human-readable, unique per tenant: `customer.usr_1.usd`, `system.bank.usd`. */
    code: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, 'An account code is lowercase, dot-separated.'),
    name: z.string().min(1).max(200),

    type: z.enum(Object.keys(ACCOUNT_TYPES) as [AccountType, ...AccountType[]]),
    /** Derived from the type unless the type is `general`. Never contradicts it. */
    class: z.enum(ACCOUNT_CLASSES),

    /**
     * One currency per account, and it never changes.
     *
     * A multi-currency account is two balances pretending to be one, and every question about it
     * ("what is the balance") has two answers. One account per currency; a wallet that holds three
     * currencies has three accounts.
     */
    currency: z.string().min(3).max(8),

    status: z.enum(ACCOUNT_STATUSES).default('active'),

    /** Who it belongs to: a user, a merchant, a service account. Null for a system account. */
    ownerId: z.string().max(120).nullable().default(null),
    ownerType: z.string().max(60).nullable().default(null),

    /** Which ledger this account posts to. */
    ledgerId: z.string().max(120).default('default'),

    /** For a tree: a parent account this rolls up into on a report. */
    parentAccountId: z.string().max(120).nullable().default(null),

    /**
     * Whether the balance may go past zero on its normal side.
     *
     * False by default and for almost everything. A customer wallet that can go negative is an
     * unsecured loan the business did not decide to make.
     */
    allowNegative: z.boolean().default(false),

    /** How far past zero, when `allowNegative` is set. Null means no bound, which needs a reason. */
    overdraftLimit: z.string().nullable().default(null),

    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),

    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    closedAt: z.coerce.date().nullable().default(null),
  })
  .strict()
  .superRefine((account, ctx) => {
    const expected = ACCOUNT_TYPES[account.type].class;

    if (account.type !== 'general' && account.class !== expected) {
      /*
       * A customer account declared as an asset.
       *
       * Refused, because every balance in it would then be reported with the wrong sign — and the
       * report looks like a ledger bug rather than a configuration mistake.
       */
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['class'],
        message:
          `A ${account.type} account is a ${expected}, not a ${account.class}. Declaring it the ` +
          'other way round reports every balance in it with the wrong sign.',
      });
    }

    if (account.overdraftLimit !== null && !account.allowNegative) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['overdraftLimit'],
        message:
          'An overdraft limit was set but the account does not allow a negative balance, so the ' +
          'limit can never apply. Set allowNegative, or remove the limit.',
      });
    }
  });

export type Account = z.infer<typeof accountSchema>;

/**
 * The balance as the account means it.
 *
 * The ledger reports `debits − credits`. For a liability that number is negative when the account
 * holds money, which is arithmetically right and reads backwards on a statement. This flips it to
 * the account's normal side, so "balance" means "how much is in it" for every account type.
 */
export function normalBalance(account: Pick<Account, 'class'>, raw: Money): Money {
  return NORMAL_SIDE[account.class] === 'debit' ? raw : negateMoney(raw);
}

/** The signed balance from a ledger report, in the account's own terms. */
export function accountBalanceOf(
  account: Pick<Account, 'class' | 'currency'>,
  balances: AccountBalance[],
  accountId: string,
): Money | null {
  const found = balances.find(
    (entry) => entry.accountId === accountId && entry.currency === account.currency,
  );

  return found ? normalBalance(account, found.balance) : null;
}

/**
 * Whether a posting to this account is permitted right now.
 *
 * Returns a reason rather than a boolean, because "the posting was refused" with no reason sends
 * somebody to read the account row, and the answer is usually one word.
 */
export function canPost(
  account: Account,
  direction: 'debit' | 'credit',
): { allowed: true } | { allowed: false; reason: string } {
  if (account.status === 'active') return { allowed: true };

  if (account.status === 'closed') {
    return {
      allowed: false,
      reason: `Account ${account.code} is closed. Re-opening is a new account, not a status change.`,
    };
  }

  if (account.status === 'blocked') {
    return {
      allowed: false,
      reason: `Account ${account.code} is blocked, so nothing may post to it in either direction.`,
    };
  }

  // Frozen: money may leave, so the obligation can be settled, but nothing new comes in.
  const outward = NORMAL_SIDE[account.class] === 'debit' ? 'credit' : 'debit';

  if (direction === outward) return { allowed: true };

  return {
    allowed: false,
    reason:
      `Account ${account.code} is frozen. Existing funds can still be moved out, but nothing new ` +
      'may be added.',
  };
}

/**
 * Refuses a posting that would take an account past zero.
 *
 * Checked against the balance *after* the posting, which the caller computes — this function does
 * not read a balance, because the caller has already read it under whatever lock it holds and a
 * second read here would be a different number.
 */
export function assertWithinOverdraft(
  account: Account,
  balanceAfter: Money,
  parseLimit: (value: string) => Money,
): void {
  if (balanceAfter.amount.units >= 0n) return;

  if (!account.allowNegative) {
    throw ApiError.validation(
      [
        {
          path: 'amount',
          message:
            `This would take ${account.code} to ${formatMoney(balanceAfter)}, and the account does ` +
            'not allow a negative balance. A customer balance that can go negative is an ' +
            'unsecured loan nobody decided to make.',
          code: 'insufficient_funds',
        },
      ],
      'Insufficient funds.',
    );
  }

  if (account.overdraftLimit === null) return;

  const limit = parseLimit(account.overdraftLimit);

  if (-balanceAfter.amount.units > limit.amount.units) {
    throw ApiError.validation(
      [
        {
          path: 'amount',
          message:
            `This would take ${account.code} to ${formatMoney(balanceAfter)}, past its overdraft ` +
            `limit of ${formatMoney(limit)}.`,
          code: 'overdraft_exceeded',
        },
      ],
      'Overdraft limit exceeded.',
    );
  }
}

/** The class an account type implies. For building an account without restating it. */
export function classFor(type: AccountType): AccountClass {
  return ACCOUNT_TYPES[type].class;
}

/**
 * The conventional code for an account.
 *
 * A convention rather than a rule, and it is here so that two parts of one application do not
 * invent two conventions. `customer.usr_1.usd`, `system.bank.usd`, `fee.processing.usd`.
 */
export function accountCode(type: AccountType, subject: string, currency: string): string {
  return `${type}.${subject}.${currency}`.toLowerCase();
}
