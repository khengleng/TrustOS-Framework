import type { ResourceDefinition } from '@trustos/template-sdk';

/** Mini App console screens. */
export const RESOURCES: ResourceDefinition[] = [
  {
    key: 'tasks',
    label: 'Tasks',
    singular: 'Task',
    endpoint: '/tasks',
    description: 'The example feature. Replace it with your own before building for real.',
    table: {
      key: 'tasks',
      label: 'Tasks',
      endpoint: '/tasks',
      emptyHint: 'Create one with POST /api/tasks.',
      columns: [
        { key: 'title', label: 'Task' },
        { key: 'status', label: 'Status', format: 'badge' },
        { key: 'completedAt', label: 'Completed', format: 'datetime' },
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
    key: 'profiles',
    label: 'Telegram profiles',
    singular: 'Telegram profile',
    endpoint: '/miniapp/profiles',
    description: 'Telegram users who have launched the Mini App, linked to framework identities.',
    table: {
      key: 'profiles',
      label: 'Telegram profiles',
      endpoint: '/miniapp/profiles',
      emptyHint: 'A profile is created the first time someone opens the Mini App.',
      columns: [
        { key: 'username', label: 'Username' },
        { key: 'firstName', label: 'Name' },
        { key: 'telegramUserId', label: 'Telegram id' },
        { key: 'languageCode', label: 'Language', format: 'badge' },
        { key: 'lastSeenAt', label: 'Last seen', format: 'datetime' },
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
