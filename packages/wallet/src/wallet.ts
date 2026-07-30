import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import {
  compareMoney,
  formatMoney,
  moneySchema,
  subtractMoney,
  type Money,
} from '@trustos/financial-core';

/**
 * Wallets.
 *
 * A wallet is a **view over ledger accounts**, not a balance of its own. That is the single design
 * decision this package exists to enforce, and it is worth being blunt about why: a wallet with
 * its own `balance` column has two sources of truth, they disagree within a month, and the one
 * everybody reads is the wrong one.
 *
 * So the balance is computed from the ledger, every time. It is slower than reading a column and
 * it is right, and a deployment that needs it faster caches it *beside* the ledger with the
 * journal id it was computed at — which is a cache, and can be rebuilt.
 *
 * **Three balances, not one.**
 *
 *   * `total` — everything the ledger says is in the wallet.
 *   * `held` — placed against a specific pending operation. An authorization, a pending payout.
 *   * `available` — `total − held`. What can actually be spent.
 *
 * A system with only `total` authorizes the same money twice: the first authorization has not
 * moved anything yet, so the second one sees the whole balance. Holds are what make an
 * authorization mean something before it is captured.
 */

export const WALLET_STATUSES = [
  'active',
  /** Money can leave, nothing can arrive. Same meaning as the account status it maps to. */
  'frozen',
  /** Nothing moves in either direction. */
  'blocked',
  'closed',
] as const;

export type WalletStatus = (typeof WALLET_STATUSES)[number];

export const walletSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),

    /** Who it belongs to. */
    ownerId: z.string().min(1).max(120),
    ownerType: z.string().max(60).default('user'),

    /** A label, for a customer with several wallets. */
    name: z.string().max(200).default(''),

    /** One currency per wallet. A multi-currency wallet is several wallets. */
    currency: z.string().min(3).max(8),

    /**
     * The ledger account this wallet is a view over.
     *
     * One account, and it is the wallet's whole balance. A wallet spanning several accounts would
     * have a balance that depends on which accounts somebody remembered to include.
     */
    accountId: z.string().min(1).max(120),

    status: z.enum(WALLET_STATUSES).default('active'),

    /** Limit keys that apply to this wallet, checked before every debit. */
    limitKeys: z.array(z.string().max(120)).max(20).default([]),

    metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),

    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    frozenAt: z.coerce.date().nullable().default(null),
    frozenReason: z.string().max(500).nullable().default(null),
    closedAt: z.coerce.date().nullable().default(null),
  })
  .strict();

export type Wallet = z.infer<typeof walletSchema>;

export const HOLD_STATUSES = [
  'active',
  /** The operation completed; the money moved and the hold ended with it. */
  'captured',
  /** Given back without moving. */
  'released',
  /** Not captured in time. Released automatically. */
  'expired',
] as const;

export type HoldStatus = (typeof HOLD_STATUSES)[number];

export const holdSchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),
    walletId: z.string().min(1).max(120),

    amount: moneySchema,
    status: z.enum(HOLD_STATUSES).default('active'),

    /** What the hold is for: an authorization, a payout, a dispute. */
    reason: z.string().min(1).max(500),
    /** The transaction or payment this hold belongs to. */
    reference: z.string().max(120).nullable().default(null),

    /**
     * When an uncaptured hold is released.
     *
     * Required, and there is no "no expiry" option. A hold with no expiry against a failed
     * process is money the customer cannot spend and nobody is coming back for — the balance is
     * simply wrong, permanently, and every support conversation about it ends in a manual fix.
     */
    expiresAt: z.coerce.date(),

    /** How much of the hold has been captured. A partial capture leaves the rest held. */
    capturedAmount: moneySchema.nullable().default(null),

    createdAt: z.coerce.date(),
    createdById: z.string().nullable().default(null),
    resolvedAt: z.coerce.date().nullable().default(null),
    resolvedReason: z.string().max(500).nullable().default(null),
  })
  .strict();

export type Hold = z.infer<typeof holdSchema>;

/** What a wallet is worth, in three numbers that a caller usually needs together. */
export interface WalletBalance {
  walletId: string;
  currency: string;
  /** Everything the ledger says is in the wallet. */
  total: Money;
  /** Placed against pending operations. */
  held: Money;
  /** `total − held`. What can be spent. */
  available: Money;
  /** How many active holds make up `held`. For a support screen. */
  holdCount: number;
  asOf: Date;
}

/**
 * Refuses a debit that the available balance cannot cover.
 *
 * Compares against **available**, never total. A wallet with 100 total and a 100 hold has zero
 * available, and a system that checks total authorizes the same money twice.
 */
export function assertSufficient(balance: WalletBalance, amount: Money): void {
  if (compareMoney(balance.available, amount) >= 0) return;

  const short = subtractMoney(amount, balance.available);

  throw ApiError.validation(
    [
      {
        path: 'amount',
        message:
          `${formatMoney(amount)} exceeds the available balance of ` +
          `${formatMoney(balance.available)} by ${formatMoney(short)}.` +
          (balance.held.amount.units > 0n
            ? ` The wallet holds ${formatMoney(balance.total)} in total, of which ` +
              `${formatMoney(balance.held)} is held against ${balance.holdCount} pending ` +
              'operation(s).'
            : ''),
        code: 'insufficient_funds',
      },
    ],
    'Insufficient available balance.',
  );
}

/** Whether a wallet accepts a movement in this direction right now. */
export function canMove(
  wallet: Wallet,
  direction: 'in' | 'out',
): { allowed: true } | { allowed: false; reason: string } {
  switch (wallet.status) {
    case 'active':
      return { allowed: true };

    case 'frozen':
      // Money can leave a frozen wallet, so an obligation can still be settled.
      return direction === 'out'
        ? { allowed: true }
        : {
            allowed: false,
            reason: `Wallet ${wallet.id} is frozen${wallet.frozenReason ? `: ${wallet.frozenReason}` : ''}. Money can still be paid out, but nothing new may be added.`,
          };

    case 'blocked':
      return {
        allowed: false,
        reason: `Wallet ${wallet.id} is blocked, so nothing moves in either direction.`,
      };

    case 'closed':
      return {
        allowed: false,
        reason: `Wallet ${wallet.id} is closed. Re-opening is a new wallet.`,
      };
  }
}

/** A hold that has passed its expiry and is still active. What the sweeper releases. */
export function isExpired(hold: Hold, at: Date): boolean {
  return hold.status === 'active' && hold.expiresAt <= at;
}
