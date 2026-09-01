/**
 * TrustOS Collections — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustsystem/template-sdk';

export const COLLECTION_PERMISSIONS = {
  COLLECTOR_READ: definePermission('collection.collector.read', 'View collectors.'),
  COLLECTOR_CREATE: definePermission('collection.collector.create', 'Create collector.'),
  COLLECTOR_UPDATE: definePermission('collection.collector.update', 'Modify collector.'),
  COLLECTION_CASE_READ: definePermission('collection.collection-case.read', 'View cases.'),
  COLLECTION_CASE_CREATE: definePermission('collection.collection-case.create', 'Create case.'),
  COLLECTION_CASE_UPDATE: definePermission('collection.collection-case.update', 'Modify case.'),
  CASE_ASSIGNMENT_READ: definePermission('collection.case-assignment.read', 'View assignments.'),
  CASE_ASSIGNMENT_CREATE: definePermission(
    'collection.case-assignment.create',
    'Create assignment.',
  ),
  CASE_ASSIGNMENT_UPDATE: definePermission(
    'collection.case-assignment.update',
    'Modify assignment.',
  ),
  PAYMENT_PROMISE_READ: definePermission('collection.payment-promise.read', 'View promises.'),
  PAYMENT_PROMISE_CREATE: definePermission('collection.payment-promise.create', 'Create promise.'),
  PAYMENT_PROMISE_UPDATE: definePermission('collection.payment-promise.update', 'Modify promise.'),
  FIELD_VISIT_READ: definePermission('collection.field-visit.read', 'View visits.'),
  FIELD_VISIT_CREATE: definePermission('collection.field-visit.create', 'Create visit.'),
  FIELD_VISIT_UPDATE: definePermission('collection.field-visit.update', 'Modify visit.'),
} as const;

export const COLLECTION_PERMISSIONS_LIST: PermissionDefinition[] =
  Object.values(COLLECTION_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  COLLECTION_PERMISSIONS.COLLECTOR_READ.key,
  COLLECTION_PERMISSIONS.COLLECTION_CASE_READ.key,
  COLLECTION_PERMISSIONS.CASE_ASSIGNMENT_READ.key,
  COLLECTION_PERMISSIONS.PAYMENT_PROMISE_READ.key,
  COLLECTION_PERMISSIONS.FIELD_VISIT_READ.key,
];

const WRITE = [
  COLLECTION_PERMISSIONS.COLLECTOR_CREATE.key,
  COLLECTION_PERMISSIONS.COLLECTOR_UPDATE.key,
  COLLECTION_PERMISSIONS.COLLECTION_CASE_CREATE.key,
  COLLECTION_PERMISSIONS.COLLECTION_CASE_UPDATE.key,
  COLLECTION_PERMISSIONS.CASE_ASSIGNMENT_CREATE.key,
  COLLECTION_PERMISSIONS.CASE_ASSIGNMENT_UPDATE.key,
  COLLECTION_PERMISSIONS.PAYMENT_PROMISE_CREATE.key,
  COLLECTION_PERMISSIONS.PAYMENT_PROMISE_UPDATE.key,
  COLLECTION_PERMISSIONS.FIELD_VISIT_CREATE.key,
  COLLECTION_PERMISSIONS.FIELD_VISIT_UPDATE.key,
];

export const COLLECTION_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: COLLECTION_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type CollectionBucket = 'B0' | 'B1' | 'B2' | 'B3' | 'B4_PLUS';
export const COLLECTION_BUCKET_VALUES: CollectionBucket[] = ['B0', 'B1', 'B2', 'B3', 'B4_PLUS'];

export type CaseStatus = 'OPEN' | 'IN_PROGRESS' | 'PROMISED' | 'SETTLED' | 'ESCALATED' | 'CLOSED';
export const CASE_STATUS_VALUES: CaseStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'PROMISED',
  'SETTLED',
  'ESCALATED',
  'CLOSED',
];

export type PromiseStatus = 'OPEN' | 'KEPT' | 'BROKEN' | 'CANCELLED';
export const PROMISE_STATUS_VALUES: PromiseStatus[] = ['OPEN', 'KEPT', 'BROKEN', 'CANCELLED'];

export type VisitOutcome = 'NOT_VISITED' | 'MET' | 'NOT_FOUND' | 'REFUSED' | 'RELOCATED';
export const VISIT_OUTCOME_VALUES: VisitOutcome[] = [
  'NOT_VISITED',
  'MET',
  'NOT_FOUND',
  'REFUSED',
  'RELOCATED',
];
