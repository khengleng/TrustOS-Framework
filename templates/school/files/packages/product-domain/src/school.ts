/**
 * TrustOS School — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustos/template-sdk';

export const SCHOOL_PERMISSIONS = {
  ACADEMIC_TERM_READ: definePermission('school.academic-term.read', 'View terms.'),
  ACADEMIC_TERM_CREATE: definePermission('school.academic-term.create', 'Create term.'),
  ACADEMIC_TERM_UPDATE: definePermission('school.academic-term.update', 'Modify term.'),
  CLASS_GROUP_READ: definePermission('school.class-group.read', 'View classes.'),
  CLASS_GROUP_CREATE: definePermission('school.class-group.create', 'Create class.'),
  CLASS_GROUP_UPDATE: definePermission('school.class-group.update', 'Modify class.'),
  ATTENDANCE_READ: definePermission('school.attendance.read', 'View attendance.'),
  ATTENDANCE_CREATE: definePermission('school.attendance.create', 'Create attendance record.'),
  ATTENDANCE_UPDATE: definePermission('school.attendance.update', 'Modify attendance record.'),
  GRADE_READ: definePermission('school.grade.read', 'View grades.'),
  GRADE_CREATE: definePermission('school.grade.create', 'Create grade.'),
  GRADE_UPDATE: definePermission('school.grade.update', 'Modify grade.'),
  GUARDIAN_READ: definePermission('school.guardian.read', 'View guardians.'),
  GUARDIAN_CREATE: definePermission('school.guardian.create', 'Create guardian.'),
  GUARDIAN_UPDATE: definePermission('school.guardian.update', 'Modify guardian.'),
} as const;

export const SCHOOL_PERMISSIONS_LIST: PermissionDefinition[] = Object.values(SCHOOL_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  SCHOOL_PERMISSIONS.ACADEMIC_TERM_READ.key,
  SCHOOL_PERMISSIONS.CLASS_GROUP_READ.key,
  SCHOOL_PERMISSIONS.ATTENDANCE_READ.key,
  SCHOOL_PERMISSIONS.GRADE_READ.key,
  SCHOOL_PERMISSIONS.GUARDIAN_READ.key,
];

const WRITE = [
  SCHOOL_PERMISSIONS.ACADEMIC_TERM_CREATE.key,
  SCHOOL_PERMISSIONS.ACADEMIC_TERM_UPDATE.key,
  SCHOOL_PERMISSIONS.CLASS_GROUP_CREATE.key,
  SCHOOL_PERMISSIONS.CLASS_GROUP_UPDATE.key,
  SCHOOL_PERMISSIONS.ATTENDANCE_CREATE.key,
  SCHOOL_PERMISSIONS.ATTENDANCE_UPDATE.key,
  SCHOOL_PERMISSIONS.GRADE_CREATE.key,
  SCHOOL_PERMISSIONS.GRADE_UPDATE.key,
  SCHOOL_PERMISSIONS.GUARDIAN_CREATE.key,
  SCHOOL_PERMISSIONS.GUARDIAN_UPDATE.key,
];

export const SCHOOL_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: SCHOOL_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type AttendanceState = 'PRESENT' | 'ABSENT' | 'LATE' | 'EXCUSED';
export const ATTENDANCE_STATE_VALUES: AttendanceState[] = ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'];
