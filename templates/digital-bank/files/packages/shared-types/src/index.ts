/**
 * Shared types — TrustOS Digital Bank.
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

/** A person or business the bank holds a relationship with. */
export interface BankCustomer {
  id: string;
  customerNumber: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  segment: 'RETAIL' | 'SME' | 'CORPORATE';
  status: 'PENDING' | 'ACTIVE' | 'DORMANT' | 'CLOSED';
  onboardedAt: Date;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A customer-facing account. The money is in the framework wallet named by `profileId`; this row */
/** carries the account number and the product terms. */
export interface BankAccount {
  id: string;
  customerId: string;
  profileId: string;
  accountNumber: string;
  productName: string;
  currency: string;
  status: 'ACTIVE' | 'FROZEN' | 'DORMANT' | 'CLOSED';
  openedAt: Date;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A generated statement for a window. Half-open `[from, to)`, the same convention the ledger */
/** uses for accounting periods — an inclusive end double-counts the boundary. */
export interface AccountStatement {
  id: string;
  accountId: string;
  periodStart: Date;
  periodEnd: Date;
  openingBalance: string;
  closingBalance: string;
  currency: string;
  generatedAt: Date;
  status: 'GENERATED' | 'DELIVERED' | 'FAILED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Which channels a customer has muted. Security notifications ignore this — see the `optional` */
/** flag in @trustsystem/template-sdk. */
export interface CustomerNotificationPreference {
  id: string;
  customerId: string;
  channel: 'IN_APP' | 'EMAIL' | 'SMS' | 'PUSH';
  muted: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
