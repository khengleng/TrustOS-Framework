/**
 * Shared types — TrustOS Marketplace.
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

/** A third party selling through the marketplace. */
export interface Seller {
  id: string;
  merchantId: string;
  displayName: string;
  code: string;
  status: 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  commissionRate: string;
  payoutCurrency: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A seller offering a product variant at their own price. */
export interface Listing {
  id: string;
  sellerId: string;
  variantId: string;
  price: string;
  currency: string;
  stockOnHand: number;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** What is owed to a seller for a period. Recorded here and executed elsewhere — the framework */
/** has a settlement package for the execution, and this template does not assume which rail. */
export interface SellerPayout {
  id: string;
  sellerId: string;
  reference: string;
  periodStart: Date;
  periodEnd: Date;
  grossAmount: string;
  commissionAmount: string;
  netAmount: string;
  currency: string;
  status: 'DRAFT' | 'APPROVED' | 'PAID' | 'FAILED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A buyer contesting an order. */
export interface Dispute {
  id: string;
  orderId: string;
  sellerId: string;
  reason: string;
  status: 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'REJECTED';
  resolutionNote: string | null;
  openedAt: Date;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
