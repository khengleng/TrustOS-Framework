/**
 * Product domain — TrustOS Telegram Mini App.
 *
 * Permission keys are namespaced and permanent: add keys freely, never rename
 * one.
 */

export interface ProductPermission {
  key: string;
  resource: string;
  action: string;
  description: string;
}

function define(key: string, description: string): ProductPermission {
  const segments = key.split('.');
  return {
    key,
    resource: segments.slice(0, -1).join('.'),
    action: segments[segments.length - 1] as string,
    description,
  };
}

export const MINIAPP_PERMISSIONS = {
  PROFILE_READ: define('miniapp.profile.read', 'View Telegram profiles.'),
  TASK_READ: define('miniapp.task.read', 'View tasks.'),
  TASK_CREATE: define('miniapp.task.create', 'Create a task.'),
  TASK_UPDATE: define('miniapp.task.update', 'Update a task.'),
} as const;

export const PRODUCT_PERMISSIONS: ProductPermission[] = Object.values(MINIAPP_PERMISSIONS);

const READ_ONLY = [MINIAPP_PERMISSIONS.PROFILE_READ.key, MINIAPP_PERMISSIONS.TASK_READ.key];

/**
 * Which framework roles receive which product permissions.
 *
 * A Mini App user acts as `operator`: they manage their own tasks but cannot
 * read the profile directory. `auditor` stays read-only.
 */
export const PRODUCT_ROLE_PERMISSIONS: Record<string, string[]> = {
  organization_owner: PRODUCT_PERMISSIONS.map((permission) => permission.key),
  administrator: PRODUCT_PERMISSIONS.map((permission) => permission.key),
  operator: [
    MINIAPP_PERMISSIONS.TASK_READ.key,
    MINIAPP_PERMISSIONS.TASK_CREATE.key,
    MINIAPP_PERMISSIONS.TASK_UPDATE.key,
  ],
  auditor: READ_ONLY,
};

export type TaskStatus = 'TODO' | 'DOING' | 'DONE';

export const TASK_STATUSES: TaskStatus[] = ['TODO', 'DOING', 'DONE'];
