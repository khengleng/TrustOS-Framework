/**
 * Shared types — TrustOS Clinic.
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

/** A person receiving care. Contact fields are sensitive: they sit behind */
/** `clinic.patient.pii.read`, not the general read permission. */
export interface Patient {
  id: string;
  patientNumber: string;
  fullName: string;
  dateOfBirth: Date | null;
  sex: 'FEMALE' | 'MALE' | 'OTHER' | 'UNDISCLOSED' | null;
  phone: string | null;
  addressLine: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'DECEASED';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A clinician. `userId` is the framework identity. */
export interface Practitioner {
  id: string;
  userId: string;
  displayName: string;
  speciality: string | null;
  licenceNumber: string | null;
  isAcceptingPatients: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A booked slot. */
export interface Appointment {
  id: string;
  patientId: string;
  practitionerId: string;
  reference: string;
  scheduledFor: Date;
  durationMinutes: number;
  reason: string | null;
  status: 'BOOKED' | 'ARRIVED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** A note against a patient. Free text with an author and a time — nothing here interprets it, */
/** and nothing here should. Behind its own permission. */
export interface MedicalRecordEntry {
  id: string;
  patientId: string;
  appointmentId: string | null;
  authorPractitionerId: string;
  kind: 'CONSULTATION' | 'OBSERVATION' | 'PRESCRIPTION' | 'REFERRAL' | 'ATTACHMENT';
  body: string;
  recordedAt: Date;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** What the visit cost. */
export interface ClinicInvoice {
  id: string;
  patientId: string;
  appointmentId: string | null;
  number: string;
  issuedAt: Date;
  total: string;
  currency: string;
  status: 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID';
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
