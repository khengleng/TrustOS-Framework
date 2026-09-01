/**
 * TrustOS NGO — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustsystem/template-sdk';

export const NGO_PERMISSIONS = {
  PROGRAMME_READ: definePermission('ngo.programme.read', 'View programmes.'),
  PROGRAMME_CREATE: definePermission('ngo.programme.create', 'Create programme.'),
  PROGRAMME_UPDATE: definePermission('ngo.programme.update', 'Modify programme.'),
  NGO_PROJECT_READ: definePermission('ngo.ngo-project.read', 'View projects.'),
  NGO_PROJECT_CREATE: definePermission('ngo.ngo-project.create', 'Create project.'),
  NGO_PROJECT_UPDATE: definePermission('ngo.ngo-project.update', 'Modify project.'),
  DONOR_READ: definePermission('ngo.donor.read', 'View donors.'),
  DONOR_CREATE: definePermission('ngo.donor.create', 'Create donor.'),
  DONOR_UPDATE: definePermission('ngo.donor.update', 'Modify donor.'),
  DONOR_PII_READ: definePermission(
    'ngo.donor.pii.read',
    'See personal data on donors (email, phone).',
  ),
  DONATION_READ: definePermission('ngo.donation.read', 'View donations.'),
  DONATION_CREATE: definePermission('ngo.donation.create', 'Create donation.'),
  DONATION_UPDATE: definePermission('ngo.donation.update', 'Modify donation.'),
  BENEFICIARY_READ: definePermission('ngo.beneficiary.read', 'View beneficiaries.'),
  BENEFICIARY_CREATE: definePermission('ngo.beneficiary.create', 'Create beneficiary.'),
  BENEFICIARY_UPDATE: definePermission('ngo.beneficiary.update', 'Modify beneficiary.'),
  BENEFICIARY_PII_READ: definePermission(
    'ngo.beneficiary.pii.read',
    'See personal data on beneficiaries (fullName, phone).',
  ),
  FIELD_REPORT_READ: definePermission('ngo.field-report.read', 'View field reports.'),
  FIELD_REPORT_CREATE: definePermission('ngo.field-report.create', 'Create field report.'),
  FIELD_REPORT_UPDATE: definePermission('ngo.field-report.update', 'Modify field report.'),
} as const;

export const NGO_PERMISSIONS_LIST: PermissionDefinition[] = Object.values(NGO_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  NGO_PERMISSIONS.PROGRAMME_READ.key,
  NGO_PERMISSIONS.NGO_PROJECT_READ.key,
  NGO_PERMISSIONS.DONOR_READ.key,
  NGO_PERMISSIONS.DONATION_READ.key,
  NGO_PERMISSIONS.BENEFICIARY_READ.key,
  NGO_PERMISSIONS.FIELD_REPORT_READ.key,
];

const WRITE = [
  NGO_PERMISSIONS.PROGRAMME_CREATE.key,
  NGO_PERMISSIONS.PROGRAMME_UPDATE.key,
  NGO_PERMISSIONS.NGO_PROJECT_CREATE.key,
  NGO_PERMISSIONS.NGO_PROJECT_UPDATE.key,
  NGO_PERMISSIONS.DONOR_CREATE.key,
  NGO_PERMISSIONS.DONOR_UPDATE.key,
  NGO_PERMISSIONS.DONATION_CREATE.key,
  NGO_PERMISSIONS.DONATION_UPDATE.key,
  NGO_PERMISSIONS.BENEFICIARY_CREATE.key,
  NGO_PERMISSIONS.BENEFICIARY_UPDATE.key,
  NGO_PERMISSIONS.FIELD_REPORT_CREATE.key,
  NGO_PERMISSIONS.FIELD_REPORT_UPDATE.key,
];

/** Personal data. Granted to nobody by default except the owner role. */
const PERSONAL_DATA = [
  NGO_PERMISSIONS.DONOR_PII_READ.key,
  NGO_PERMISSIONS.BENEFICIARY_PII_READ.key,
];

export const NGO_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: NGO_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE, ...PERSONAL_DATA],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type ProgrammeStatus = 'PLANNED' | 'ACTIVE' | 'CLOSED';
export const PROGRAMME_STATUS_VALUES: ProgrammeStatus[] = ['PLANNED', 'ACTIVE', 'CLOSED'];

export type NgoProjectStatus = 'PLANNED' | 'ACTIVE' | 'SUSPENDED' | 'COMPLETED';
export const NGO_PROJECT_STATUS_VALUES: NgoProjectStatus[] = [
  'PLANNED',
  'ACTIVE',
  'SUSPENDED',
  'COMPLETED',
];

export type DonorKind = 'INDIVIDUAL' | 'CORPORATE' | 'FOUNDATION' | 'GOVERNMENT' | 'MULTILATERAL';
export const DONOR_KIND_VALUES: DonorKind[] = [
  'INDIVIDUAL',
  'CORPORATE',
  'FOUNDATION',
  'GOVERNMENT',
  'MULTILATERAL',
];
