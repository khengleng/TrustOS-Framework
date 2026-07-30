/**
 * Shared types — TrustOS Government Services.
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

/** A person known to the agency. `nationalIdRef` is an opaque reference, never a validated */
/** national identifier — validating one means encoding a country, and this template does not. */
export interface Citizen {
  id: string;
  citizenNumber: string;
  fullName: string;
  nationalIdRef: string | null;
  dateOfBirth: Date | null;
  phone: string | null;
  addressLine: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'DECEASED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Something a citizen can apply for. */
export interface GovernmentService {
  id: string;
  code: string;
  name: string;
  description: string | null;
  workflowDefinitionId: string | null;
  processingDays: number;
  isActive: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A citizen applying. The decision lives in the workflow instance; this row holds what was */
/** submitted. */
export interface ServiceApplication {
  id: string;
  reference: string;
  citizenId: string;
  serviceId: string;
  submittedAt: Date;
  payload: Record<string, unknown> | null;
  workflowInstanceId: string | null;
  status:
    | 'DRAFT'
    | 'SUBMITTED'
    | 'IN_REVIEW'
    | 'INFORMATION_REQUESTED'
    | 'APPROVED'
    | 'REJECTED'
    | 'WITHDRAWN';
  decidedAt: Date | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A slot booked at an office. */
export interface ServiceAppointment {
  id: string;
  applicationId: string | null;
  citizenId: string;
  office: string;
  scheduledFor: Date;
  status: 'BOOKED' | 'ATTENDED' | 'MISSED' | 'CANCELLED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Something the agency publishes. */
export interface PublicNotice {
  id: string;
  title: string;
  body: string;
  publishedAt: Date | null;
  expiresAt: Date | null;
  audience: 'PUBLIC' | 'REGISTERED' | 'INTERNAL';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
