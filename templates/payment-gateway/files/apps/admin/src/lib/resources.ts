import type { ResourceDefinition } from './resource-types';

/** Payment gateway console screens. */
export const RESOURCES: ResourceDefinition[] = [
  {
    key: 'merchant-accounts',
    label: 'Merchant accounts',
    endpoint: '/merchant-accounts',
    description: 'Merchant accounts held with the gateway.',
    emptyHint: 'Create one with POST /api/merchant-accounts.',
    columns: [
      { key: 'displayName', label: 'Account' },
      { key: 'reference', label: 'Reference' },
      { key: 'status', label: 'Status', badge: true },
      { key: 'defaultCurrency', label: 'Currency', badge: true },
      { key: 'createdAt', label: 'Created', date: true },
    ],
  },
  {
    key: 'payments',
    label: 'Payments',
    endpoint: '/payments',
    description: 'Amounts are minor units — 1050 USD means $10.50.',
    emptyHint: 'Create one with POST /api/payments.',
    columns: [
      { key: 'reference', label: 'Reference' },
      { key: 'amountMinor', label: 'Amount (minor)' },
      { key: 'currency', label: 'Currency', badge: true },
      { key: 'status', label: 'Status', badge: true },
      { key: 'createdAt', label: 'Created', date: true },
    ],
  },
  {
    key: 'api-keys',
    label: 'API keys',
    endpoint: '/api-keys',
    description:
      'Only a display prefix is ever shown. The key itself is stored as a hash and cannot be recovered.',
    emptyHint: 'Issue one with POST /api/api-keys.',
    columns: [
      { key: 'label', label: 'Label' },
      { key: 'keyPrefix', label: 'Prefix' },
      { key: 'lastUsedAt', label: 'Last used', date: true },
      { key: 'revokedAt', label: 'Revoked', date: true },
      { key: 'createdAt', label: 'Issued', date: true },
    ],
  },
  {
    key: 'webhook-endpoints',
    label: 'Webhooks',
    endpoint: '/webhook-endpoints',
    description: 'Where events will be delivered once delivery is implemented.',
    emptyHint: 'Register one with POST /api/webhook-endpoints.',
    columns: [
      { key: 'url', label: 'URL' },
      { key: 'isActive', label: 'Active', badge: true },
      { key: 'createdAt', label: 'Registered', date: true },
    ],
  },
];
