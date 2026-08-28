/**
 * Shared types — TrustOS NGO.
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

/** A long-running area of work. */
export interface Programme {
  id: string;
  code: string;
  name: string;
  summary: string | null;
  status: 'PLANNED' | 'ACTIVE' | 'CLOSED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A funded piece of work inside a programme. */
export interface NgoProject {
  id: string;
  programmeId: string;
  code: string;
  name: string;
  location: string | null;
  budget: string;
  currency: string;
  startsOn: Date | null;
  endsOn: Date | null;
  status: 'PLANNED' | 'ACTIVE' | 'SUSPENDED' | 'COMPLETED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Somebody who funds the work. */
export interface Donor {
  id: string;
  name: string;
  code: string;
  kind: 'INDIVIDUAL' | 'CORPORATE' | 'FOUNDATION' | 'GOVERNMENT' | 'MULTILATERAL';
  email: string | null;
  phone: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Money given, optionally earmarked for a project. */
export interface Donation {
  id: string;
  donorId: string;
  projectId: string | null;
  reference: string;
  amount: string;
  currency: string;
  receivedOn: Date;
  isRestricted: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Somebody the work reaches. The most sensitive records in the schema — see the migration note */
/** before exporting any of it. */
export interface Beneficiary {
  id: string;
  projectId: string;
  reference: string;
  fullName: string;
  phone: string | null;
  village: string | null;
  householdSize: number;
  enrolledOn: Date;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** What happened on the ground, and when. */
export interface FieldReport {
  id: string;
  projectId: string;
  title: string;
  body: string;
  reportedOn: Date;
  authorUserId: string | null;
  peopleReached: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
