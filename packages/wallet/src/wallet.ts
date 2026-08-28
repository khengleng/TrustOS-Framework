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
 * **Four balances, not one.**
 *
 *   * `total` — everything the ledger says is in the wallet.
 *   * `held` — placed against a *specific pending operation*: an authorization, a pending payout.
 *     Short-lived, expires, and ends when the operation does.
 *   * `reserved` — a standing floor that belongs to no operation: a rolling reserve against
 *     chargebacks, a regulatory minimum, a security deposit. No expiry, and released deliberately.
 *   * `available` — `total − held − reserved`. What can actually be spent.
 *
 * A system with only `total` authorizes the same money twice: the first authorization has not
 * moved anything yet, so the second one sees the whole balance. Holds are what make an
 * authorization mean something before it is captured.
 *
 * **Held and reserved are separate because their lifecycles are opposite.** A hold that has
 * outlived its operation is a bug and the sweeper releases it; a reserve that has sat there for a
 * year is working exactly as intended. Merging them means either the sweeper releases somebody's
 * chargeback reserve, or nothing sweeps and a dead authorization freezes money forever. Both have
 * happened to systems that modelled one number.
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

export const HOLD_KINDS = [
  /**
   * Against a specific pending operation.
   *
   * Expires. The sweeper releases it, because a hold that outlived its operation is money the
   * customer cannot spend and nobody is coming back for.
   */
  'hold',
  /**
   * A standing floor.
   *
   * Does not expire and the sweeper never touches it. Released only by somebody deciding to,
   * which is the point: a rolling reserve that expired on a timer would be a rolling reserve that
   * silently stopped covering anything.
   */
  'reserve',
] as const;

export type HoldKind = (typeof HOLD_KINDS)[number];

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
    /** `hold` expires and is swept; `reserve` does not and is not. See `HOLD_KINDS`. */
    kind: z.enum(HOLD_KINDS).default('hold'),
    status: z.enum(HOLD_STATUSES).default('active'),

    /** What the hold is for: an authorization, a payout, a dispute. */
    reason: z.string().min(1).max(500),
    /** The transaction or payment this hold belongs to. */
    reference: z.string().max(120).nullable().default(null),

    /**
     * When an uncaptured hold is released.
     *
     * Required for a `hold`, and there is no "no expiry" option for one: a hold with no expiry
     * against a failed process is money the customer cannot spend and nobody is coming back for.
     *
     * Null for a `reserve`, and that asymmetry is the whole distinction between the two kinds.
     */
    expiresAt: z.coerce.date().nullable().default(null),

    /** How much of the hold has been captured. A partial capture leaves the rest held. */
    capturedAmount: moneySchema.nullable().default(null),

    createdAt: z.coerce.date(),
    createdById: z.string().nullable().default(null),
    resolvedAt: z.coerce.date().nullable().default(null),
    resolvedReason: z.string().max(500).nullable().default(null),
  })
  .strict()
  .superRefine((hold, ctx) => {
    if (hold.kind === 'hold' && hold.expiresAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message:
          'A hold needs an expiry. A hold against a process that died is money the customer ' +
          'cannot spend and nobody is coming back for. A standing floor is a reserve, not a hold.',
      });
    }

    if (hold.kind === 'reserve' && hold.expiresAt !== null) {
      /*
       * A reserve with an expiry.
       *
       * Refused, because the sweeper would eventually release it — and a rolling reserve that
       * silently stopped covering anything is worse than one that was never set up.
       */
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message:
          'A reserve does not expire. Giving one an expiry means the sweeper eventually releases ' +
          'it, and a rolling reserve that silently stops covering anything is worse than none.',
      });
    }
  });

export type Hold = z.infer<typeof holdSchema>;

/** What a wallet is worth, in the numbers a caller usually needs together. */
export interface WalletBalance {
  walletId: string;
  currency: string;
  /** Everything the ledger says is in the wallet. */
  total: Money;
  /** Placed against pending operations. Expires; the sweeper releases it. */
  held: Money;
  /** A standing floor. Does not expire; released deliberately. */
  reserved: Money;
  /** `total − held − reserved`. What can be spent. */
  available: Money;
  /** How many active holds make up `held`. For a support screen. */
  holdCount: number;
  /** How many reserves make up `reserved`. */
  reserveCount: number;
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
            : '') +
          (balance.reserved.amount.units > 0n
            ? ` ${formatMoney(balance.reserved)} is reserved across ${balance.reserveCount} ` +
              'standing reserve(s), which do not expire.'
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

/**
 * A hold that has passed its expiry and is still active. What the sweeper releases.
 *
 * A reserve is never expired, whatever the date: it has no expiry, and the sweeper must not touch
 * it. This function is the only place that distinction is decided, so there is one answer rather
 * than one per caller.
 */
export function isExpired(hold: Hold, at: Date): boolean {
  if (hold.kind === 'reserve' || hold.expiresAt === null) return false;

  return hold.status === 'active' && hold.expiresAt <= at;
}
