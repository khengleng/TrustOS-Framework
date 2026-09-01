/**
 * The product lifecycle, as data.
 *
 * Eleven states and the transitions between them. Declared here rather than implied by a set of
 * service methods, for the reason every state machine in this framework is declared: the
 * transition nobody thought about is the one that lets a draft reach production, and it is
 * invisible in a service and obvious in a table.
 *
 * Two things are worth reading before changing any of it.
 *
 * **`active` is the only executable state, and `staged` is the only sandbox-executable one.** A
 * product in any other state has either not been approved or has been withdrawn, and the runtime
 * refuses both. Adding a state to `EXECUTABLE_STATUSES` is a security change, not a convenience.
 *
 * **Every transition names the permission it needs and whether it needs an independent
 * approval.** They are separate fields because they are separate controls: a permission says
 * *this person may do this kind of thing*, an approval says *a second person agreed to this
 * specific thing*. A design that only had permissions would let one person with a broad role
 * carry a product from draft to production alone.
 */

export const PRODUCT_LIFECYCLE_STATUSES = [
  'draft',
  'design',
  'validated',
  'sandbox',
  'under_review',
  'approved',
  'staged',
  'active',
  'paused',
  'deprecated',
  'retired',
] as const;

export type ProductLifecycleStatus = (typeof PRODUCT_LIFECYCLE_STATUSES)[number];

export const LIFECYCLE_DESCRIPTIONS: Record<ProductLifecycleStatus, string> = {
  draft: 'Being written. Editable, and executable nowhere.',
  design: 'Structurally complete and under composition review. Still editable.',
  validated: 'Passes every static check: graph, blocks, connectors, rules, references.',
  sandbox: 'Exercised against mock providers. Still editable — a sandbox run is not an approval.',
  under_review: 'Submitted for independent approval. Frozen from this point on.',
  approved: 'Every required approval recorded. Immutable, and not yet reachable.',
  staged: 'Deployed to the staging environment. Sandbox execution only.',
  active: 'Live. The only state in which the runtime will execute a transaction.',
  paused: 'Withdrawn from new transactions. Running executions finish under their bound version.',
  deprecated: 'Superseded. Existing integrations keep working; new ones are refused.',
  retired: 'Closed. No execution, no rollback target, history retained.',
};

/**
 * States in which the runtime will start a new execution.
 *
 * One entry, and it is the point of the whole lifecycle. Everything above `active` is a control
 * that exists to decide whether a definition may be added to this set.
 */
export const EXECUTABLE_STATUSES: ReadonlySet<ProductLifecycleStatus> = new Set(['active']);

/** States in which the sandbox — and only the sandbox — will execute. */
export const SANDBOX_EXECUTABLE_STATUSES: ReadonlySet<ProductLifecycleStatus> = new Set([
  'draft',
  'design',
  'validated',
  'sandbox',
  'under_review',
  'approved',
  'staged',
  'active',
]);

/** States in which the definition may still be edited. Everything else is immutable. */
export const EDITABLE_STATUSES: ReadonlySet<ProductLifecycleStatus> = new Set([
  'draft',
  'design',
  'validated',
  'sandbox',
]);

/** States from which no transition leads anywhere. */
export const TERMINAL_STATUSES: ReadonlySet<ProductLifecycleStatus> = new Set(['retired']);

export interface LifecycleTransition {
  action: string;
  from: ProductLifecycleStatus;
  to: ProductLifecycleStatus;
  /** The permission key the actor must hold. */
  permission: string;
  /**
   * Whether a second person must have approved. Separate from the permission because holding
   * `product.publish` says you may publish products, not that anybody agreed to this one.
   */
  requiresApproval: boolean;
  description: string;
}

/**
 * The transition table.
 *
 * The shortcuts that are deliberately absent are as important as the entries that are present:
 * there is no `draft -> active`, no `validated -> approved`, and no way to reach `active` except
 * through `approved` and `staged`. Every one of those would be a convenient thing to add during
 * an incident and a permanent hole afterwards.
 *
 * `pause` and `activate` form the only loop, because pausing is the incident response and
 * un-pausing has to be possible without a new approval — the version being restored is one that
 * was already approved. Rollback uses the same pair; see `@trustsystem/financial-product-versioning`.
 */
export const LIFECYCLE_TRANSITIONS: readonly LifecycleTransition[] = [
  {
    action: 'design',
    from: 'draft',
    to: 'design',
    permission: 'financial.product.update',
    requiresApproval: false,
    description: 'The composition is structurally complete and ready for review.',
  },
  {
    action: 'validate',
    from: 'design',
    to: 'validated',
    permission: 'financial.product.validate',
    requiresApproval: false,
    description: 'Every static check passed.',
  },
  {
    action: 'revise',
    from: 'validated',
    to: 'draft',
    permission: 'financial.product.update',
    requiresApproval: false,
    description: 'Sent back for editing before review.',
  },
  {
    action: 'sandbox',
    from: 'validated',
    to: 'sandbox',
    permission: 'financial.product.sandbox',
    requiresApproval: false,
    description: 'Exercised against mock providers and failure scenarios.',
  },
  {
    action: 'revise',
    from: 'sandbox',
    to: 'draft',
    permission: 'financial.product.update',
    requiresApproval: false,
    description: 'Sent back for editing after a sandbox run found something.',
  },
  {
    action: 'submit',
    from: 'sandbox',
    to: 'under_review',
    permission: 'financial.product.submit',
    requiresApproval: false,
    description: 'Submitted for independent approval. The definition freezes here.',
  },
  {
    action: 'reject',
    from: 'under_review',
    to: 'draft',
    permission: 'financial.product.approve',
    requiresApproval: false,
    description: 'A reviewer sent it back. The rejection reason is recorded.',
  },
  {
    action: 'approve',
    from: 'under_review',
    to: 'approved',
    permission: 'financial.product.approve',
    requiresApproval: true,
    description: 'Every required approval level recorded a decision.',
  },
  {
    action: 'stage',
    from: 'approved',
    to: 'staged',
    permission: 'financial.product.publish',
    requiresApproval: true,
    description: 'Deployed to staging. Sandbox execution only.',
  },
  {
    action: 'activate',
    from: 'staged',
    to: 'active',
    permission: 'financial.product.publish',
    requiresApproval: true,
    description: 'Live. New transactions may start on this version.',
  },
  {
    action: 'pause',
    from: 'active',
    to: 'paused',
    permission: 'financial.product.pause',
    requiresApproval: false,
    description:
      'Withdrawn from new transactions. Deliberately needs no approval — an incident ' +
      'response that waits for a checker is not an incident response.',
  },
  {
    action: 'activate',
    from: 'paused',
    to: 'active',
    permission: 'financial.product.publish',
    requiresApproval: false,
    description: 'Restored. The version was approved before it was paused.',
  },
  {
    action: 'deprecate',
    from: 'active',
    to: 'deprecated',
    permission: 'financial.product.deprecate',
    requiresApproval: true,
    description: 'Superseded. Existing integrations keep working.',
  },
  {
    action: 'deprecate',
    from: 'paused',
    to: 'deprecated',
    permission: 'financial.product.deprecate',
    requiresApproval: true,
    description: 'Superseded while paused.',
  },
  {
    action: 'retire',
    from: 'deprecated',
    to: 'retired',
    permission: 'financial.product.retire',
    requiresApproval: true,
    description: 'Closed. History is retained; nothing executes.',
  },
];

/** Every action name in the table. */
export const LIFECYCLE_ACTIONS: readonly string[] = [
  ...new Set(LIFECYCLE_TRANSITIONS.map((transition) => transition.action)),
];

export function isExecutable(status: ProductLifecycleStatus): boolean {
  return EXECUTABLE_STATUSES.has(status);
}

export function isEditable(status: ProductLifecycleStatus): boolean {
  return EDITABLE_STATUSES.has(status);
}
