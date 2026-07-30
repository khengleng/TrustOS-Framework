/**
 * Shared types — TrustOS Wallet.
 *
 * The shapes the API returns and the admin consumes. One definition, imported by both, so a
 * renamed field is a compile error rather than an empty column.
 *
 * Runtime-free by design: no imports, no side effects, nothing that could pull a server-only
 * module into a browser bundle. The admin application imports this package directly, so anything
 * reachable from here reaches the client.
 */

/** ISO-8601 timestamp as it crosses the API boundary. */
export type IsoDateTime = string;

/** Fields every tenant-owned entity exposes. */
export interface TenantOwnedSummary {
  id: string;
  organizationId: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** The product-side record of a wallet. `walletId` points at the framework wallet that owns the */
/** money; everything financial is read through @trustos/wallet. */
export interface WalletProfile {
  id: string;
  walletId: string;
  ownerName: string;
  ownerPhone: string | null;
  currency: string;
  tier: 'BASIC' | 'VERIFIED' | 'PREMIUM';
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A movement between two wallets. The journal is written by @trustos/ledger; this row is the */
/** product-level record of *why*, and `journalId` is the link between them. */
export interface WalletTransfer {
  id: string;
  reference: string;
  fromProfileId: string;
  toProfileId: string;
  amount: string;
  currency: string;
  journalId: string | null;
  status: 'PENDING' | 'POSTED' | 'FAILED' | 'REVERSED';
  note: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Which framework limit keys apply to a wallet tier. The ceilings themselves live in */
/** @trustos/limits — this maps tiers onto them so a tier change is one row, not a migration. */
export interface TransferLimitProfile {
  id: string;
  tier: 'BASIC' | 'VERIFIED' | 'PREMIUM';
  limitKey: string;
  description: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
