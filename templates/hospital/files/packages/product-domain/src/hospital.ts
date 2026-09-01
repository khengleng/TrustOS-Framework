/**
 * TrustOS Hospital — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustsystem/template-sdk';

export const HOSPITAL_PERMISSIONS = {
  HOSPITAL_DEPARTMENT_READ: definePermission(
    'hospital.hospital-department.read',
    'View departments.',
  ),
  HOSPITAL_DEPARTMENT_CREATE: definePermission(
    'hospital.hospital-department.create',
    'Create department.',
  ),
  HOSPITAL_DEPARTMENT_UPDATE: definePermission(
    'hospital.hospital-department.update',
    'Modify department.',
  ),
  WARD_READ: definePermission('hospital.ward.read', 'View wards.'),
  WARD_CREATE: definePermission('hospital.ward.create', 'Create ward.'),
  WARD_UPDATE: definePermission('hospital.ward.update', 'Modify ward.'),
  BED_READ: definePermission('hospital.bed.read', 'View beds.'),
  BED_CREATE: definePermission('hospital.bed.create', 'Create bed.'),
  BED_UPDATE: definePermission('hospital.bed.update', 'Modify bed.'),
  ADMISSION_READ: definePermission('hospital.admission.read', 'View admissions.'),
  ADMISSION_CREATE: definePermission('hospital.admission.create', 'Create admission.'),
  ADMISSION_UPDATE: definePermission('hospital.admission.update', 'Modify admission.'),
} as const;

export const HOSPITAL_PERMISSIONS_LIST: PermissionDefinition[] =
  Object.values(HOSPITAL_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  HOSPITAL_PERMISSIONS.HOSPITAL_DEPARTMENT_READ.key,
  HOSPITAL_PERMISSIONS.WARD_READ.key,
  HOSPITAL_PERMISSIONS.BED_READ.key,
  HOSPITAL_PERMISSIONS.ADMISSION_READ.key,
];

const WRITE = [
  HOSPITAL_PERMISSIONS.HOSPITAL_DEPARTMENT_CREATE.key,
  HOSPITAL_PERMISSIONS.HOSPITAL_DEPARTMENT_UPDATE.key,
  HOSPITAL_PERMISSIONS.WARD_CREATE.key,
  HOSPITAL_PERMISSIONS.WARD_UPDATE.key,
  HOSPITAL_PERMISSIONS.BED_CREATE.key,
  HOSPITAL_PERMISSIONS.BED_UPDATE.key,
  HOSPITAL_PERMISSIONS.ADMISSION_CREATE.key,
  HOSPITAL_PERMISSIONS.ADMISSION_UPDATE.key,
];

export const HOSPITAL_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: HOSPITAL_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type BedStatus = 'AVAILABLE' | 'OCCUPIED' | 'CLEANING' | 'OUT_OF_SERVICE';
export const BED_STATUS_VALUES: BedStatus[] = [
  'AVAILABLE',
  'OCCUPIED',
  'CLEANING',
  'OUT_OF_SERVICE',
];

export type AdmissionStatus = 'ADMITTED' | 'TRANSFERRED' | 'DISCHARGED';
export const ADMISSION_STATUS_VALUES: AdmissionStatus[] = ['ADMITTED', 'TRANSFERRED', 'DISCHARGED'];
