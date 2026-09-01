/**
 * TrustOS Government Services — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustsystem/template-sdk';

export const GOVERNMENT_PERMISSIONS = {
  CITIZEN_READ: definePermission('government.citizen.read', 'View citizens.'),
  CITIZEN_CREATE: definePermission('government.citizen.create', 'Create citizen.'),
  CITIZEN_UPDATE: definePermission('government.citizen.update', 'Modify citizen.'),
  CITIZEN_PII_READ: definePermission(
    'government.citizen.pii.read',
    'See personal data on citizens (nationalIdRef, dateOfBirth, phone, addressLine).',
  ),
  GOVERNMENT_SERVICE_READ: definePermission('government.government-service.read', 'View services.'),
  GOVERNMENT_SERVICE_CREATE: definePermission(
    'government.government-service.create',
    'Create service.',
  ),
  GOVERNMENT_SERVICE_UPDATE: definePermission(
    'government.government-service.update',
    'Modify service.',
  ),
  SERVICE_APPLICATION_READ: definePermission(
    'government.service-application.read',
    'View applications.',
  ),
  SERVICE_APPLICATION_CREATE: definePermission(
    'government.service-application.create',
    'Create application.',
  ),
  SERVICE_APPLICATION_UPDATE: definePermission(
    'government.service-application.update',
    'Modify application.',
  ),
  SERVICE_APPOINTMENT_READ: definePermission(
    'government.service-appointment.read',
    'View appointments.',
  ),
  SERVICE_APPOINTMENT_CREATE: definePermission(
    'government.service-appointment.create',
    'Create appointment.',
  ),
  SERVICE_APPOINTMENT_UPDATE: definePermission(
    'government.service-appointment.update',
    'Modify appointment.',
  ),
  PUBLIC_NOTICE_READ: definePermission('government.public-notice.read', 'View notices.'),
  PUBLIC_NOTICE_CREATE: definePermission('government.public-notice.create', 'Create notice.'),
  PUBLIC_NOTICE_UPDATE: definePermission('government.public-notice.update', 'Modify notice.'),
} as const;

export const GOVERNMENT_PERMISSIONS_LIST: PermissionDefinition[] =
  Object.values(GOVERNMENT_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  GOVERNMENT_PERMISSIONS.CITIZEN_READ.key,
  GOVERNMENT_PERMISSIONS.GOVERNMENT_SERVICE_READ.key,
  GOVERNMENT_PERMISSIONS.SERVICE_APPLICATION_READ.key,
  GOVERNMENT_PERMISSIONS.SERVICE_APPOINTMENT_READ.key,
  GOVERNMENT_PERMISSIONS.PUBLIC_NOTICE_READ.key,
];

const WRITE = [
  GOVERNMENT_PERMISSIONS.CITIZEN_CREATE.key,
  GOVERNMENT_PERMISSIONS.CITIZEN_UPDATE.key,
  GOVERNMENT_PERMISSIONS.GOVERNMENT_SERVICE_CREATE.key,
  GOVERNMENT_PERMISSIONS.GOVERNMENT_SERVICE_UPDATE.key,
  GOVERNMENT_PERMISSIONS.SERVICE_APPLICATION_CREATE.key,
  GOVERNMENT_PERMISSIONS.SERVICE_APPLICATION_UPDATE.key,
  GOVERNMENT_PERMISSIONS.SERVICE_APPOINTMENT_CREATE.key,
  GOVERNMENT_PERMISSIONS.SERVICE_APPOINTMENT_UPDATE.key,
  GOVERNMENT_PERMISSIONS.PUBLIC_NOTICE_CREATE.key,
  GOVERNMENT_PERMISSIONS.PUBLIC_NOTICE_UPDATE.key,
];

/** Personal data. Granted to nobody by default except the owner role. */
const PERSONAL_DATA = [GOVERNMENT_PERMISSIONS.CITIZEN_PII_READ.key];

export const GOVERNMENT_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: GOVERNMENT_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE, ...PERSONAL_DATA],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type CitizenStatus = 'ACTIVE' | 'INACTIVE' | 'DECEASED';
export const CITIZEN_STATUS_VALUES: CitizenStatus[] = ['ACTIVE', 'INACTIVE', 'DECEASED'];

export type ServiceApplicationStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'IN_REVIEW'
  | 'INFORMATION_REQUESTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'WITHDRAWN';
export const SERVICE_APPLICATION_STATUS_VALUES: ServiceApplicationStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'IN_REVIEW',
  'INFORMATION_REQUESTED',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
];

export type ServiceAppointmentStatus = 'BOOKED' | 'ATTENDED' | 'MISSED' | 'CANCELLED';
export const SERVICE_APPOINTMENT_STATUS_VALUES: ServiceAppointmentStatus[] = [
  'BOOKED',
  'ATTENDED',
  'MISSED',
  'CANCELLED',
];

export type NoticeAudience = 'PUBLIC' | 'REGISTERED' | 'INTERNAL';
export const NOTICE_AUDIENCE_VALUES: NoticeAudience[] = ['PUBLIC', 'REGISTERED', 'INTERNAL'];
