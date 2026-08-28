/**
 * Product permission catalog.
 *
 * Products namespace their own keys (`widget.*`) rather than reusing framework
 * keys. Seed these into the `Permission` table and attach them to roles the
 * same way `packages/database/prisma/seed.ts` does for framework permissions.
 */
export const WIDGET_PERMISSIONS = {
  READ: 'widget.read',
  CREATE: 'widget.create',
  DELETE: 'widget.delete',
} as const;

export const WIDGET_PERMISSION_DEFINITIONS = [
  {
    key: WIDGET_PERMISSIONS.READ,
    resource: 'widget',
    action: 'read',
    description: 'List widgets.',
  },
  {
    key: WIDGET_PERMISSIONS.CREATE,
    resource: 'widget',
    action: 'create',
    description: 'Create a widget.',
  },
  {
    key: WIDGET_PERMISSIONS.DELETE,
    resource: 'widget',
    action: 'delete',
    description: 'Delete a widget.',
  },
];
