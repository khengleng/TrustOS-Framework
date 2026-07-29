import type { ResourceDefinition } from './resource-types';

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
    endpoint: '/workspace-items',
    description: 'The example domain entity. Rename or replace it with your own.',
    emptyHint: 'Create one with POST /api/workspace-items.',
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'status', label: 'Status', badge: true },
      { key: 'createdAt', label: 'Created', date: true },
    ],
  },
];
