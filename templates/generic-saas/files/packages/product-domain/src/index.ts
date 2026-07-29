/**
 * Product domain — Generic SaaS.
 *
 * Permission keys are namespaced (`workspaceItem.*`) so they can never collide
 * with a framework key. They are part of the public contract: add keys freely,
 * never rename one — a renamed key silently grants or revokes access on every
 * deployment that has not been migrated.
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

export const WORKSPACE_ITEM_PERMISSIONS = {
  READ: define('workspaceItem.read', 'List and view workspace items.'),
  CREATE: define('workspaceItem.create', 'Create a workspace item.'),
  UPDATE: define('workspaceItem.update', 'Modify a workspace item.'),
  DELETE: define('workspaceItem.delete', 'Retire a workspace item.'),
} as const;

export const PRODUCT_PERMISSIONS: ProductPermission[] = Object.values(WORKSPACE_ITEM_PERMISSIONS);

/**
 * Which framework roles receive which product permissions, applied by the seed.
 *
 * Least privilege: `operator` and `auditor` get read only. `auditor` is a
 * read-only oversight role and must never gain a write permission here.
 */
export const PRODUCT_ROLE_PERMISSIONS: Record<string, string[]> = {
  organization_owner: PRODUCT_PERMISSIONS.map((permission) => permission.key),
  administrator: [
    WORKSPACE_ITEM_PERMISSIONS.READ.key,
    WORKSPACE_ITEM_PERMISSIONS.CREATE.key,
    WORKSPACE_ITEM_PERMISSIONS.UPDATE.key,
  ],
  operator: [WORKSPACE_ITEM_PERMISSIONS.READ.key],
  auditor: [WORKSPACE_ITEM_PERMISSIONS.READ.key],
};

export type WorkspaceItemStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

export const WORKSPACE_ITEM_STATUSES: WorkspaceItemStatus[] = ['DRAFT', 'ACTIVE', 'ARCHIVED'];
