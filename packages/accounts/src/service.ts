import { randomUUID } from 'node:crypto';
import { ApiError } from '@trustos/errors';
import type { AuditService } from '@trustos/audit';
import type { LoggerPort } from '@trustos/logging';
import { money, zeroMoney, type CurrencyRegistry, type Money } from '@trustos/financial-core';
import type { Ledger } from '@trustos/ledger';
import {
  accountSchema,
  canPost,
  classFor,
  normalBalance,
  type Account,
  type AccountStatus,
  type AccountType,
} from './account';

/**
 * The account service.
 *
 * Opening, closing, freezing and reading balances. Everything that *moves* money is the ledger's
 * job — this package owns what an account is and what its balance means, and deliberately owns no
 * posting path of its own. Two ways to move money is two sets of rules about balancing.
 */

export interface AccountStore {
  create(account: Account): Promise<Account>;
  find(id: string, organizationId: string | null): Promise<Account | null>;
  findByCode(code: string, organizationId: string | null): Promise<Account | null>;
  update(id: string, patch: Partial<Account>): Promise<Account | null>;
  list(input: {
    organizationId: string | null;
    type?: AccountType;
    ownerId?: string;
    currency?: string;
    status?: AccountStatus;
    limit?: number;
  }): Promise<Account[]>;
}

export interface AccountServiceOptions {
  store: AccountStore;
  ledger: Pick<Ledger, 'balances'>;
  currencies?: CurrencyRegistry;
  audit?: Pick<AuditService, 'record'>;
  logger?: LoggerPort;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class AccountService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: AccountServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID().replace(/-/g, '')}`);
  }

  /**
   * Opens an account.
   *
   * The class is derived from the type unless the type is `general`, so a caller cannot declare a
   * customer account an asset — see the header of `account.ts` for why that one mistake is worth
   * a schema rule.
   */
  async open(input: {
    organizationId: string | null;
    code: string;
    name: string;
    type: AccountType;
    currency: string;
    class?: Account['class'];
    ownerId?: string | null;
    ownerType?: string | null;
    ledgerId?: string;
    parentAccountId?: string | null;
    allowNegative?: boolean;
    overdraftLimit?: string | null;
    metadata?: Account['metadata'];
    actorId?: string | null;
  }): Promise<Account> {
    // Validates the currency exists before anything is written. An account in a currency nobody
    // configured produces a balance nothing can report on.
    this.options.currencies?.get(input.currency);

    const existing = await this.options.store.findByCode(input.code, input.organizationId);

    if (existing) {
      /*
       * Two accounts with one code.
       *
       * Refused, because the code is what application code looks accounts up by — and two rows
       * answering to one code makes which balance you get a function of row order.
       */
      throw ApiError.conflict(
        `An account with the code "${input.code}" already exists in this organization. Codes are ` +
          'how application code finds an account, so two rows answering to one code makes which ' +
          'balance you get a function of row order.',
        { reason: 'account_code_conflict', code: input.code, accountId: existing.id },
      );
    }

    const now = this.now();

    const account = accountSchema.parse({
      id: this.newId('acc'),
      organizationId: input.organizationId,
      code: input.code,
      name: input.name,
      type: input.type,
      class: input.class ?? classFor(input.type),
      currency: input.currency,
      status: 'active',
      ownerId: input.ownerId ?? null,
      ownerType: input.ownerType ?? null,
      ledgerId: input.ledgerId ?? 'default',
      parentAccountId: input.parentAccountId ?? null,
      allowNegative: input.allowNegative ?? false,
      overdraftLimit: input.overdraftLimit ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    });

    const created = await this.options.store.create(account);

    await this.options.audit?.record({
      action: 'ledger.account.opened',
      entityType: 'Account',
      entityId: created.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      after: {
        code: created.code,
        type: created.type,
        class: created.class,
        currency: created.currency,
        ownerId: created.ownerId,
        allowNegative: created.allowNegative,
      },
    });

    return created;
  }

  /** Finds an account by id, refusing another tenant's. */
  async get(id: string, organizationId: string | null): Promise<Account> {
    const account = await this.options.store.find(id, organizationId);
    if (!account) throw ApiError.notFound(`No account with id "${id}".`);
    return account;
  }

  /** Finds by code, which is how application code usually looks one up. */
  async getByCode(code: string, organizationId: string | null): Promise<Account> {
    const account = await this.options.store.findByCode(code, organizationId);
    if (!account) throw ApiError.notFound(`No account with code "${code}".`);
    return account;
  }

  async list(input: Parameters<AccountStore['list']>[0]): Promise<Account[]> {
    return this.options.store.list(input);
  }

  /**
   * Freezes an account: money may leave, nothing new may arrive.
   *
   * Distinct from blocking. A frozen customer can still be paid out and can still have a
   * settlement completed against them; a blocked one cannot, and their money is stuck until
   * somebody decides. Both are legitimate; conflating them means every freeze is the harsher one.
   */
  async freeze(input: {
    id: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
  }): Promise<Account> {
    return this.setStatus({ ...input, status: 'frozen', action: 'ledger.account.frozen' });
  }

  async unfreeze(input: {
    id: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
  }): Promise<Account> {
    return this.setStatus({ ...input, status: 'active', action: 'ledger.account.unfrozen' });
  }

  /** Blocks an account: nothing posts in either direction. */
  async block(input: {
    id: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
  }): Promise<Account> {
    return this.setStatus({ ...input, status: 'blocked', action: 'ledger.account.blocked' });
  }

  /**
   * Closes an account.
   *
   * Refused unless the balance is zero. A closed account with a balance is money the business
   * still owes, in a record nobody looks at — and the customer who comes back for it finds an
   * account that says closed.
   */
  async close(input: {
    id: string;
    organizationId: string | null;
    reason: string;
    actorId?: string | null;
  }): Promise<Account> {
    const account = await this.get(input.id, input.organizationId);
    const balance = await this.balance(account);

    if (balance.amount.units !== 0n) {
      throw ApiError.conflict(
        `Account ${account.code} cannot be closed while it holds ${balance.amount.units < 0n ? '' : ''}` +
          `${balance.amount.units}. Move the balance out first — a closed account with money in it ` +
          'is an obligation in a record nobody looks at.',
        { reason: 'account_not_empty', accountId: account.id },
      );
    }

    const updated = await this.options.store.update(input.id, {
      status: 'closed',
      closedAt: this.now(),
      updatedAt: this.now(),
    });

    if (!updated) throw ApiError.notFound(`No account with id "${input.id}".`);

    await this.options.audit?.record({
      action: 'ledger.account.closed',
      entityType: 'Account',
      entityId: account.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      before: { status: account.status },
      after: { status: 'closed', reason: input.reason },
    });

    return updated;
  }

  /**
   * The balance, in the account's own terms.
   *
   * Positive means "there is this much in it", whatever the account class — see `normalBalance`.
   * A caller comparing a customer balance against a payment amount should never have to know that
   * a liability's raw ledger balance is negative.
   */
  async balance(account: Account, asOf?: Date): Promise<Money> {
    const balances = await this.options.ledger.balances({
      organizationId: account.organizationId,
      ledgerId: account.ledgerId,
      accountIds: [account.id],
      asOf,
    });

    const found = balances.find((entry) => entry.currency === account.currency);

    return found
      ? normalBalance(account, found.balance)
      : zeroMoney(account.currency, this.options.currencies);
  }

  /** Balances for several accounts at once. One query, because N+1 on a statement is noticeable. */
  async balances(accounts: Account[], asOf?: Date): Promise<Map<string, Money>> {
    if (accounts.length === 0) return new Map();

    const organizationId = accounts[0]!.organizationId;

    if (accounts.some((account) => account.organizationId !== organizationId)) {
      // A mixed-tenant batch would produce one query scoped to the first tenant and silently
      // return zero for the rest.
      throw ApiError.validation(
        [
          {
            path: 'accounts',
            message: 'Every account in one balance query must be in one tenant.',
          },
        ],
        'Mixed tenants in a balance query.',
      );
    }

    const raw = await this.options.ledger.balances({
      organizationId,
      accountIds: accounts.map((account) => account.id),
      asOf,
    });

    return new Map(
      accounts.map((account) => {
        const found = raw.find(
          (entry) => entry.accountId === account.id && entry.currency === account.currency,
        );

        return [
          account.id,
          found
            ? normalBalance(account, found.balance)
            : zeroMoney(account.currency, this.options.currencies),
        ];
      }),
    );
  }

  /**
   * Refuses a posting to an account that is not accepting one.
   *
   * Called by whatever is about to post. It is a check rather than an enforcement point, because
   * enforcement belongs at the ledger — but the ledger does not know about account status, and
   * teaching it would make it depend on this package.
   */
  async assertCanPost(
    accountId: string,
    organizationId: string | null,
    direction: 'debit' | 'credit',
  ): Promise<Account> {
    const account = await this.get(accountId, organizationId);
    const decision = canPost(account, direction);

    if (!decision.allowed) {
      throw ApiError.forbidden(decision.reason, {
        reason: 'account_not_postable',
        accountId,
        status: account.status,
      });
    }

    return account;
  }

  /** Parses an overdraft limit in the account's currency. */
  limitOf(account: Account): Money | null {
    return account.overdraftLimit === null
      ? null
      : money(account.overdraftLimit, account.currency, this.options.currencies);
  }

  private async setStatus(input: {
    id: string;
    organizationId: string | null;
    status: AccountStatus;
    reason: string;
    action: string;
    actorId?: string | null;
  }): Promise<Account> {
    const account = await this.get(input.id, input.organizationId);

    if (account.status === 'closed') {
      throw ApiError.conflict(
        `Account ${account.code} is closed. Re-opening is a new account, not a status change.`,
        { reason: 'account_closed', accountId: account.id },
      );
    }

    if (!input.reason.trim()) {
      throw ApiError.validation(
        [
          {
            path: 'reason',
            message:
              'Changing an account status needs a reason. It is the only record of why somebody ' +
              'could not spend their own money, and a year later the timestamp alone does not say.',
          },
        ],
        'A status change needs a reason.',
      );
    }

    const updated = await this.options.store.update(input.id, {
      status: input.status,
      updatedAt: this.now(),
    });

    if (!updated) throw ApiError.notFound(`No account with id "${input.id}".`);

    await this.options.audit?.record({
      action: input.action,
      entityType: 'Account',
      entityId: account.id,
      actorId: input.actorId ?? null,
      organizationId: input.organizationId,
      before: { status: account.status },
      after: { status: input.status, reason: input.reason },
    });

    return updated;
  }
}
