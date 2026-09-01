import type { ResourceDefinition } from '@trustsystem/template-sdk';

/**
 * Merchant console screens.
 *
 * One generic page renders every entry, so adding a screen is a line here
 * rather than another near-identical page component.
 */
export const RESOURCES: ResourceDefinition[] = [
  {
    key: 'merchants',
    label: 'Merchants',
    singular: 'Merchant',
    endpoint: '/merchants',
    description: 'Merchant businesses operating under this organization.',
    table: {
      key: 'merchants',
      label: 'Merchants',
      endpoint: '/merchants',
      emptyHint: 'Register one with POST /api/merchants.',
      columns: [
        { key: 'name', label: 'Merchant' },
        { key: 'code', label: 'Code' },
        { key: 'status', label: 'Status', format: 'badge' },
        { key: 'contactEmail', label: 'Contact' },
        { key: 'createdAt', label: 'Registered', format: 'datetime' },
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
    key: 'stores',
    label: 'Stores',
    singular: 'Store',
    endpoint: '/stores',
    description: 'Storefronts belonging to a merchant.',
    table: {
      key: 'stores',
      label: 'Stores',
      endpoint: '/stores',
      emptyHint: 'Create one with POST /api/stores.',
      columns: [
        { key: 'name', label: 'Store' },
        { key: 'code', label: 'Code' },
        { key: 'status', label: 'Status', format: 'badge' },
        { key: 'timezone', label: 'Timezone' },
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
    key: 'branches',
    label: 'Branches',
    singular: 'Branche',
    endpoint: '/branches',
    description: 'Physical locations of a store.',
    table: {
      key: 'branches',
      label: 'Branches',
      endpoint: '/branches',
      emptyHint: 'Create one with POST /api/branches.',
      columns: [
        { key: 'name', label: 'Branch' },
        { key: 'code', label: 'Code' },
        { key: 'city', label: 'City' },
        { key: 'isActive', label: 'Active', format: 'badge' },
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
    key: 'merchant-members',
    label: 'Members',
    singular: 'Member',
    endpoint: '/merchant-members',
    description: 'People acting on behalf of a merchant. Authorization comes from framework RBAC.',
    table: {
      key: 'merchant-members',
      label: 'Members',
      endpoint: '/merchant-members',
      emptyHint: 'Add one with POST /api/merchant-members.',
      columns: [
        { key: 'userId', label: 'User' },
        { key: 'position', label: 'Position' },
        { key: 'isPrimary', label: 'Primary', format: 'badge' },
        { key: 'createdAt', label: 'Added', format: 'datetime' },
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
