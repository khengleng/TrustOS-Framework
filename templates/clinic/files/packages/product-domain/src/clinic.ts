/**
 * TrustOS Clinic — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustos/template-sdk';

export const CLINIC_PERMISSIONS = {
  PATIENT_READ: definePermission('clinic.patient.read', 'View patients.'),
  PATIENT_CREATE: definePermission('clinic.patient.create', 'Create patient.'),
  PATIENT_UPDATE: definePermission('clinic.patient.update', 'Modify patient.'),
  PATIENT_PII_READ: definePermission(
    'clinic.patient.pii.read',
    'See personal data on patients (dateOfBirth, phone, addressLine).',
  ),
  PRACTITIONER_READ: definePermission('clinic.practitioner.read', 'View doctors.'),
  PRACTITIONER_CREATE: definePermission('clinic.practitioner.create', 'Create doctor.'),
  PRACTITIONER_UPDATE: definePermission('clinic.practitioner.update', 'Modify doctor.'),
  APPOINTMENT_READ: definePermission('clinic.appointment.read', 'View appointments.'),
  APPOINTMENT_CREATE: definePermission('clinic.appointment.create', 'Create appointment.'),
  APPOINTMENT_UPDATE: definePermission('clinic.appointment.update', 'Modify appointment.'),
  MEDICAL_RECORD_ENTRY_READ: definePermission(
    'clinic.medical-record-entry.read',
    'View medical records.',
  ),
  MEDICAL_RECORD_ENTRY_CREATE: definePermission(
    'clinic.medical-record-entry.create',
    'Create record entry.',
  ),
  MEDICAL_RECORD_ENTRY_UPDATE: definePermission(
    'clinic.medical-record-entry.update',
    'Modify record entry.',
  ),
  MEDICAL_RECORD_ENTRY_PII_READ: definePermission(
    'clinic.medical-record-entry.pii.read',
    'See personal data on medical records (body).',
  ),
  CLINIC_INVOICE_READ: definePermission('clinic.clinic-invoice.read', 'View invoices.'),
  CLINIC_INVOICE_CREATE: definePermission('clinic.clinic-invoice.create', 'Create invoice.'),
  CLINIC_INVOICE_UPDATE: definePermission('clinic.clinic-invoice.update', 'Modify invoice.'),
} as const;

export const CLINIC_PERMISSIONS_LIST: PermissionDefinition[] = Object.values(CLINIC_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  CLINIC_PERMISSIONS.PATIENT_READ.key,
  CLINIC_PERMISSIONS.PRACTITIONER_READ.key,
  CLINIC_PERMISSIONS.APPOINTMENT_READ.key,
  CLINIC_PERMISSIONS.MEDICAL_RECORD_ENTRY_READ.key,
  CLINIC_PERMISSIONS.CLINIC_INVOICE_READ.key,
];

const WRITE = [
  CLINIC_PERMISSIONS.PATIENT_CREATE.key,
  CLINIC_PERMISSIONS.PATIENT_UPDATE.key,
  CLINIC_PERMISSIONS.PRACTITIONER_CREATE.key,
  CLINIC_PERMISSIONS.PRACTITIONER_UPDATE.key,
  CLINIC_PERMISSIONS.APPOINTMENT_CREATE.key,
  CLINIC_PERMISSIONS.APPOINTMENT_UPDATE.key,
  CLINIC_PERMISSIONS.MEDICAL_RECORD_ENTRY_CREATE.key,
  CLINIC_PERMISSIONS.MEDICAL_RECORD_ENTRY_UPDATE.key,
  CLINIC_PERMISSIONS.CLINIC_INVOICE_CREATE.key,
  CLINIC_PERMISSIONS.CLINIC_INVOICE_UPDATE.key,
];

/** Personal data. Granted to nobody by default except the owner role. */
const PERSONAL_DATA = [
  CLINIC_PERMISSIONS.PATIENT_PII_READ.key,
  CLINIC_PERMISSIONS.MEDICAL_RECORD_ENTRY_PII_READ.key,
];

export const CLINIC_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: CLINIC_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE, ...PERSONAL_DATA],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type PatientSex = 'FEMALE' | 'MALE' | 'OTHER' | 'UNDISCLOSED';
export const PATIENT_SEX_VALUES: PatientSex[] = ['FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED'];

export type PatientStatus = 'ACTIVE' | 'INACTIVE' | 'DECEASED';
export const PATIENT_STATUS_VALUES: PatientStatus[] = ['ACTIVE', 'INACTIVE', 'DECEASED'];

export type AppointmentStatus =
  'BOOKED' | 'ARRIVED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
export const APPOINTMENT_STATUS_VALUES: AppointmentStatus[] = [
  'BOOKED',
  'ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
];

export type RecordKind =
  'CONSULTATION' | 'OBSERVATION' | 'PRESCRIPTION' | 'REFERRAL' | 'ATTACHMENT';
export const RECORD_KIND_VALUES: RecordKind[] = [
  'CONSULTATION',
  'OBSERVATION',
  'PRESCRIPTION',
  'REFERRAL',
  'ATTACHMENT',
];

export type ClinicInvoiceStatus = 'DRAFT' | 'ISSUED' | 'PAID' | 'VOID';
export const CLINIC_INVOICE_STATUS_VALUES: ClinicInvoiceStatus[] = [
  'DRAFT',
  'ISSUED',
  'PAID',
  'VOID',
];
