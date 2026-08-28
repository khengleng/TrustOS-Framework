/**
 * Shared types — TrustOS Collections.
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

/** A person working cases. Authorization comes from framework RBAC. */
export interface Collector {
  id: string;
  userId: string;
  displayName: string;
  team: string | null;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** An overdue obligation being worked. */
export interface CollectionCase {
  id: string;
  reference: string;
  debtorName: string;
  debtorPhone: string | null;
  externalAccountRef: string | null;
  outstandingAmount: string;
  currency: string;
  daysPastDue: number;
  bucket: 'B0' | 'B1' | 'B2' | 'B3' | 'B4_PLUS';
  status: 'OPEN' | 'IN_PROGRESS' | 'PROMISED' | 'SETTLED' | 'ESCALATED' | 'CLOSED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Who is working a case, from when. History is kept: reassigning writes a new row and ends the */
/** old one, so "who had this case in March" has an answer. */
export interface CaseAssignment {
  id: string;
  caseId: string;
  collectorId: string;
  assignedAt: Date;
  endedAt: Date | null;
  reason: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A debtor committing to pay by a date. Kept or broken, never rescheduled in place — see the */
/** migration note. */
export interface PaymentPromise {
  id: string;
  caseId: string;
  collectorId: string;
  promisedAmount: string;
  currency: string;
  promisedFor: Date;
  takenAt: Date;
  status: 'OPEN' | 'KEPT' | 'BROKEN' | 'CANCELLED';
  note: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A scheduled or completed visit to a debtor. */
export interface FieldVisit {
  id: string;
  caseId: string;
  collectorId: string;
  scheduledFor: Date;
  completedAt: Date | null;
  outcome: 'NOT_VISITED' | 'MET' | 'NOT_FOUND' | 'REFUSED' | 'RELOCATED' | null;
  notes: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
