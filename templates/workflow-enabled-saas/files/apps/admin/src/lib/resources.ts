import type { ResourceDefinition } from '@trustsystem/template-sdk';

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
    singular: 'Change request',
    endpoint: '/change-requests',
    table: {
      key: 'change-requests',
      label: 'Change requests',
      endpoint: '/change-requests',
      emptyHint: 'Create one with POST /api/change-requests.',
      columns: [
        { key: 'title', label: 'Title' },
        { key: 'amount', label: 'Amount' },
        { key: 'riskRating', label: 'Risk', format: 'badge' },
        { key: 'createdAt', label: 'Created', format: 'datetime' },
      ],
    },
    /*
     * A framework-backed screen: the guard lives on the endpoint it reads, not here.
     * `assertCan` refuses to route an action with no permission, so an empty record is
     * safe precisely because it makes every CRUD action unroutable.
     */
    permissions: {},
  },
  {
    key: 'workflow-instances',
    label: 'Workflow instances',
    singular: 'Workflow instance',
    endpoint: '/workflow/instances',
    description: 'Every governed process, with the state it is waiting in.',
    table: {
      key: 'workflow-instances',
      label: 'Workflow instances',
      endpoint: '/workflow/instances',
      emptyHint: 'A change request starts one when it is created.',
      columns: [
        { key: 'businessObjectId', label: 'Object' },
        { key: 'currentState', label: 'State', format: 'badge' },
        { key: 'status', label: 'Status', format: 'badge' },
        { key: 'workflowVersion', label: 'Version' },
        { key: 'startedAt', label: 'Started', format: 'datetime' },
      ],
    },
    /*
     * A framework-backed screen: the guard lives on the endpoint it reads, not here.
     * `assertCan` refuses to route an action with no permission, so an empty record is
     * safe precisely because it makes every CRUD action unroutable.
     */
    permissions: {},
  },
  {
    key: 'my-tasks',
    label: 'My tasks',
    singular: 'My task',
    endpoint: '/workflow/tasks/mine',
    description: 'Assigned to you, or claimed by you.',
    table: {
      key: 'my-tasks',
      label: 'My tasks',
      endpoint: '/workflow/tasks/mine',
      emptyHint: 'Nothing is waiting on you. Check the pool for unclaimed work.',
      columns: [
        { key: 'title', label: 'Task' },
        { key: 'stepKey', label: 'Step' },
        { key: 'status', label: 'Status', format: 'badge' },
        { key: 'dueAt', label: 'Due', format: 'datetime' },
      ],
    },
    /*
     * A framework-backed screen: the guard lives on the endpoint it reads, not here.
     * `assertCan` refuses to route an action with no permission, so an empty record is
     * safe precisely because it makes every CRUD action unroutable.
     */
    permissions: {},
  },
  {
    key: 'available-tasks',
    label: 'Available tasks',
    singular: 'Available task',
    endpoint: '/workflow/tasks/available',
    description: 'The pool: unclaimed tasks you are eligible for.',
    table: {
      key: 'available-tasks',
      label: 'Available tasks',
      endpoint: '/workflow/tasks/available',
      emptyHint: 'Nothing unclaimed that you can act on.',
      columns: [
        { key: 'title', label: 'Task' },
        { key: 'stepKey', label: 'Step' },
        { key: 'priority', label: 'Priority', format: 'badge' },
        { key: 'dueAt', label: 'Due', format: 'datetime' },
      ],
    },
    /*
     * A framework-backed screen: the guard lives on the endpoint it reads, not here.
     * `assertCan` refuses to route an action with no permission, so an empty record is
     * safe precisely because it makes every CRUD action unroutable.
     */
    permissions: {},
  },
  {
    key: 'overdue-tasks',
    label: 'Overdue',
    singular: 'Overdue',
    endpoint: '/workflow/tasks/overdue',
    description: 'Past a deadline and still open. A supervisor’s queue.',
    table: {
      key: 'overdue-tasks',
      label: 'Overdue',
      endpoint: '/workflow/tasks/overdue',
      emptyHint: 'Nothing is overdue.',
      columns: [
        { key: 'title', label: 'Task' },
        { key: 'assigneeUserId', label: 'Assignee' },
        { key: 'dueAt', label: 'Was due', format: 'datetime' },
        { key: 'slaStatus', label: 'SLA', format: 'badge' },
      ],
    },
    /*
     * A framework-backed screen: the guard lives on the endpoint it reads, not here.
     * `assertCan` refuses to route an action with no permission, so an empty record is
     * safe precisely because it makes every CRUD action unroutable.
     */
    permissions: {},
  },
  {
    key: 'workflow-definitions',
    label: 'Workflow definitions',
    singular: 'Workflow definition',
    endpoint: '/workflow/definitions',
    table: {
      key: 'workflow-definitions',
      label: 'Workflow definitions',
      endpoint: '/workflow/definitions',
      emptyHint: 'Publish one from workflows/ through POST /api/workflow/definitions/drafts.',
      columns: [
        { key: 'key', label: 'Key' },
        { key: 'name', label: 'Name' },
        { key: 'businessObjectType', label: 'Governs' },
      ],
    },
    /*
     * A framework-backed screen: the guard lives on the endpoint it reads, not here.
     * `assertCan` refuses to route an action with no permission, so an empty record is
     * safe precisely because it makes every CRUD action unroutable.
     */
    permissions: {},
  },
  {
    key: 'organizations',
    label: 'Organizations',
    singular: 'Organization',
    endpoint: '/organizations',
    description: 'Tenants. Every workflow instance belongs to exactly one.',
    table: {
      key: 'organizations',
      label: 'Organizations',
      endpoint: '/organizations',
      emptyHint: 'Seed one with npm run db:seed.',
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'slug', label: 'Slug' },
        { key: 'isActive', label: 'Active', format: 'badge' },
      ],
    },
    /*
     * A framework-backed screen: the guard lives on the endpoint it reads, not here.
     * `assertCan` refuses to route an action with no permission, so an empty record is
     * safe precisely because it makes every CRUD action unroutable.
     */
    permissions: {},
  },
];
