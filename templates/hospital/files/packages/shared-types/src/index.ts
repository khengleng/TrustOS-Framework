/**
 * Shared types — TrustOS Hospital.
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

/** A clinical department. */
export interface HospitalDepartment {
  id: string;
  name: string;
  code: string;
  headPractitionerId: string | null;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A group of beds within a department. */
export interface Ward {
  id: string;
  departmentId: string;
  name: string;
  code: string;
  bedCount: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** One bed. Occupied by at most one admission at a time. */
export interface Bed {
  id: string;
  wardId: string;
  label: string;
  status: 'AVAILABLE' | 'OCCUPIED' | 'CLEANING' | 'OUT_OF_SERVICE';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A patient staying in. */
export interface Admission {
  id: string;
  patientId: string;
  bedId: string;
  admittingPractitionerId: string;
  reference: string;
  admittedAt: Date;
  dischargedAt: Date | null;
  status: 'ADMITTED' | 'TRANSFERRED' | 'DISCHARGED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
