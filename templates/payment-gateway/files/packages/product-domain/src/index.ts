/**
 * Product domain — TrustOS Payment Gateway.
 *
 * Permission keys are namespaced and permanent: add keys freely, never rename
 * one. In a payments product a renamed key is worse than elsewhere, because
 * the thing it guards moves money.
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

export const GATEWAY_PERMISSIONS = {
  ACCOUNT_READ: define('gateway.account.read', 'View merchant accounts.'),
  ACCOUNT_CREATE: define('gateway.account.create', 'Create a merchant account.'),
  ACCOUNT_UPDATE: define('gateway.account.update', 'Change a merchant account status.'),

  APIKEY_READ: define('gateway.apiKey.read', 'List API keys (never their values).'),
  APIKEY_ISSUE: define('gateway.apiKey.issue', 'Issue a new API key.'),
  APIKEY_REVOKE: define('gateway.apiKey.revoke', 'Revoke an API key.'),

  PAYMENT_READ: define('gateway.payment.read', 'View payments.'),
  PAYMENT_CREATE: define('gateway.payment.create', 'Create a payment.'),
  PAYMENT_TRANSITION: define('gateway.payment.transition', 'Move a payment between states.'),

  WEBHOOK_READ: define('gateway.webhook.read', 'View webhook endpoints.'),
  WEBHOOK_MANAGE: define('gateway.webhook.manage', 'Register or disable webhook endpoints.'),
} as const;

export const PRODUCT_PERMISSIONS: ProductPermission[] = Object.values(GATEWAY_PERMISSIONS);

const READ_ONLY = [
  GATEWAY_PERMISSIONS.ACCOUNT_READ.key,
  GATEWAY_PERMISSIONS.APIKEY_READ.key,
  GATEWAY_PERMISSIONS.PAYMENT_READ.key,
  GATEWAY_PERMISSIONS.WEBHOOK_READ.key,
];

/**
 * Which framework roles receive which product permissions.
 *
 * Credential issuance is the sharpest privilege here, so `apiKey.issue` is
 * restricted to the owner: anyone who can mint a key can transact as the
 * merchant. `operator` can move payments through their lifecycle but cannot
 * create credentials or change account status. `auditor` is read-only.
 */
export const PRODUCT_ROLE_PERMISSIONS: Record<string, string[]> = {
  organization_owner: PRODUCT_PERMISSIONS.map((permission) => permission.key),
  administrator: [
    ...READ_ONLY,
    GATEWAY_PERMISSIONS.ACCOUNT_CREATE.key,
    GATEWAY_PERMISSIONS.ACCOUNT_UPDATE.key,
    GATEWAY_PERMISSIONS.APIKEY_REVOKE.key,
    GATEWAY_PERMISSIONS.PAYMENT_CREATE.key,
    GATEWAY_PERMISSIONS.PAYMENT_TRANSITION.key,
    GATEWAY_PERMISSIONS.WEBHOOK_MANAGE.key,
  ],
  operator: [
    ...READ_ONLY,
    GATEWAY_PERMISSIONS.PAYMENT_CREATE.key,
    GATEWAY_PERMISSIONS.PAYMENT_TRANSITION.key,
  ],
  auditor: READ_ONLY,
};

export type PaymentStatus =
  'CREATED' | 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'CANCELLED';

/**
 * The payment state machine.
 *
 * Declared as data rather than as `if` statements so it can be asserted in a
 * test and read by a reviewer. A payment that could move from CAPTURED back to
 * PENDING would make every downstream reconciliation unreliable, so terminal
 * states have no outgoing transitions.
 */
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  CREATED: ['PENDING', 'CANCELLED', 'FAILED'],
  PENDING: ['AUTHORIZED', 'FAILED', 'CANCELLED'],
  AUTHORIZED: ['CAPTURED', 'CANCELLED', 'FAILED'],
  CAPTURED: [],
  FAILED: [],
  CANCELLED: [],
};

export const TERMINAL_PAYMENT_STATUSES: PaymentStatus[] = ['CAPTURED', 'FAILED', 'CANCELLED'];

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

/** Supported currencies. Minor-unit maths assumes two decimal places. */
export const SUPPORTED_CURRENCIES = ['USD', 'KHR'] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
