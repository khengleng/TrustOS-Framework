import type { ResourceDefinition } from './resource-types';

/** Mini App console screens. */
export const RESOURCES: ResourceDefinition[] = [
  {
    key: 'tasks',
    label: 'Tasks',
    endpoint: '/tasks',
    description: 'The example feature. Replace it with your own before building for real.',
    emptyHint: 'Create one with POST /api/tasks.',
    columns: [
      { key: 'title', label: 'Task' },
      { key: 'status', label: 'Status', badge: true },
      { key: 'completedAt', label: 'Completed', date: true },
      { key: 'createdAt', label: 'Created', date: true },
    ],
  },
  {
    key: 'profiles',
    label: 'Telegram profiles',
    endpoint: '/miniapp/profiles',
    description: 'Telegram users who have launched the Mini App, linked to framework identities.',
    emptyHint: 'A profile is created the first time someone opens the Mini App.',
    columns: [
      { key: 'username', label: 'Username' },
      { key: 'firstName', label: 'Name' },
      { key: 'telegramUserId', label: 'Telegram id' },
      { key: 'languageCode', label: 'Language', badge: true },
      { key: 'lastSeenAt', label: 'Last seen', date: true },
    ],
  },
];
