/**
 * Financial product permissions.
 *
 * Declared here rather than in `@trustos/rbac` for the reason `@trustos/workflow-core` gives:
 * these are the product layer's vocabulary, and the RBAC package should not have to know that a
 * product composer exists. `registerFinancialProductPermissions` merges them into an
 * application's catalog.
 *
 * The splits are the whole design, and each one exists because collapsing it removes a control:
 *
 *   * `create`, `submit`, `approve` and `publish` are four keys held by four people. A single
 *     `financial.product.write` would let an author carry their own product to production, which
 *     is precisely what maker-checker exists to prevent.
 *   * `fee.update`, `limit.update`, `provider.update` and `rule.update` are separate from
 *     `update`. They are the four changes that alter money, exposure, counterparty and routing
 *     without altering the workflow — and they are the four an attacker with product-editor
 *     access would reach for. Section 18 of the specification requires maker-checker on each.
 *   * `execute` is not `read`. A channel calling the exposed product API needs to run a product;
 *     it never needs to read the composition, and a credential that can read every product's fee
 *     schedule is a credential that leaks the commercial model.
 *
 * Keys are permanent. Add freely; never rename — a renamed key silently revokes access on every
 * deployment that has not been migrated and grants it on none.
 */

export interface FinancialProductPermissionDefinition {
  key: string;
  resource: string;
  action: string;
  description: string;
}

function define(key: string, description: string): FinancialProductPermissionDefinition {
  const segments = key.split('.');
  const action = segments[segments.length - 1] as string;
  return { key, resource: segments.slice(0, -1).join('.'), action, description };
}

export const FINANCIAL_PRODUCT_PERMISSIONS = {
  // --- composition ---------------------------------------------------------
  PRODUCT_READ: define('financial.product.read', 'View product definitions, versions and catalog entries.'),
  PRODUCT_CREATE: define('financial.product.create', 'Create a draft product or a new draft version.'),
  PRODUCT_UPDATE: define('financial.product.update', 'Edit a draft product definition.'),
  PRODUCT_VALIDATE: define('financial.product.validate', 'Run the static validation suite over a draft.'),

  // --- the four changes that move money ------------------------------------
  PRODUCT_FEE_UPDATE: define('financial.product.fee.update', 'Change a product’s fee configuration.'),
  PRODUCT_LIMIT_UPDATE: define('financial.product.limit.update', 'Change a product’s limit configuration.'),
  PRODUCT_PROVIDER_UPDATE: define(
    'financial.product.provider.update',
    'Change which provider interface or connector a product binds to.',
  ),
  PRODUCT_RULE_UPDATE: define('financial.product.rule.update', 'Change a product’s rules.'),

  // --- governance ----------------------------------------------------------
  PRODUCT_SUBMIT: define('financial.product.submit', 'Submit a product for independent approval.'),
  /** Deliberately not held by an author's role. See docs/product-governance.md. */
  PRODUCT_APPROVE: define(
    'financial.product.approve',
    'Approve or reject a product somebody else composed.',
  ),
  PRODUCT_PUBLISH: define(
    'financial.product.publish',
    'Stage or activate an approved product version, making it reachable.',
  ),
  PRODUCT_PAUSE: define('financial.product.pause', 'Withdraw a live product from new transactions.'),
  PRODUCT_ROLLBACK: define(
    'financial.product.rollback',
    'Activate a previously approved version in place of the current one.',
  ),
  PRODUCT_DEPRECATE: define('financial.product.deprecate', 'Mark a product version superseded.'),
  PRODUCT_RETIRE: define('financial.product.retire', 'Close a deprecated product version.'),

  // --- variants ------------------------------------------------------------
  VARIANT_READ: define('financial.product.variant.read', 'View product variants and their overrides.'),
  VARIANT_MANAGE: define(
    'financial.product.variant.manage',
    'Create or change a variant’s override configuration.',
  ),

  // --- exercise ------------------------------------------------------------
  PRODUCT_SANDBOX: define('financial.product.sandbox', 'Run a product against mock providers.'),
  PRODUCT_SIMULATE: define('financial.product.simulate', 'Run a volume simulation over a product.'),
  PRODUCT_EXECUTE: define(
    'financial.product.execute',
    'Start a transaction on an active product through its exposed API.',
  ),
  EXECUTION_READ: define('financial.product.execution.read', 'View product executions and their steps.'),

  // --- blocks and connectors ----------------------------------------------
  BLOCK_READ: define('financial.block.read', 'View the approved financial block catalog.'),
  BLOCK_MANAGE: define(
    'financial.block.manage',
    'Change a block’s lifecycle status in the approved catalog.',
  ),
  CONNECTOR_READ: define('financial.connector.read', 'View approved connectors and their metadata.'),
  CONNECTOR_MANAGE: define(
    'financial.connector.manage',
    'Register or change a connector’s configuration, timeout or retry policy.',
  ),

  // --- reference data ------------------------------------------------------
  REFERENCE_READ: define('financial.reference.read', 'View centrally governed reference data.'),
  REFERENCE_MANAGE: define('financial.reference.manage', 'Add or deprecate a reference data code.'),
} as const;

export type FinancialProductPermissionKey =
  (typeof FINANCIAL_PRODUCT_PERMISSIONS)[keyof typeof FINANCIAL_PRODUCT_PERMISSIONS]['key'];

/**
 * The permissions no author's role should hold alongside the authoring ones.
 *
 * Exported as data so an application can *assert* the separation rather than describe it in a
 * runbook. A role holding both `create` and `approve` is a maker-checker configuration that
 * passes every test and controls nothing, and the only way anybody notices is a check like this
 * one running over the seeded roles.
 */
export const SEGREGATED_PERMISSION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_CREATE.key, FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_APPROVE.key],
  [FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_UPDATE.key, FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_APPROVE.key],
  [FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_SUBMIT.key, FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_APPROVE.key],
  [FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_APPROVE.key, FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_PUBLISH.key],
];

/** The keys a role holding this permission set would violate segregation by combining. */
export function segregationViolations(held: readonly string[]): Array<readonly [string, string]> {
  const set = new Set(held);
  return SEGREGATED_PERMISSION_PAIRS.filter(([left, right]) => set.has(left) && set.has(right));
}

/** Merges the catalog into an application's permission map. */
export function registerFinancialProductPermissions<
  T extends Record<string, FinancialProductPermissionDefinition>,
>(catalog: T): T & typeof FINANCIAL_PRODUCT_PERMISSIONS {
  return { ...catalog, ...FINANCIAL_PRODUCT_PERMISSIONS };
}

export const FINANCIAL_PRODUCT_PERMISSION_LIST: FinancialProductPermissionDefinition[] =
  Object.values(FINANCIAL_PRODUCT_PERMISSIONS);
