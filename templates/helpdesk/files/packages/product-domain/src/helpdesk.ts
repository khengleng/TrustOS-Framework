/**
 * TrustOS Helpdesk — permission keys and domain types.
 *
 * Permission keys are a public contract: add keys freely, never rename one. A renamed key
 * silently revokes access on every deployment that has not been migrated and grants it on none —
 * the failure is invisible until somebody cannot do their job.
 *
 * Keys are namespaced under the template id so they can never collide with a framework key or
 * with another template layered beneath this one.
 */

import { definePermission, type PermissionDefinition } from '@trustos/template-sdk';

export const HELPDESK_PERMISSIONS = {
  TICKET_QUEUE_READ: definePermission('helpdesk.ticket-queue.read', 'View queues.'),
  TICKET_QUEUE_CREATE: definePermission('helpdesk.ticket-queue.create', 'Create queue.'),
  TICKET_QUEUE_UPDATE: definePermission('helpdesk.ticket-queue.update', 'Modify queue.'),
  SUPPORT_AGENT_READ: definePermission('helpdesk.support-agent.read', 'View agents.'),
  SUPPORT_AGENT_CREATE: definePermission('helpdesk.support-agent.create', 'Create agent.'),
  SUPPORT_AGENT_UPDATE: definePermission('helpdesk.support-agent.update', 'Modify agent.'),
  SLA_POLICY_READ: definePermission('helpdesk.sla-policy.read', 'View sla policies.'),
  SLA_POLICY_CREATE: definePermission('helpdesk.sla-policy.create', 'Create sla policy.'),
  SLA_POLICY_UPDATE: definePermission('helpdesk.sla-policy.update', 'Modify sla policy.'),
  TICKET_READ: definePermission('helpdesk.ticket.read', 'View tickets.'),
  TICKET_CREATE: definePermission('helpdesk.ticket.create', 'Create ticket.'),
  TICKET_UPDATE: definePermission('helpdesk.ticket.update', 'Modify ticket.'),
  TICKET_COMMENT_READ: definePermission('helpdesk.ticket-comment.read', 'View comments.'),
  TICKET_COMMENT_CREATE: definePermission('helpdesk.ticket-comment.create', 'Create comment.'),
  TICKET_COMMENT_UPDATE: definePermission('helpdesk.ticket-comment.update', 'Modify comment.'),
} as const;

export const HELPDESK_PERMISSIONS_LIST: PermissionDefinition[] =
  Object.values(HELPDESK_PERMISSIONS);

/**
 * Which framework roles receive which permissions.
 *
 * Least privilege, and the two rules that matter: `auditor` is read-only by definition and must
 * never gain a write here, and personal data is granted separately from ordinary reads — an
 * operator who can work a record usually has no business reading the identity behind it.
 */
const READ_ONLY = [
  HELPDESK_PERMISSIONS.TICKET_QUEUE_READ.key,
  HELPDESK_PERMISSIONS.SUPPORT_AGENT_READ.key,
  HELPDESK_PERMISSIONS.SLA_POLICY_READ.key,
  HELPDESK_PERMISSIONS.TICKET_READ.key,
  HELPDESK_PERMISSIONS.TICKET_COMMENT_READ.key,
];

const WRITE = [
  HELPDESK_PERMISSIONS.TICKET_QUEUE_CREATE.key,
  HELPDESK_PERMISSIONS.TICKET_QUEUE_UPDATE.key,
  HELPDESK_PERMISSIONS.SUPPORT_AGENT_CREATE.key,
  HELPDESK_PERMISSIONS.SUPPORT_AGENT_UPDATE.key,
  HELPDESK_PERMISSIONS.SLA_POLICY_CREATE.key,
  HELPDESK_PERMISSIONS.SLA_POLICY_UPDATE.key,
  HELPDESK_PERMISSIONS.TICKET_CREATE.key,
  HELPDESK_PERMISSIONS.TICKET_UPDATE.key,
  HELPDESK_PERMISSIONS.TICKET_COMMENT_CREATE.key,
  HELPDESK_PERMISSIONS.TICKET_COMMENT_UPDATE.key,
];

export const HELPDESK_PERMISSIONS_ROLES: Record<string, string[]> = {
  organization_owner: HELPDESK_PERMISSIONS_LIST.map((permission) => permission.key),
  administrator: [...READ_ONLY, ...WRITE],
  operator: [...READ_ONLY, ...WRITE],
  auditor: READ_ONLY,
};

export type TicketPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export const TICKET_PRIORITY_VALUES: TicketPriority[] = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export type TicketStatus = 'NEW' | 'OPEN' | 'PENDING' | 'RESOLVED' | 'CLOSED';
export const TICKET_STATUS_VALUES: TicketStatus[] = [
  'NEW',
  'OPEN',
  'PENDING',
  'RESOLVED',
  'CLOSED',
];
