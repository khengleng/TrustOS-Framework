import type { Account, AccountStatus, AccountType } from './account';
import type { AccountStore } from './service';

/** An in-memory account store, for tests and development. */
export class InMemoryAccountStore implements AccountStore {
  readonly accounts = new Map<string, Account>();

  async create(account: Account): Promise<Account> {
    this.accounts.set(account.id, account);
    return account;
  }

  async find(id: string, organizationId: string | null): Promise<Account | null> {
    const account = this.accounts.get(id);
    if (!account || account.organizationId !== organizationId) return null;
    return account;
  }

  async findByCode(code: string, organizationId: string | null): Promise<Account | null> {
    return (
      [...this.accounts.values()].find(
        (account) => account.code === code && account.organizationId === organizationId,
      ) ?? null
    );
  }

  async update(id: string, patch: Partial<Account>): Promise<Account | null> {
    const account = this.accounts.get(id);
    if (!account) return null;

    const updated = { ...account, ...patch } as Account;
    this.accounts.set(id, updated);
    return updated;
  }

  async list(input: {
    organizationId: string | null;
    type?: AccountType;
    ownerId?: string;
    currency?: string;
    status?: AccountStatus;
    limit?: number;
  }): Promise<Account[]> {
    return [...this.accounts.values()]
      .filter((account) => account.organizationId === input.organizationId)
      .filter((account) => !input.type || account.type === input.type)
      .filter((account) => !input.ownerId || account.ownerId === input.ownerId)
      .filter((account) => !input.currency || account.currency === input.currency)
      .filter((account) => !input.status || account.status === input.status)
      .sort((a, b) => a.code.localeCompare(b.code))
      .slice(0, input.limit ?? 500);
  }
}
