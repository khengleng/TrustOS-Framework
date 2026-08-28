/**
 * Shared types — TrustOS Insurance.
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

/** Whoever the policy is issued to. */
export interface PolicyHolder {
  id: string;
  holderNumber: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: Date | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A cover that can be sold. */
export interface InsuranceProduct {
  id: string;
  code: string;
  name: string;
  category: 'LIFE' | 'HEALTH' | 'MOTOR' | 'PROPERTY' | 'TRAVEL';
  currency: string;
  basePremium: string;
  defaultSumInsured: string;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Cover sold to a holder. `sumInsured` is copied from the product at issue — cover that was sold */
/** cannot be changed by editing the product later. */
export interface Policy {
  id: string;
  policyNumber: string;
  holderId: string;
  productId: string;
  sumInsured: string;
  currency: string;
  startsOn: Date;
  endsOn: Date;
  status: 'QUOTED' | 'ACTIVE' | 'LAPSED' | 'CANCELLED' | 'EXPIRED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A premium due or received on a policy. */
export interface Premium {
  id: string;
  policyId: string;
  dueOn: Date;
  amount: string;
  currency: string;
  paidAt: Date | null;
  status: 'DUE' | 'PAID' | 'OVERDUE' | 'WAIVED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A request against a policy. The assessment decision lives in the workflow instance, not in a */
/** column here. */
export interface Claim {
  id: string;
  claimNumber: string;
  policyId: string;
  incidentOn: Date;
  reportedAt: Date;
  claimedAmount: string;
  approvedAmount: string | null;
  currency: string;
  workflowInstanceId: string | null;
  status: 'REPORTED' | 'ASSESSING' | 'APPROVED' | 'REJECTED' | 'PAID' | 'WITHDRAWN';
  summary: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
