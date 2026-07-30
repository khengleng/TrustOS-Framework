import type { Hold, Wallet } from './wallet';
import type { HoldStore, WalletStore } from './service';

/** In-memory wallet and hold stores, for tests and development. */
export class InMemoryWalletStore implements WalletStore {
  readonly wallets = new Map<string, Wallet>();

  async create(wallet: Wallet): Promise<Wallet> {
    this.wallets.set(wallet.id, wallet);
    return wallet;
  }

  async find(id: string, organizationId: string | null): Promise<Wallet | null> {
    const wallet = this.wallets.get(id);
    if (!wallet || wallet.organizationId !== organizationId) return null;
    return wallet;
  }

  async findByOwner(input: {
    organizationId: string | null;
    ownerId: string;
    currency: string;
  }): Promise<Wallet | null> {
    return (
      [...this.wallets.values()].find(
        (wallet) =>
          wallet.organizationId === input.organizationId &&
          wallet.ownerId === input.ownerId &&
          wallet.currency === input.currency,
      ) ?? null
    );
  }

  async update(id: string, patch: Partial<Wallet>): Promise<Wallet | null> {
    const wallet = this.wallets.get(id);
    if (!wallet) return null;

    const updated = { ...wallet, ...patch };
    this.wallets.set(id, updated);
    return updated;
  }

  async list(input: {
    organizationId: string | null;
    ownerId?: string;
    currency?: string;
    limit?: number;
  }): Promise<Wallet[]> {
    return [...this.wallets.values()]
      .filter((wallet) => wallet.organizationId === input.organizationId)
      .filter((wallet) => !input.ownerId || wallet.ownerId === input.ownerId)
      .filter((wallet) => !input.currency || wallet.currency === input.currency)
      .slice(0, input.limit ?? 200);
  }
}

export class InMemoryHoldStore implements HoldStore {
  readonly holds = new Map<string, Hold>();

  async create(hold: Hold): Promise<Hold> {
    this.holds.set(hold.id, hold);
    return hold;
  }

  async find(id: string, organizationId: string | null): Promise<Hold | null> {
    const hold = this.holds.get(id);
    if (!hold || hold.organizationId !== organizationId) return null;
    return hold;
  }

  async update(id: string, patch: Partial<Hold>): Promise<Hold | null> {
    const hold = this.holds.get(id);
    if (!hold) return null;

    const updated = { ...hold, ...patch };
    this.holds.set(id, updated);
    return updated;
  }

  async active(walletId: string, organizationId: string | null): Promise<Hold[]> {
    return [...this.holds.values()]
      .filter((hold) => hold.walletId === walletId && hold.organizationId === organizationId)
      .filter((hold) => hold.status === 'active');
  }

  async expired(organizationId: string | null, at: Date, limit = 100): Promise<Hold[]> {
    return [...this.holds.values()]
      .filter((hold) => hold.organizationId === organizationId)
      .filter((hold) => hold.status === 'active' && hold.expiresAt <= at)
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
      .slice(0, limit);
  }

  async list(input: {
    walletId: string;
    organizationId: string | null;
    limit?: number;
  }): Promise<Hold[]> {
    return [...this.holds.values()]
      .filter(
        (hold) => hold.walletId === input.walletId && hold.organizationId === input.organizationId,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, input.limit ?? 200);
  }
}
