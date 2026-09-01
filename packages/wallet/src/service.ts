import { randomUUID } from 'node:crypto';
import { ApiError } from '@trustsystem/errors';
import type { AuditService } from '@trustsystem/audit';
import type { LoggerPort } from '@trustsystem/logging';
import {
  addMoney,
  compareMoney,
  formatMoney,
  isPositiveMoney,
  moneyFromJson,
  moneyToJson,
  subtractMoney,
  zeroMoney,
  type CurrencyRegistry,
  type Money,
} from '@trustsystem/financial-core';
import type { AccountService } from '@trustsystem/accounts';
import { credit, debit, type Journal, type Ledger } from '@trustsystem/ledger';
import type { LimitEngine } from '@trustsystem/limits';
import {
  assertSufficient,
  canMove,
  holdSchema,
  isExpired,
  walletSchema,
  type Hold,
  type Wallet,
  type WalletBalance,
} from './wallet';

/**
 * The wallet service.
 *
 * Every balance is read from the ledger. Every movement is a journal. There is no path in this
 * package that changes a number without a corresponding posting, and that is the property that
 * makes a wallet reconcilable — the wallet and the ledger cannot disagree, because there is only
 * one of them.
 */

export interface WalletStore {
  create(wallet: Wallet): Promise<Wallet>;
  find(id: string, organizationId: string | null): Promise<Wallet | null>;
  findByOwner(input: {
    organizationId: string | null;
    ownerId: string;
    currency: string;
  }): Promise<Wallet | null>;
  update(id: string, patch: Partial<Wallet>): Promise<Wallet | null>;
  list(input: {
    organizationId: string | null;
    ownerId?: string;
    currency?: string;
    limit?: number;
  }): Promise<Wallet[]>;
}

export interface HoldStore {
  create(hold: Hold): Promise<Hold>;
  find(id: string, organizationId: string | null): Promise<Hold | null>;
  update(id: string, patch: Partial<Hold>): Promise<Hold | null>;
  /** Active holds for a wallet. What `held` is computed from. */
  active(walletId: string, organizationId: string | null): Promise<Hold[]>;
  /** Expired but unreleased holds, for the sweeper. */
  expired(organizationId: string | null, at: Date, limit?: number): Promise<Hold[]>;
  list(input: { walletId: string; organizationId: string | null; limit?: number }): Promise<Hold[]>;
}

export interface WalletServiceOptions {
  wallets: WalletStore;
  holds: HoldStore;
  ledger: Ledger;
  accounts: AccountService;
  limits?: LimitEngine;
  currencies?: CurrencyRegistry;
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  /** Default hold lifetime. Seven days, which is longer than any authorization should live. */
  defaultHoldMs?: number;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class WalletService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly defaultHoldMs: number;

  constructor(private readonly options: WalletServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID().replace(/-/g, '')}`);
    this.defaultHoldMs = options.defaultHoldMs ?? 7 * 86_400_000;
  }

  /**
   * Opens a wallet, and the account behind it.
   *
   * One call, because a wallet without its account is a wallet whose balance query fails — and
   * the two-call version is two calls that somebody eventually does out of order.
   */
  async open(input: {
    organizationId: string | null;
    ownerId: string;
    currency: string;
    ownerType?: string;
    name?: string;
    limitKeys?: string[];
    metadata?: Wallet['metadata'];
    actorId?: string | null;
  }): Promise<Wallet> {
    const existing = await this.options.wallets.findByOwner({
      organizationId: input.organizationId,
      ownerId: input.ownerId,
      currency: input.currency,
    });

    if (existing) {
      /*
       * A second wallet for the same owner and currency.
       *
       * Refused, because "the customer's USD balance" then has two answers, and application code
       * picks whichever it finds first. A customer who genuinely needs two USD wallets has two
       * owners as far as this is concerned — a sub-account with its own id.
       */
      throw ApiError.conflict(
        `${input.ownerId} already has a ${input.currency} wallet (${existing.id}). Two wallets in ` +
          'one currency for one owner makes "the balance" ambiguous.',
        { reason: 'wallet_exists', walletId: existing.id },
      );
    }

    const now = this.now();

    // A customer wallet is a liability: money the business owes. See @trustsystem/accounts.
    const account = await this.options.accounts.open({
      organizationId: input.organizationId,
      code: `customer.${input.ownerId}.${input.currency}`.toLowerCase(),
      name: input.name || `${input.ownerId} — ${input.currency}`,
      type: 'customer',
      currency: input.currency,
      ownerId: input.ownerId,
      ownerType: input.ownerType ?? 'user',
      actorId: input.actorId,
    });

    const wallet = walletSchema.parse({
      id: this.newId('wlt'),
      organizationId: input.organizationId,
      ownerId: input.ownerId,
      ownerType: input.ownerType ?? 'user',
      name: input.name ?? '',
      currency: input.currency,
      accountId: account.id,
      status: 'active',
      limitKeys: input.limitKeys ?? [],
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    });

    const created = await this.options.wallets.create(wallet);

    await this.options.audit?.record({
      action: 'wallet.opened',
      entityType: 'Wallet',
      entityId: created.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      after: { ownerId: created.ownerId, currency: created.currency, accountId: created.accountId },
    });

    return created;
  }

  async get(id: string, organizationId: string | null): Promise<Wallet> {
    const wallet = await this.options.wallets.find(id, organizationId);
    if (!wallet) throw ApiError.notFound(`No wallet with id "${id}".`);
    return wallet;
  }

  /**
   * The four balances.
   *
   * Computed from the ledger and the active holds, every time. See the header of `wallet.ts` for
   * why there is no cached column, and why `held` and `reserved` are counted separately.
   */
  async balance(
    walletId: string,
    organizationId: string | null,
    asOf?: Date,
  ): Promise<WalletBalance> {
    const wallet = await this.get(walletId, organizationId);
    const account = await this.options.accounts.get(wallet.accountId, organizationId);

    const total = await this.options.accounts.balance(account, asOf);
    const active = await this.options.holds.active(walletId, organizationId);

    const holds = active.filter((entry) => entry.kind === 'hold');
    const reserves = active.filter((entry) => entry.kind === 'reserve');

    const sum = (entries: Hold[]) =>
      entries.reduce<Money>(
        (running, hold) => addMoney(running, this.remainingOf(hold)),
        zeroMoney(wallet.currency, this.options.currencies),
      );

    const held = sum(holds);
    const reserved = sum(reserves);

    return {
      walletId,
      currency: wallet.currency,
      total,
      held,
      reserved,
      // Both come off. A reserve that did not reduce availability would be a number on a screen.
      available: subtractMoney(subtractMoney(total, held), reserved),
      holdCount: holds.length,
      reserveCount: reserves.length,
      asOf: asOf ?? this.now(),
    };
  }

  /**
   * Credits a wallet: money arrives.
   *
   * Takes the counter-account explicitly. There is no default, because the other side of a deposit
   * is a real decision — a bank account, a provider float, a suspense account — and a default
   * would be one of them chosen for everybody.
   */
  async credit(input: {
    walletId: string;
    organizationId: string | null;
    amount: Money;
    fromAccountId: string;
    description: string;
    reference?: string | null;
    idempotencyKey?: string | null;
    actorId?: string | null;
    metadata?: Journal['metadata'];
  }): Promise<{ wallet: Wallet; journal: Journal; balance: WalletBalance }> {
    const wallet = await this.assertMovable(
      input.walletId,
      input.organizationId,
      'in',
      input.amount,
    );

    const journal = await this.options.ledger.post({
      organizationId: input.organizationId,
      description: input.description,
      reference: input.reference ?? null,
      entries: [
        debit(input.fromAccountId, input.amount, { description: input.description }),
        credit(wallet.accountId, input.amount, { description: input.description }),
      ],
      actorId: input.actorId,
      metadata: { ...input.metadata, walletId: wallet.id },
      idempotencyKey: input.idempotencyKey ?? null,
    });

    await this.audit('wallet.credited', wallet, input, journal);

    return {
      wallet,
      journal,
      balance: await this.balance(wallet.id, input.organizationId),
    };
  }

  /**
   * Debits a wallet: money leaves.
   *
   * Checks the **available** balance, not the total, and consumes any limits that apply. Both
   * checks happen before the posting, and the posting is what makes it real.
   */
  async debit(input: {
    walletId: string;
    organizationId: string | null;
    amount: Money;
    toAccountId: string;
    description: string;
    reference?: string | null;
    idempotencyKey?: string | null;
    actorId?: string | null;
    metadata?: Journal['metadata'];
    /** Set when this debit captures a hold, so the hold is not double-counted. */
    holdId?: string | null;
  }): Promise<{ wallet: Wallet; journal: Journal; balance: WalletBalance }> {
    const wallet = await this.assertMovable(
      input.walletId,
      input.organizationId,
      'out',
      input.amount,
    );

    const balance = await this.balance(wallet.id, input.organizationId);

    // A capture spends money that is already held, so the hold's own amount does not count
    // against availability a second time.
    const effective = input.holdId
      ? await this.availableIncludingHold(balance, input.holdId, input.organizationId)
      : balance;

    assertSufficient(effective, input.amount);

    if (this.options.limits && wallet.limitKeys.length > 0) {
      await this.options.limits.consume({
        organizationId: input.organizationId,
        scope: 'wallet',
        subjectId: wallet.id,
        amount: input.amount,
        idempotencyKey: input.idempotencyKey ?? null,
      });
    }

    const journal = await this.options.ledger.post({
      organizationId: input.organizationId,
      description: input.description,
      reference: input.reference ?? null,
      entries: [
        debit(wallet.accountId, input.amount, { description: input.description }),
        credit(input.toAccountId, input.amount, { description: input.description }),
      ],
      actorId: input.actorId,
      metadata: { ...input.metadata, walletId: wallet.id },
      idempotencyKey: input.idempotencyKey ?? null,
    });

    await this.audit('wallet.debited', wallet, input, journal);

    return {
      wallet,
      journal,
      balance: await this.balance(wallet.id, input.organizationId),
    };
  }

  /**
   * Places a hold.
   *
   * Moves nothing. The money stays in the wallet and stops being available, which is what an
   * authorization is: a promise that this much will be there when the capture arrives.
   */
  async hold(input: {
    walletId: string;
    organizationId: string | null;
    amount: Money;
    reason: string;
    reference?: string | null;
    expiresAt?: Date;
    actorId?: string | null;
  }): Promise<{ hold: Hold; balance: WalletBalance }> {
    const wallet = await this.assertMovable(
      input.walletId,
      input.organizationId,
      'out',
      input.amount,
    );

    if (!isPositiveMoney(input.amount)) {
      throw ApiError.validation(
        [{ path: 'amount', message: 'A hold must be for a positive amount.' }],
        'Invalid hold amount.',
      );
    }

    const balance = await this.balance(wallet.id, input.organizationId);
    assertSufficient(balance, input.amount);

    const now = this.now();

    const hold = holdSchema.parse({
      id: this.newId('hld'),
      organizationId: input.organizationId,
      walletId: wallet.id,
      amount: moneyToJson(input.amount),
      kind: 'hold',
      status: 'active',
      reason: input.reason,
      reference: input.reference ?? null,
      expiresAt: input.expiresAt ?? new Date(now.getTime() + this.defaultHoldMs),
      createdAt: now,
      createdById: input.actorId ?? null,
    });

    const created = await this.options.holds.create(hold);

    await this.options.audit?.record({
      action: 'wallet.hold.placed',
      entityType: 'WalletHold',
      entityId: created.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      after: {
        walletId: wallet.id,
        amount: formatMoney(input.amount),
        reason: input.reason,
        reference: created.reference,
        expiresAt: created.expiresAt?.toISOString() ?? null,
      },
    });

    return { hold: created, balance: await this.balance(wallet.id, input.organizationId) };
  }

  /**
   * Places a standing reserve.
   *
   * Like a hold in that it reduces the available balance and moves nothing, and unlike one in
   * every other respect: it has no expiry, the sweeper never touches it, and it ends when
   * somebody decides it should. A rolling reserve against chargebacks, a regulatory minimum, a
   * security deposit.
   *
   * Separate from `hold` rather than a flag on it, because the two are asked for by different
   * people for different reasons — and a `hold({ expires: false })` is exactly the call that
   * creates the immortal authorization this package refuses.
   */
  async reserve(input: {
    walletId: string;
    organizationId: string | null;
    amount: Money;
    reason: string;
    reference?: string | null;
    actorId?: string | null;
  }): Promise<{ reserve: Hold; balance: WalletBalance }> {
    const wallet = await this.assertMovable(
      input.walletId,
      input.organizationId,
      'out',
      input.amount,
    );

    const balance = await this.balance(wallet.id, input.organizationId);
    assertSufficient(balance, input.amount);

    const now = this.now();

    const reserve = holdSchema.parse({
      id: this.newId('hld'),
      organizationId: input.organizationId,
      walletId: wallet.id,
      amount: moneyToJson(input.amount),
      kind: 'reserve',
      status: 'active',
      reason: input.reason,
      reference: input.reference ?? null,
      // Null, and the schema refuses anything else for a reserve.
      expiresAt: null,
      createdAt: now,
      createdById: input.actorId ?? null,
    });

    const created = await this.options.holds.create(reserve);

    await this.options.audit?.record({
      action: 'wallet.reserve.placed',
      entityType: 'WalletHold',
      entityId: created.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      after: {
        walletId: wallet.id,
        amount: formatMoney(input.amount),
        reason: input.reason,
        reference: created.reference,
      },
    });

    return { reserve: created, balance: await this.balance(wallet.id, input.organizationId) };
  }

  /**
   * Releases a standing reserve.
   *
   * A separate method from `release` so the audit action differs, and so releasing a reserve is a
   * deliberate act rather than something a generic "release everything on this wallet" loop does
   * by accident.
   */
  async releaseReserve(input: {
    reserveId: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
  }): Promise<Hold> {
    const reserve = await this.requireHold(input.reserveId, input.organizationId);

    if (reserve.kind !== 'reserve') {
      throw ApiError.validation(
        [
          {
            path: 'reserveId',
            message:
              `${reserve.id} is a hold, not a reserve. Use release() — a hold ends with its ` +
              'operation, and treating the two the same is how a sweeper releases a chargeback ' +
              'reserve.',
          },
        ],
        'Not a reserve.',
      );
    }

    if (reserve.status !== 'active') {
      throw ApiError.conflict(`This reserve is already ${reserve.status}.`, {
        reason: 'reserve_not_active',
        reserveId: reserve.id,
      });
    }

    if (!input.reason.trim()) {
      throw ApiError.validation(
        [
          {
            path: 'reason',
            message:
              'Releasing a reserve needs a reason. A reserve exists because somebody decided it ' +
              'should, and removing it without a record leaves the next person unable to tell ' +
              'whether the risk it covered is gone.',
          },
        ],
        'Releasing a reserve needs a reason.',
      );
    }

    const updated = await this.options.holds.update(reserve.id, {
      status: 'released',
      resolvedAt: this.now(),
      resolvedReason: input.reason,
    });

    if (!updated) throw ApiError.notFound(`No reserve with id "${input.reserveId}".`);

    await this.options.audit?.record({
      action: 'wallet.reserve.released',
      entityType: 'WalletHold',
      entityId: reserve.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      before: { status: 'active' },
      after: { status: 'released', reason: input.reason },
    });

    return updated;
  }

  /**
   * Releases a hold without moving money.
   *
   * For an authorization that was cancelled, expired, or is being replaced. The money becomes
   * available again and nothing was posted, because nothing happened.
   */
  async release(input: {
    holdId: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
    expired?: boolean;
  }): Promise<Hold> {
    const hold = await this.requireHold(input.holdId, input.organizationId);

    if (hold.kind === 'reserve') {
      /*
       * A reserve released through the hold path.
       *
       * Refused, because this is the method a sweeper and a cancellation handler call — and a
       * generic release loop that quietly dissolved a chargeback reserve is exactly the failure
       * the two kinds exist to prevent.
       */
      throw ApiError.validation(
        [
          {
            path: 'holdId',
            message:
              `${hold.id} is a reserve, not a hold. Use releaseReserve() — releasing a standing ` +
              'reserve is a deliberate decision, not something a cancellation handler does.',
          },
        ],
        'Not a hold.',
      );
    }

    if (hold.status !== 'active') {
      throw ApiError.conflict(
        `This hold is already ${hold.status}. Releasing it again would give back money that is ` +
          'no longer held.',
        { reason: 'hold_not_active', holdId: hold.id, status: hold.status },
      );
    }

    const updated = await this.options.holds.update(hold.id, {
      status: input.expired ? 'expired' : 'released',
      resolvedAt: this.now(),
      resolvedReason: input.reason,
    });

    if (!updated) throw ApiError.notFound(`No hold with id "${input.holdId}".`);

    await this.options.audit?.record({
      action: 'wallet.hold.released',
      entityType: 'WalletHold',
      entityId: hold.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      before: { status: 'active' },
      after: { status: updated.status, reason: input.reason },
    });

    return updated;
  }

  /**
   * Captures a hold: the money finally moves.
   *
   * A partial capture leaves the remainder held rather than releasing it, because the common case
   * — an authorization for an estimate, captured for the final amount — usually has a second
   * capture coming. `release` gives the rest back when it does not.
   */
  async capture(input: {
    holdId: string;
    organizationId: string | null;
    amount?: Money;
    toAccountId: string;
    description: string;
    reference?: string | null;
    idempotencyKey?: string | null;
    actorId?: string | null;
  }): Promise<{ hold: Hold; journal: Journal; balance: WalletBalance }> {
    const hold = await this.requireHold(input.holdId, input.organizationId);

    if (hold.kind === 'reserve') {
      throw ApiError.validation(
        [
          {
            path: 'holdId',
            message:
              `${hold.id} is a reserve. A reserve covers a future obligation and is not a claim ` +
              'on the money — capturing one would spend a floor that exists to stay there.',
          },
        ],
        'Cannot capture a reserve.',
      );
    }

    if (hold.status !== 'active') {
      throw ApiError.conflict(
        `This hold is ${hold.status} and cannot be captured. Capturing a released hold would move ` +
          'money that was already given back.',
        { reason: 'hold_not_active', holdId: hold.id, status: hold.status },
      );
    }

    const remaining = this.remainingOf(hold);
    const amount = input.amount ?? remaining;

    if (compareMoney(amount, remaining) > 0) {
      throw ApiError.validation(
        [
          {
            path: 'amount',
            message:
              `Cannot capture ${formatMoney(amount)} against a hold with ${formatMoney(remaining)} ` +
              'remaining. Capturing more than was authorized is a second transaction, not a ' +
              'capture.',
          },
        ],
        'Capture exceeds the hold.',
      );
    }

    const result = await this.debit({
      walletId: hold.walletId,
      organizationId: input.organizationId,
      amount,
      toAccountId: input.toAccountId,
      description: input.description,
      reference: input.reference ?? hold.reference,
      idempotencyKey: input.idempotencyKey ?? `capture:${hold.id}`,
      actorId: input.actorId,
      metadata: { holdId: hold.id },
      holdId: hold.id,
    });

    const capturedSoFar = addMoney(
      hold.capturedAmount
        ? moneyFromJson(hold.capturedAmount, this.options.currencies)
        : zeroMoney(amount.currency, this.options.currencies),
      amount,
    );

    const fullyCaptured =
      compareMoney(capturedSoFar, moneyFromJson(hold.amount, this.options.currencies)) >= 0;

    const updated = await this.options.holds.update(hold.id, {
      capturedAmount: moneyToJson(capturedSoFar),
      ...(fullyCaptured
        ? {
            status: 'captured' as const,
            resolvedAt: this.now(),
            resolvedReason: 'Captured in full.',
          }
        : {}),
    });

    await this.options.audit?.record({
      action: 'wallet.hold.captured',
      entityType: 'WalletHold',
      entityId: hold.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      after: {
        amount: formatMoney(amount),
        journalId: result.journal.id,
        fullyCaptured,
      },
    });

    return {
      hold: updated ?? hold,
      journal: result.journal,
      balance: await this.balance(hold.walletId, input.organizationId),
    };
  }

  /**
   * Releases holds that have expired.
   *
   * Run on a schedule. Without it, a hold against a process that died is money the customer cannot
   * spend and nobody is coming back for — and every support conversation about it ends in a manual
   * fix.
   */
  async sweepExpiredHolds(input: {
    organizationId: string | null;
    limit?: number;
  }): Promise<{ released: number; holdIds: string[] }> {
    const now = this.now();
    const expired = await this.options.holds.expired(input.organizationId, now, input.limit ?? 100);
    const holdIds: string[] = [];

    for (const hold of expired) {
      if (!isExpired(hold, now)) continue;

      await this.release({
        holdId: hold.id,
        organizationId: input.organizationId,
        reason: `Expired at ${hold.expiresAt?.toISOString() ?? 'an unknown time'} without being captured.`,
        expired: true,
      });

      holdIds.push(hold.id);
    }

    if (holdIds.length > 0) {
      this.options.logger?.info(
        { organizationId: input.organizationId, released: holdIds.length },
        'released expired wallet holds',
      );
    }

    return { released: holdIds.length, holdIds };
  }

  /** Freezes a wallet, and the account behind it, so the two cannot disagree. */
  async freeze(input: {
    walletId: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
  }): Promise<Wallet> {
    const wallet = await this.get(input.walletId, input.organizationId);

    await this.options.accounts.freeze({
      id: wallet.accountId,
      organizationId: input.organizationId,
      reason: input.reason,
      actorId: input.actorId,
    });

    const updated = await this.options.wallets.update(wallet.id, {
      status: 'frozen',
      frozenAt: this.now(),
      frozenReason: input.reason,
      updatedAt: this.now(),
    });

    if (!updated) throw ApiError.notFound(`No wallet with id "${input.walletId}".`);

    await this.options.audit?.record({
      action: 'wallet.frozen',
      entityType: 'Wallet',
      entityId: wallet.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      before: { status: wallet.status },
      after: { status: 'frozen', reason: input.reason },
    });

    return updated;
  }

  async unfreeze(input: {
    walletId: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
  }): Promise<Wallet> {
    const wallet = await this.get(input.walletId, input.organizationId);

    await this.options.accounts.unfreeze({
      id: wallet.accountId,
      organizationId: input.organizationId,
      reason: input.reason,
      actorId: input.actorId,
    });

    const updated = await this.options.wallets.update(wallet.id, {
      status: 'active',
      frozenAt: null,
      frozenReason: null,
      updatedAt: this.now(),
    });

    if (!updated) throw ApiError.notFound(`No wallet with id "${input.walletId}".`);

    await this.options.audit?.record({
      action: 'wallet.unfrozen',
      entityType: 'Wallet',
      entityId: wallet.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      before: { status: wallet.status },
      after: { status: 'active', reason: input.reason },
    });

    return updated;
  }

  /** Every journal that touched this wallet's account. The statement. */
  async history(input: {
    walletId: string;
    organizationId: string | null;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<Journal[]> {
    const wallet = await this.get(input.walletId, input.organizationId);

    return this.options.ledger.list({
      organizationId: input.organizationId,
      accountId: wallet.accountId,
      from: input.from,
      to: input.to,
      limit: input.limit,
    });
  }

  async holds(walletId: string, organizationId: string | null, limit?: number): Promise<Hold[]> {
    return this.options.holds.list({ walletId, organizationId, limit });
  }

  /** Standing reserves on a wallet, and why each one is there. */
  async reserves(walletId: string, organizationId: string | null): Promise<Hold[]> {
    const active = await this.options.holds.active(walletId, organizationId);
    return active.filter((hold) => hold.kind === 'reserve');
  }

  /** How much of a hold is still held: the amount less anything already captured. */
  private remainingOf(hold: Hold): Money {
    const total = moneyFromJson(hold.amount, this.options.currencies);

    if (!hold.capturedAmount) return total;

    return subtractMoney(total, moneyFromJson(hold.capturedAmount, this.options.currencies));
  }

  /**
   * The available balance a capture sees.
   *
   * The hold being captured is added back, because the money it holds is the money about to move
   * — counting it against availability would make every capture fail on a wallet whose whole
   * balance is held, which is the normal case for an authorization.
   */
  private async availableIncludingHold(
    balance: WalletBalance,
    holdId: string,
    organizationId: string | null,
  ): Promise<WalletBalance> {
    const hold = await this.options.holds.find(holdId, organizationId);
    if (!hold || hold.status !== 'active') return balance;

    const remaining = this.remainingOf(hold);

    return {
      ...balance,
      held: subtractMoney(balance.held, remaining),
      available: addMoney(balance.available, remaining),
    };
  }

  private async assertMovable(
    walletId: string,
    organizationId: string | null,
    direction: 'in' | 'out',
    amount: Money,
  ): Promise<Wallet> {
    const wallet = await this.get(walletId, organizationId);

    if (wallet.currency !== amount.currency) {
      throw ApiError.validation(
        [
          {
            path: 'amount',
            message:
              `This wallet holds ${wallet.currency} and the amount is ${amount.currency}. Convert ` +
              'first and record the rate — see @trustsystem/fx.',
          },
        ],
        'Currency mismatch with the wallet.',
      );
    }

    if (!isPositiveMoney(amount)) {
      /*
       * A zero or negative movement.
       *
       * A negative credit is a debit written backwards, and it bypasses the available-balance
       * check on the way through. Refused at the door.
       */
      throw ApiError.validation(
        [
          {
            path: 'amount',
            message:
              `${formatMoney(amount)} is not a movement. A negative credit is a debit written ` +
              'backwards, and it would skip the available-balance check.',
          },
        ],
        'Invalid amount.',
      );
    }

    const decision = canMove(wallet, direction);

    if (!decision.allowed) {
      throw ApiError.forbidden(decision.reason, {
        reason: 'wallet_not_movable',
        walletId,
        status: wallet.status,
      });
    }

    return wallet;
  }

  private async requireHold(id: string, organizationId: string | null): Promise<Hold> {
    const hold = await this.options.holds.find(id, organizationId);
    if (!hold) throw ApiError.notFound(`No hold with id "${id}".`);
    return hold;
  }

  private async audit(
    action: string,
    wallet: Wallet,
    input: {
      amount: Money;
      description: string;
      reference?: string | null;
      actorId?: string | null;
    },
    journal: Journal,
  ): Promise<void> {
    await this.options.audit?.record({
      action,
      entityType: 'Wallet',
      entityId: wallet.id,
      actorId: input.actorId ?? null,
      organizationId: wallet.organizationId,
      after: {
        amount: formatMoney(input.amount),
        description: input.description,
        reference: input.reference ?? null,
        journalId: journal.id,
      },
    });
  }
}
