/**
 * TrustOS ERP — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustos/template-sdk';

export const ERP_PERMISSIONS = {
  DEPARTMENT_READ: definePermission('erp.department.read', 'View departments.'),
  DEPARTMENT_CREATE: definePermission('erp.department.create', 'Create department.'),
  DEPARTMENT_UPDATE: definePermission('erp.department.update', 'Modify department.'),
  EMPLOYEE_READ: definePermission('erp.employee.read', 'View employees.'),
  EMPLOYEE_CREATE: definePermission('erp.employee.create', 'Create employee.'),
  EMPLOYEE_UPDATE: definePermission('erp.employee.update', 'Modify employee.'),
  PROJECT_READ: definePermission('erp.project.read', 'View projects.'),
  PROJECT_CREATE: definePermission('erp.project.create', 'Create project.'),
  PROJECT_UPDATE: definePermission('erp.project.update', 'Modify project.'),
  INVENTORY_ITEM_READ: definePermission('erp.inventory-item.read', 'View inventory.'),
  INVENTORY_ITEM_CREATE: definePermission('erp.inventory-item.create', 'Create item.'),
  INVENTORY_ITEM_UPDATE: definePermission('erp.inventory-item.update', 'Modify item.'),
  PURCHASE_REQUEST_READ: definePermission('erp.purchase-request.read', 'View purchase requests.'),
  PURCHASE_REQUEST_CREATE: definePermission(
    'erp.purchase-request.create',
    'Create purchase request.',
  ),
  PURCHASE_REQUEST_UPDATE: definePermission(
    'erp.purchase-request.update',
    'Modify purchase request.',
  ),
} as const;

export const ERP_PERMISSIONS_LIST: PermissionDefinition[] = Object.values(ERP_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  ERP_PERMISSIONS.DEPARTMENT_READ.key,
  ERP_PERMISSIONS.EMPLOYEE_READ.key,
  ERP_PERMISSIONS.PROJECT_READ.key,
  ERP_PERMISSIONS.INVENTORY_ITEM_READ.key,
  ERP_PERMISSIONS.PURCHASE_REQUEST_READ.key,
];

const WRITE = [
  ERP_PERMISSIONS.DEPARTMENT_CREATE.key,
  ERP_PERMISSIONS.DEPARTMENT_UPDATE.key,
  ERP_PERMISSIONS.EMPLOYEE_CREATE.key,
  ERP_PERMISSIONS.EMPLOYEE_UPDATE.key,
  ERP_PERMISSIONS.PROJECT_CREATE.key,
  ERP_PERMISSIONS.PROJECT_UPDATE.key,
  ERP_PERMISSIONS.INVENTORY_ITEM_CREATE.key,
  ERP_PERMISSIONS.INVENTORY_ITEM_UPDATE.key,
  ERP_PERMISSIONS.PURCHASE_REQUEST_CREATE.key,
  ERP_PERMISSIONS.PURCHASE_REQUEST_UPDATE.key,
];

export const ERP_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: ERP_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type EmploymentStatus = 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED' | 'LEFT';
export const EMPLOYMENT_STATUS_VALUES: EmploymentStatus[] = [
  'ACTIVE',
  'ON_LEAVE',
  'SUSPENDED',
  'LEFT',
];

export type ProjectStatus = 'PLANNED' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
export const PROJECT_STATUS_VALUES: ProjectStatus[] = [
  'PLANNED',
  'ACTIVE',
  'ON_HOLD',
  'COMPLETED',
  'CANCELLED',
];

export type PurchaseStatus =
  'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'ORDERED' | 'RECEIVED' | 'CANCELLED';
export const PURCHASE_STATUS_VALUES: PurchaseStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'ORDERED',
  'RECEIVED',
  'CANCELLED',
];
