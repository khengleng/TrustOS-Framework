import type { ResourceDefinition } from '@trustsystem/template-sdk';

/**
 * Screens for this product.
 *
 * One generic page renders every entry, so adding an entity is a line here
 * rather than another near-identical page component — and every screen gets
 * the same loading, empty and error handling.
 */
export const RESOURCES: ResourceDefinition[] = [
  {
    key: 'workspace-items',
    label: 'Workspace items',
    singular: 'Workspace item',
    endpoint: '/workspace-items',
    description: 'The example domain entity. Rename or replace it with your own.',
    table: {
      key: 'workspace-items',
      label: 'Workspace items',
      endpoint: '/workspace-items',
      emptyHint: 'Create one with POST /api/workspace-items.',
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'description', label: 'Description' },
        { key: 'status', label: 'Status', format: 'badge' },
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
];
