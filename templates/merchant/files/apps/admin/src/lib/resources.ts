import type { ResourceDefinition } from './resource-types';

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
    endpoint: '/merchants',
    description: 'Merchant businesses operating under this organization.',
    emptyHint: 'Register one with POST /api/merchants.',
    columns: [
      { key: 'name', label: 'Merchant' },
      { key: 'code', label: 'Code' },
      { key: 'status', label: 'Status', badge: true },
      { key: 'contactEmail', label: 'Contact' },
      { key: 'createdAt', label: 'Registered', date: true },
    ],
  },
  {
    key: 'stores',
    label: 'Stores',
    endpoint: '/stores',
    description: 'Storefronts belonging to a merchant.',
    emptyHint: 'Create one with POST /api/stores.',
    columns: [
      { key: 'name', label: 'Store' },
      { key: 'code', label: 'Code' },
      { key: 'status', label: 'Status', badge: true },
      { key: 'timezone', label: 'Timezone' },
      { key: 'createdAt', label: 'Created', date: true },
    ],
  },
  {
    key: 'branches',
    label: 'Branches',
    endpoint: '/branches',
    description: 'Physical locations of a store.',
    emptyHint: 'Create one with POST /api/branches.',
    columns: [
      { key: 'name', label: 'Branch' },
      { key: 'code', label: 'Code' },
      { key: 'city', label: 'City' },
      { key: 'isActive', label: 'Active', badge: true },
      { key: 'createdAt', label: 'Created', date: true },
    ],
  },
  {
    key: 'merchant-members',
    label: 'Members',
    endpoint: '/merchant-members',
    description: 'People acting on behalf of a merchant. Authorization comes from framework RBAC.',
    emptyHint: 'Add one with POST /api/merchant-members.',
    columns: [
      { key: 'userId', label: 'User' },
      { key: 'position', label: 'Position' },
      { key: 'isPrimary', label: 'Primary', badge: true },
      { key: 'createdAt', label: 'Added', date: true },
    ],
  },
];
