import type { ResourceDefinition } from './resource-types';

/**
 * Screens for this product.
 *
 * One generic page renders every entry, so adding an entity is a line here rather than
 * another near-identical page component — and every screen gets the same loading, empty and
 * error handling.
 *
 * The workflow screens are read-only on purpose. Approving from a list is how somebody
 * approves the wrong thing: the decision needs the request in front of it, its evidence, and
 * the comments explaining why it came back. A console that offered an Approve button next to
 * a row would be optimising for the wrong step.
 */
export const RESOURCES: ResourceDefinition[] = [
  {
    key: 'change-requests',
    label: 'Change requests',
    endpoint: '/change-requests',
    description:
      'The example business object. An amount and a risk rating — rename or replace it with ' +
      'your own.',
    emptyHint: 'Create one with POST /api/change-requests.',
    columns: [
      { key: 'title', label: 'Title' },
      { key: 'amount', label: 'Amount' },
      { key: 'riskRating', label: 'Risk', badge: true },
      { key: 'createdAt', label: 'Created', date: true },
    ],
  },
  {
    key: 'workflow-instances',
    label: 'Workflow instances',
    endpoint: '/workflow/instances',
    description: 'Every governed process, with the state it is waiting in.',
    emptyHint: 'A change request starts one when it is created.',
    columns: [
      { key: 'businessObjectId', label: 'Object' },
      { key: 'currentState', label: 'State', badge: true },
      { key: 'status', label: 'Status', badge: true },
      { key: 'workflowVersion', label: 'Version' },
      { key: 'startedAt', label: 'Started', date: true },
    ],
  },
  {
    key: 'my-tasks',
    label: 'My tasks',
    endpoint: '/workflow/tasks/mine',
    description: 'Assigned to you, or claimed by you.',
    emptyHint: 'Nothing is waiting on you. Check the pool for unclaimed work.',
    columns: [
      { key: 'title', label: 'Task' },
      { key: 'stepKey', label: 'Step' },
      { key: 'status', label: 'Status', badge: true },
      { key: 'dueAt', label: 'Due', date: true },
    ],
  },
  {
    key: 'available-tasks',
    label: 'Available tasks',
    endpoint: '/workflow/tasks/available',
    description: 'The pool: unclaimed tasks you are eligible for.',
    emptyHint: 'Nothing unclaimed that you can act on.',
    columns: [
      { key: 'title', label: 'Task' },
      { key: 'stepKey', label: 'Step' },
      { key: 'priority', label: 'Priority', badge: true },
      { key: 'dueAt', label: 'Due', date: true },
    ],
  },
  {
    key: 'overdue-tasks',
    label: 'Overdue',
    endpoint: '/workflow/tasks/overdue',
    description: 'Past a deadline and still open. A supervisor’s queue.',
    emptyHint: 'Nothing is overdue.',
    columns: [
      { key: 'title', label: 'Task' },
      { key: 'assigneeUserId', label: 'Assignee' },
      { key: 'dueAt', label: 'Was due', date: true },
      { key: 'slaStatus', label: 'SLA', badge: true },
    ],
  },
  {
    key: 'workflow-definitions',
    label: 'Workflow definitions',
    endpoint: '/workflow/definitions',
    description:
      'The governed processes themselves. A published version is immutable — a change is a ' +
      'new version.',
    emptyHint: 'Publish one from workflows/ through POST /api/workflow/definitions/drafts.',
    columns: [
      { key: 'key', label: 'Key' },
      { key: 'name', label: 'Name' },
      { key: 'businessObjectType', label: 'Governs' },
    ],
  },
  {
    key: 'organizations',
    label: 'Organizations',
    endpoint: '/organizations',
    description: 'Tenants. Every workflow instance belongs to exactly one.',
    emptyHint: 'Seed one with npm run db:seed.',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'slug', label: 'Slug' },
      { key: 'isActive', label: 'Active', badge: true },
    ],
  },
];
