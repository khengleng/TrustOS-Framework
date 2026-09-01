import { MERCHANT_ROLES, ROLE_CAPABILITIES, type MerchantRole } from './domain/merchant';

/**
 * The pilot's application permissions.
 *
 * Nineteen keys, and they are the *only* thing the pilot adds to the framework's authorization
 * model. There is no second permission system, no per-merchant ACL and no bespoke role engine —
 * `@trustsystem/rbac` checks these exactly as it checks its own.
 *
 * That is the point of counting them. Nineteen permissions and one role map is roughly the
 * irreducible application-specific part of a payment acceptance product; anything more would mean
 * the pilot had rebuilt something the framework already provides, which is what the framework
 * reuse report measures.
 */

export interface PilotPermission {
  key: string;
  description: string;
}

const define = (key: string, description: string): PilotPermission => ({ key, description });

export const PILOT_PERMISSIONS = {
  // --- merchant lifecycle ---------------------------------------------------
  MERCHANT_READ: define('mwb.merchant.read', 'Read merchant records.'),
  MERCHANT_REGISTER: define('mwb.merchant.register', 'Register a merchant.'),
  MERCHANT_VERIFY: define('mwb.merchant.verify', 'Record that a merchant has been verified.'),
  /** Never held with MERCHANT_VERIFY. The checker to verification's maker. */
  MERCHANT_APPROVE: define('mwb.merchant.approve', 'Approve a merchant somebody else verified.'),
  MERCHANT_REJECT: define('mwb.merchant.reject', 'Reject a merchant, with a reason.'),
  MERCHANT_SUSPEND: define('mwb.merchant.suspend', 'Suspend an approved merchant.'),

  // --- wallets --------------------------------------------------------------
  WALLET_READ: define('mwb.wallet.read', 'Read wallet balances and history.'),
  WALLET_CREATE: define('mwb.wallet.create', 'Create a wallet for an approved merchant.'),
  WALLET_FREEZE: define('mwb.wallet.freeze', 'Freeze a wallet.'),
  WALLET_UNFREEZE: define('mwb.wallet.unfreeze', 'Unfreeze a wallet.'),

  // --- payments -------------------------------------------------------------
  PAYMENT_ACCEPT: define('mwb.payment.accept', 'Accept a payment at a branch.'),
  PAYMENT_READ: define('mwb.payment.read', 'Read payment records.'),
  PAYMENT_REFUND: define('mwb.payment.refund', 'Refund a payment.'),

  // --- limits and configuration ---------------------------------------------
  LIMIT_READ: define('mwb.limit.read', 'Read the limits applying to a merchant.'),
  LIMIT_REQUEST_CHANGE: define('mwb.limit.request_change', 'Request a limit change.'),
  /** Never held with LIMIT_REQUEST_CHANGE. */
  LIMIT_APPROVE_CHANGE: define(
    'mwb.limit.approve_change',
    'Approve a limit change somebody else requested.',
  ),

  // --- settlement and reporting ---------------------------------------------
  SETTLEMENT_READ: define('mwb.settlement.read', 'Read settlement batches and reconciliation.'),
  LEDGER_READ: define('mwb.ledger.read', 'Read the journal behind a payment.'),
  REPORT_READ: define('mwb.report.read', 'Read merchant reports.'),
} as const;

export const ALL_PILOT_PERMISSIONS: readonly PilotPermission[] = Object.freeze(
  Object.values(PILOT_PERMISSIONS),
);

/**
 * What each merchant role holds.
 *
 * Two properties are asserted by the pilot's tests rather than trusted:
 *
 * **No role holds both halves of a maker-checker pair.** Verify and approve, request and approve a
 * limit change. A role holding both collapses the control, and the collapse is invisible in a
 * grant list because both halves sound like the same job.
 *
 * **`auditor` holds no write permission.** Not one. An audit role that can change something can
 * change what it audits, and this is the role most often given a write permission "so they can
 * annotate".
 */
export const ROLE_PERMISSIONS: Record<MerchantRole, readonly string[]> = {
  merchant_owner: [
    PILOT_PERMISSIONS.MERCHANT_READ.key,
    PILOT_PERMISSIONS.WALLET_READ.key,
    PILOT_PERMISSIONS.PAYMENT_ACCEPT.key,
    PILOT_PERMISSIONS.PAYMENT_READ.key,
    PILOT_PERMISSIONS.PAYMENT_REFUND.key,
    PILOT_PERMISSIONS.LIMIT_READ.key,
    PILOT_PERMISSIONS.LIMIT_REQUEST_CHANGE.key,
    PILOT_PERMISSIONS.SETTLEMENT_READ.key,
    PILOT_PERMISSIONS.REPORT_READ.key,
  ],
  merchant_manager: [
    PILOT_PERMISSIONS.MERCHANT_READ.key,
    PILOT_PERMISSIONS.WALLET_READ.key,
    PILOT_PERMISSIONS.PAYMENT_ACCEPT.key,
    PILOT_PERMISSIONS.PAYMENT_READ.key,
    PILOT_PERMISSIONS.PAYMENT_REFUND.key,
    PILOT_PERMISSIONS.LIMIT_READ.key,
    PILOT_PERMISSIONS.REPORT_READ.key,
  ],
  cashier: [
    // Deliberately narrow: take payments, see what was taken. No settlement, no ledger, no limits.
    PILOT_PERMISSIONS.PAYMENT_ACCEPT.key,
    PILOT_PERMISSIONS.PAYMENT_READ.key,
  ],
  finance: [
    PILOT_PERMISSIONS.MERCHANT_READ.key,
    PILOT_PERMISSIONS.WALLET_READ.key,
    PILOT_PERMISSIONS.PAYMENT_READ.key,
    PILOT_PERMISSIONS.SETTLEMENT_READ.key,
    PILOT_PERMISSIONS.LEDGER_READ.key,
    PILOT_PERMISSIONS.REPORT_READ.key,
    // Approves limit changes; does not request them.
    PILOT_PERMISSIONS.LIMIT_APPROVE_CHANGE.key,
    PILOT_PERMISSIONS.LIMIT_READ.key,
  ],
  operations: [
    PILOT_PERMISSIONS.MERCHANT_READ.key,
    PILOT_PERMISSIONS.MERCHANT_REGISTER.key,
    PILOT_PERMISSIONS.MERCHANT_VERIFY.key,
    PILOT_PERMISSIONS.MERCHANT_REJECT.key,
    PILOT_PERMISSIONS.WALLET_READ.key,
    PILOT_PERMISSIONS.WALLET_CREATE.key,
    PILOT_PERMISSIONS.WALLET_FREEZE.key,
    PILOT_PERMISSIONS.PAYMENT_READ.key,
    PILOT_PERMISSIONS.LIMIT_READ.key,
    PILOT_PERMISSIONS.LIMIT_REQUEST_CHANGE.key,
    PILOT_PERMISSIONS.REPORT_READ.key,
  ],
  auditor: [
    // Every read. No write, anywhere.
    PILOT_PERMISSIONS.MERCHANT_READ.key,
    PILOT_PERMISSIONS.WALLET_READ.key,
    PILOT_PERMISSIONS.PAYMENT_READ.key,
    PILOT_PERMISSIONS.LIMIT_READ.key,
    PILOT_PERMISSIONS.SETTLEMENT_READ.key,
    PILOT_PERMISSIONS.LEDGER_READ.key,
    PILOT_PERMISSIONS.REPORT_READ.key,
  ],
};

/**
 * The pairs the pilot's maker-checker rests on.
 *
 * `MERCHANT_APPROVE` and `LIMIT_APPROVE_CHANGE` are held by roles that hold neither of the
 * corresponding maker permissions — an operations *manager* role a deployment defines, not by any
 * of the six merchant roles above. That is why `merchant_approve` appears in no row.
 */
export const SEGREGATED_PAIRS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  [PILOT_PERMISSIONS.MERCHANT_VERIFY.key, PILOT_PERMISSIONS.MERCHANT_APPROVE.key],
  [PILOT_PERMISSIONS.MERCHANT_REGISTER.key, PILOT_PERMISSIONS.MERCHANT_APPROVE.key],
  [PILOT_PERMISSIONS.LIMIT_REQUEST_CHANGE.key, PILOT_PERMISSIONS.LIMIT_APPROVE_CHANGE.key],
]);

/** Permissions that change something. Used to assert `auditor` holds none of them. */
export const WRITE_PERMISSIONS: readonly string[] = Object.freeze([
  PILOT_PERMISSIONS.MERCHANT_REGISTER.key,
  PILOT_PERMISSIONS.MERCHANT_VERIFY.key,
  PILOT_PERMISSIONS.MERCHANT_APPROVE.key,
  PILOT_PERMISSIONS.MERCHANT_REJECT.key,
  PILOT_PERMISSIONS.MERCHANT_SUSPEND.key,
  PILOT_PERMISSIONS.WALLET_CREATE.key,
  PILOT_PERMISSIONS.WALLET_FREEZE.key,
  PILOT_PERMISSIONS.WALLET_UNFREEZE.key,
  PILOT_PERMISSIONS.PAYMENT_ACCEPT.key,
  PILOT_PERMISSIONS.PAYMENT_REFUND.key,
  PILOT_PERMISSIONS.LIMIT_REQUEST_CHANGE.key,
  PILOT_PERMISSIONS.LIMIT_APPROVE_CHANGE.key,
]);

export function segregationViolations(
  roles: ReadonlyArray<{ name: string; permissions: readonly string[] }>,
): Array<{ role: string; pair: readonly [string, string] }> {
  const violations: Array<{ role: string; pair: readonly [string, string] }> = [];

  for (const role of roles) {
    const held = new Set(role.permissions);
    for (const pair of SEGREGATED_PAIRS) {
      if (held.has(pair[0]) && held.has(pair[1])) violations.push({ role: role.name, pair });
    }
  }

  return violations;
}

/** The six merchant roles as the segregation check expects them. */
export function merchantRoleGrants(): Array<{ name: string; permissions: readonly string[] }> {
  return MERCHANT_ROLES.map((role) => ({ name: role, permissions: ROLE_PERMISSIONS[role] }));
}

/** Whether a role's declared capability matches the permissions it actually holds. */
export function capabilityMatchesGrant(role: MerchantRole): boolean {
  const held = new Set(ROLE_PERMISSIONS[role]);
  const writes = WRITE_PERMISSIONS.some((permission) => held.has(permission));
  return writes === ROLE_CAPABILITIES[role].writes;
}
