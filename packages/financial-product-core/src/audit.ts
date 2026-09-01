/**
 * The audit and event catalogs.
 *
 * Two lists, and the split matters more than either list. **Audit** is what a customer or a
 * regulator must be able to reconstruct: who changed the fee, who approved the product, who
 * rolled it back. **Events** are what other systems react to: a transaction completed, a
 * settlement window closed. The same occurrence often produces one of each, and they have
 * different audiences, different retention and different sensitivity.
 *
 * Section 27 of the specification lists sixteen auditable actions. This is those sixteen plus
 * the ones the runtime produces, because a governance trail that records every product change
 * and no execution refusal answers "who changed the limit" and not "why was this transaction
 * declined" — and the second question is the one a customer asks.
 *
 * Names are stable. They are queried by auditors and alerted on by operations, so a rename is a
 * silent break in somebody's saved search.
 */

export const PRODUCT_AUDIT_ACTIONS = {
  // --- composition ---------------------------------------------------------
  PRODUCT_CREATED: 'financial.product.created',
  PRODUCT_EDITED: 'financial.product.edited',
  RULE_CHANGED: 'financial.product.rule.changed',
  FEE_CHANGED: 'financial.product.fee.changed',
  LIMIT_CHANGED: 'financial.product.limit.changed',
  PROVIDER_CHANGED: 'financial.product.provider.changed',
  VARIANT_CHANGED: 'financial.product.variant.changed',

  // --- governance ----------------------------------------------------------
  PRODUCT_SUBMITTED: 'financial.product.submitted',
  PRODUCT_APPROVED: 'financial.product.approved',
  PRODUCT_REJECTED: 'financial.product.rejected',
  PRODUCT_STAGED: 'financial.product.staged',
  PRODUCT_ACTIVATED: 'financial.product.activated',
  PRODUCT_PAUSED: 'financial.product.paused',
  PRODUCT_ROLLED_BACK: 'financial.product.rolled_back',
  PRODUCT_DEPRECATED: 'financial.product.deprecated',
  VERSION_RETIRED: 'financial.product.version.retired',

  // --- exercise ------------------------------------------------------------
  SANDBOX_RUN: 'financial.product.sandbox.run',
  SIMULATION_EXECUTED: 'financial.product.simulation.executed',

  // --- catalog -------------------------------------------------------------
  CONNECTOR_CHANGED: 'financial.connector.changed',
  BLOCK_STATUS_CHANGED: 'financial.block.status.changed',
  REFERENCE_CHANGED: 'financial.reference.changed',

  // --- runtime -------------------------------------------------------------
  EXECUTION_STARTED: 'financial.product.execution.started',
  EXECUTION_COMPLETED: 'financial.product.execution.completed',
  EXECUTION_FAILED: 'financial.product.execution.failed',
  EXECUTION_REFUSED: 'financial.product.execution.refused',
  LIMIT_REFUSED: 'financial.product.limit.refused',
  REVIEW_REQUIRED: 'financial.product.review.required',
  IDEMPOTENCY_CONFLICT: 'financial.product.idempotency.conflict',
} as const;

export type ProductAuditAction = (typeof PRODUCT_AUDIT_ACTIONS)[keyof typeof PRODUCT_AUDIT_ACTIONS];

/**
 * The event catalog.
 *
 * Every name a product execution can emit. Registered with `@trustsystem/event-registry` by the
 * deployment — an event whose schema is not registered is never published, and this list is what
 * the registration is built from.
 */
export const PRODUCT_EVENTS = {
  EXECUTION_STARTED: 'financial.product.execution.started',
  EXECUTION_STEP_COMPLETED: 'financial.product.execution.step_completed',
  EXECUTION_COMPLETED: 'financial.product.execution.completed',
  EXECUTION_FAILED: 'financial.product.execution.failed',
  EXECUTION_COMPENSATED: 'financial.product.execution.compensated',
  REVIEW_REQUIRED: 'financial.product.review.required',
  RULE_DENIED: 'financial.product.rule.denied',
  PRODUCT_ACTIVATED: 'financial.product.activated',
  PRODUCT_PAUSED: 'financial.product.paused',
  PRODUCT_ROLLED_BACK: 'financial.product.rolled_back',
} as const;

export type ProductEventName = (typeof PRODUCT_EVENTS)[keyof typeof PRODUCT_EVENTS];

/**
 * The changes that require a second person, by the field they touch.
 *
 * Section 18 of the specification names nine. Holding them as data rather than as a chain of
 * `if`s in a service is what lets the governance package *derive* the approval requirement from
 * a diff — and what lets a test assert that a fee change cannot reach production on one
 * signature, which no amount of code review reliably catches.
 */
export const MAKER_CHECKER_FIELDS: readonly string[] = [
  'fees',
  'limits',
  'providers',
  'rules',
  'settlementPolicy',
  'reconciliationPolicy',
  'riskPolicy',
  'compliancePolicy',
  'apiExposurePolicy',
  'supportedCountries',
  'supportedCurrencies',
  'blocks',
  'transitions',
];

/** Which approval levels a change to a given field needs. */
export const APPROVAL_LEVELS_BY_FIELD: Readonly<Record<string, readonly string[]>> = {
  fees: ['PRODUCT_OWNER', 'FINANCE'],
  limits: ['PRODUCT_OWNER', 'RISK'],
  providers: ['SECURITY', 'OPERATIONS'],
  rules: ['PRODUCT_OWNER', 'RISK'],
  settlementPolicy: ['OPERATIONS', 'FINANCE'],
  reconciliationPolicy: ['OPERATIONS'],
  riskPolicy: ['RISK', 'COMPLIANCE'],
  compliancePolicy: ['COMPLIANCE'],
  apiExposurePolicy: ['SECURITY'],
  supportedCountries: ['COMPLIANCE', 'RISK'],
  supportedCurrencies: ['FINANCE', 'OPERATIONS'],
  blocks: ['PRODUCT_OWNER', 'RISK'],
  transitions: ['PRODUCT_OWNER', 'RISK'],
};
