/**
 * Shared types — TrustOS Microloan.
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

/** A person or business that can hold a loan. */
export interface Borrower {
  id: string;
  borrowerNumber: string;
  fullName: string;
  phone: string | null;
  addressLine: string | null;
  status: 'ACTIVE' | 'BLOCKED' | 'CLOSED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** The terms a loan can be written on. Rates are stored as decimal strings, never floats — a rate */
/** multiplied in binary floating point is wrong by the third instalment. */
export interface LoanProduct {
  id: string;
  code: string;
  name: string;
  currency: string;
  minPrincipal: string;
  maxPrincipal: string;
  annualRate: string;
  termMonths: number;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A request for a loan, governed by the framework approval workflow. `workflowInstanceId` is */
/** where the decision actually lives — this row must not grow its own approval columns. */
export interface LoanApplication {
  id: string;
  reference: string;
  borrowerId: string;
  productId: string;
  requestedPrincipal: string;
  currency: string;
  purpose: string | null;
  workflowInstanceId: string | null;
  status: 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
  submittedAt: Date;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A disbursed loan. The outstanding balance is derived from the ledger, not stored — the same */
/** rule as a wallet, for the same reason. */
export interface LoanAccount {
  id: string;
  applicationId: string;
  borrowerId: string;
  accountNumber: string;
  principal: string;
  currency: string;
  annualRate: string;
  termMonths: number;
  disbursedAt: Date;
  status: 'ACTIVE' | 'IN_ARREARS' | 'CLOSED' | 'WRITTEN_OFF' | 'RESTRUCTURED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** One scheduled payment. Generated at disbursement and never recomputed: a schedule that changes */
/** retroactively cannot be reconciled against what the borrower was told. */
export interface RepaymentInstalment {
  id: string;
  loanId: string;
  sequence: number;
  dueDate: Date;
  principalDue: string;
  interestDue: string;
  totalDue: string;
  currency: string;
  status: 'DUE' | 'PAID' | 'PARTIAL' | 'OVERDUE' | 'WAIVED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Money received against a loan, linked to the ledger journal that moved it. */
export interface Repayment {
  id: string;
  loanId: string;
  reference: string;
  amount: string;
  currency: string;
  receivedAt: Date;
  journalId: string | null;
  method: 'CASH' | 'WALLET' | 'BANK_TRANSFER' | 'ADJUSTMENT';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
