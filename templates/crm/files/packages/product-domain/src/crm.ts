/**
 * TrustOS CRM — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustsystem/template-sdk';

export const CRM_PERMISSIONS = {
  CUSTOMER_READ: definePermission('crm.customer.read', 'View customers.'),
  CUSTOMER_CREATE: definePermission('crm.customer.create', 'Create customer.'),
  CUSTOMER_UPDATE: definePermission('crm.customer.update', 'Modify customer.'),
  CONTACT_READ: definePermission('crm.contact.read', 'View contacts.'),
  CONTACT_CREATE: definePermission('crm.contact.create', 'Create contact.'),
  CONTACT_UPDATE: definePermission('crm.contact.update', 'Modify contact.'),
  LEAD_READ: definePermission('crm.lead.read', 'View leads.'),
  LEAD_CREATE: definePermission('crm.lead.create', 'Create lead.'),
  LEAD_UPDATE: definePermission('crm.lead.update', 'Modify lead.'),
  PIPELINE_STAGE_READ: definePermission('crm.pipeline-stage.read', 'View pipeline stages.'),
  PIPELINE_STAGE_CREATE: definePermission('crm.pipeline-stage.create', 'Create stage.'),
  PIPELINE_STAGE_UPDATE: definePermission('crm.pipeline-stage.update', 'Modify stage.'),
  OPPORTUNITY_READ: definePermission('crm.opportunity.read', 'View opportunities.'),
  OPPORTUNITY_CREATE: definePermission('crm.opportunity.create', 'Create opportunity.'),
  OPPORTUNITY_UPDATE: definePermission('crm.opportunity.update', 'Modify opportunity.'),
  ACTIVITY_READ: definePermission('crm.activity.read', 'View activities.'),
  ACTIVITY_CREATE: definePermission('crm.activity.create', 'Create activity.'),
  ACTIVITY_UPDATE: definePermission('crm.activity.update', 'Modify activity.'),
  CRM_TASK_READ: definePermission('crm.crm-task.read', 'View tasks.'),
  CRM_TASK_CREATE: definePermission('crm.crm-task.create', 'Create task.'),
  CRM_TASK_UPDATE: definePermission('crm.crm-task.update', 'Modify task.'),
} as const;

export const CRM_PERMISSIONS_LIST: PermissionDefinition[] = Object.values(CRM_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  CRM_PERMISSIONS.CUSTOMER_READ.key,
  CRM_PERMISSIONS.CONTACT_READ.key,
  CRM_PERMISSIONS.LEAD_READ.key,
  CRM_PERMISSIONS.PIPELINE_STAGE_READ.key,
  CRM_PERMISSIONS.OPPORTUNITY_READ.key,
  CRM_PERMISSIONS.ACTIVITY_READ.key,
  CRM_PERMISSIONS.CRM_TASK_READ.key,
];

const WRITE = [
  CRM_PERMISSIONS.CUSTOMER_CREATE.key,
  CRM_PERMISSIONS.CUSTOMER_UPDATE.key,
  CRM_PERMISSIONS.CONTACT_CREATE.key,
  CRM_PERMISSIONS.CONTACT_UPDATE.key,
  CRM_PERMISSIONS.LEAD_CREATE.key,
  CRM_PERMISSIONS.LEAD_UPDATE.key,
  CRM_PERMISSIONS.PIPELINE_STAGE_CREATE.key,
  CRM_PERMISSIONS.PIPELINE_STAGE_UPDATE.key,
  CRM_PERMISSIONS.OPPORTUNITY_CREATE.key,
  CRM_PERMISSIONS.OPPORTUNITY_UPDATE.key,
  CRM_PERMISSIONS.ACTIVITY_CREATE.key,
  CRM_PERMISSIONS.ACTIVITY_UPDATE.key,
  CRM_PERMISSIONS.CRM_TASK_CREATE.key,
  CRM_PERMISSIONS.CRM_TASK_UPDATE.key,
];

export const CRM_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: CRM_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type CustomerStatus = 'PROSPECT' | 'ACTIVE' | 'DORMANT' | 'LOST';
export const CUSTOMER_STATUS_VALUES: CustomerStatus[] = ['PROSPECT', 'ACTIVE', 'DORMANT', 'LOST'];

export type LeadSource = 'WEB' | 'REFERRAL' | 'EVENT' | 'OUTBOUND' | 'PARTNER' | 'OTHER';
export const LEAD_SOURCE_VALUES: LeadSource[] = [
  'WEB',
  'REFERRAL',
  'EVENT',
  'OUTBOUND',
  'PARTNER',
  'OTHER',
];

export type LeadStatus = 'NEW' | 'CONTACTED' | 'QUALIFIED' | 'CONVERTED' | 'DISQUALIFIED';
export const LEAD_STATUS_VALUES: LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'CONVERTED',
  'DISQUALIFIED',
];

export type ActivityKind = 'CALL' | 'MEETING' | 'EMAIL' | 'NOTE' | 'VISIT';
export const ACTIVITY_KIND_VALUES: ActivityKind[] = ['CALL', 'MEETING', 'EMAIL', 'NOTE', 'VISIT'];

export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
export const TASK_STATUS_VALUES: TaskStatus[] = ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
