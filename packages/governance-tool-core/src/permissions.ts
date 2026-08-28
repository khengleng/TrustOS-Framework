/**
 * Governance Tool permissions.
 *
 * These control **what a person sees in the Governance Tool**, and nothing else. The TrustOS APIs
 * behind it remain the authoritative authorization layer, and every sensitive action is
 * authorized again there against the actor's real permissions.
 *
 * That distinction is the most important sentence in this package. A Governance Tool permission
 * is a *navigation* decision: it decides whether a button is rendered. If it were the only check,
 * then hiding a button would be the control — and a button hidden in a browser is a request
 * anybody can still make with curl.
 *
 * So the rule is: **grant these generously, and never rely on them.** A support agent who can see
 * the freeze-wallet button and cannot freeze a wallet gets a clear refusal from the API. A
 * support agent who cannot see the button but holds the API permission can still freeze a wallet,
 * and should be able to.
 *
 * Keys are permanent. Add freely; never rename.
 */

export interface GovernancePermissionDefinition {
  key: string;
  resource: string;
  action: string;
  description: string;
}

function define(key: string, description: string): GovernancePermissionDefinition {
  const segments = key.split('.');
  const action = segments[segments.length - 1] as string;
  return { key, resource: segments.slice(0, -1).join('.'), action, description };
}

export const GOVERNANCE_PERMISSIONS = {
  // --- internal applications -----------------------------------------------
  APP_READ: define('governance.app.read', 'Open internal applications in the Governance Tool.'),
  APP_CREATE: define('governance.app.create', 'Create a draft internal application.'),
  APP_UPDATE: define('governance.app.update', 'Edit a draft internal application.'),
  APP_SUBMIT: define('governance.app.submit', 'Submit an internal application for review.'),
  /** Deliberately not held by an author's role. */
  APP_APPROVE: define(
    'governance.app.approve',
    'Approve an internal application somebody else built.',
  ),
  APP_PROMOTE: define(
    'governance.app.promote',
    'Promote an internal application to a higher environment.',
  ),
  APP_RETIRE: define('governance.app.retire', 'Retire an internal application.'),

  // --- the resource registry -----------------------------------------------
  RESOURCE_READ: define('governance.resource.read', 'View the approved resource registry.'),
  RESOURCE_REGISTER: define('governance.resource.register', 'Register a resource for review.'),
  RESOURCE_APPROVE: define(
    'governance.resource.approve',
    'Approve a resource for production use, with its access class.',
  ),

  // --- sensitive data -------------------------------------------------------
  /**
   * Reveal a masked value.
   *
   * The most consequential permission here, and the one whose *use* matters more than its grant:
   * every reveal carries a reason, is audited, and expires. See `@trustos/governance-pii-policy`.
   */
  PII_REVEAL: define(
    'governance.pii.reveal',
    'Reveal a masked value, with a reason, for a bounded window.',
  ),
  PII_REVEAL_APPROVE: define(
    'governance.pii.reveal.approve',
    'Approve somebody else’s request to reveal a value that needs maker-checker.',
  ),

  EXPORT_REQUEST: define('governance.export.request', 'Request a data export.'),
  EXPORT_APPROVE: define(
    'governance.export.approve',
    'Approve a high-risk export somebody else requested.',
  ),
  EXPORT_READ: define('governance.export.read', 'View export history and what each one contained.'),

  // --- consoles -------------------------------------------------------------
  OPERATIONS_CONSOLE: define('governance.console.operations', 'Open the operations console.'),
  SUPPORT_CONSOLE: define('governance.console.support', 'Open the customer support console.'),
  RISK_CONSOLE: define('governance.console.risk', 'Open the risk and compliance console.'),
  FINANCE_CONSOLE: define('governance.console.finance', 'Open the finance operations console.'),
  PRODUCT_STUDIO: define('governance.console.product_studio', 'Open the Financial Product Studio.'),
  AI_CONSOLE: define('governance.console.ai', 'Open the AI operations console.'),
  PLATFORM_CONSOLE: define(
    'governance.console.platform',
    'Open the platform administration console.',
  ),
  APPROVAL_WORKBENCH: define('governance.console.approvals', 'Open the approval workbench.'),
  CASE_WORKBENCH: define('governance.console.cases', 'Open the case management workbench.'),

  // --- AI -------------------------------------------------------------------
  AI_ASSIST: define('governance.ai.assist', 'Use an AI-assisted feature inside an internal tool.'),
  AI_REVIEW: define(
    'governance.ai.review',
    'Review an AI output that needs a person before it is used.',
  ),
} as const;

export const GOVERNANCE_PERMISSION_LIST: GovernancePermissionDefinition[] =
  Object.values(GOVERNANCE_PERMISSIONS);

export const ALL_GOVERNANCE_PERMISSION_KEYS: readonly string[] = GOVERNANCE_PERMISSION_LIST.map(
  (permission) => permission.key,
);

/**
 * The ten internal roles, and what each sees.
 *
 * A starting point rather than a policy. What is worth noticing is what is **absent**: no role
 * holds both `app.submit` and `app.approve`, no role holds both `export.request` and
 * `export.approve`, and `pii.reveal.approve` is held by risk and compliance rather than by the
 * people who most often need a reveal.
 *
 * `Auditor` holds read on everything and write on nothing — including no reveal. An auditor who
 * can unmask is an auditor whose access is indistinguishable from an investigator's, and the
 * distinction is the reason both roles exist.
 */
export const GOVERNANCE_ROLES: Readonly<Record<string, readonly string[]>> = {
  platform_admin: [
    GOVERNANCE_PERMISSIONS.APP_READ.key,
    GOVERNANCE_PERMISSIONS.APP_CREATE.key,
    GOVERNANCE_PERMISSIONS.APP_UPDATE.key,
    GOVERNANCE_PERMISSIONS.APP_SUBMIT.key,
    GOVERNANCE_PERMISSIONS.RESOURCE_READ.key,
    GOVERNANCE_PERMISSIONS.RESOURCE_REGISTER.key,
    GOVERNANCE_PERMISSIONS.PLATFORM_CONSOLE.key,
  ],
  product_owner: [
    GOVERNANCE_PERMISSIONS.APP_READ.key,
    GOVERNANCE_PERMISSIONS.PRODUCT_STUDIO.key,
    GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key,
  ],
  operations: [
    GOVERNANCE_PERMISSIONS.APP_READ.key,
    GOVERNANCE_PERMISSIONS.OPERATIONS_CONSOLE.key,
    GOVERNANCE_PERMISSIONS.CASE_WORKBENCH.key,
    GOVERNANCE_PERMISSIONS.EXPORT_REQUEST.key,
  ],
  customer_support: [
    GOVERNANCE_PERMISSIONS.APP_READ.key,
    GOVERNANCE_PERMISSIONS.SUPPORT_CONSOLE.key,
    GOVERNANCE_PERMISSIONS.CASE_WORKBENCH.key,
    GOVERNANCE_PERMISSIONS.PII_REVEAL.key,
  ],
  finance: [
    GOVERNANCE_PERMISSIONS.APP_READ.key,
    GOVERNANCE_PERMISSIONS.FINANCE_CONSOLE.key,
    GOVERNANCE_PERMISSIONS.EXPORT_REQUEST.key,
    GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key,
  ],
  risk: [
    GOVERNANCE_PERMISSIONS.APP_READ.key,
    GOVERNANCE_PERMISSIONS.RISK_CONSOLE.key,
    GOVERNANCE_PERMISSIONS.CASE_WORKBENCH.key,
    // Risk investigates and therefore reveals. Compliance approves the reveal — one role holding
    // both is the configuration `GOVERNANCE_SEGREGATED_PAIRS` exists to catch.
    GOVERNANCE_PERMISSIONS.PII_REVEAL.key,
    GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key,
  ],
  compliance: [
    GOVERNANCE_PERMISSIONS.APP_READ.key,
    GOVERNANCE_PERMISSIONS.RISK_CONSOLE.key,
    GOVERNANCE_PERMISSIONS.CASE_WORKBENCH.key,
    GOVERNANCE_PERMISSIONS.PII_REVEAL_APPROVE.key,
    GOVERNANCE_PERMISSIONS.EXPORT_APPROVE.key,
    GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key,
  ],
  security: [
    GOVERNANCE_PERMISSIONS.APP_READ.key,
    GOVERNANCE_PERMISSIONS.APP_APPROVE.key,
    GOVERNANCE_PERMISSIONS.RESOURCE_APPROVE.key,
    GOVERNANCE_PERMISSIONS.PLATFORM_CONSOLE.key,
    GOVERNANCE_PERMISSIONS.EXPORT_APPROVE.key,
  ],
  auditor: [
    GOVERNANCE_PERMISSIONS.APP_READ.key,
    GOVERNANCE_PERMISSIONS.RESOURCE_READ.key,
    GOVERNANCE_PERMISSIONS.EXPORT_READ.key,
  ],
  ai_operations: [
    GOVERNANCE_PERMISSIONS.APP_READ.key,
    GOVERNANCE_PERMISSIONS.AI_CONSOLE.key,
    GOVERNANCE_PERMISSIONS.AI_REVIEW.key,
  ],
};

/** Pairs no single role may hold. Asserted over the seeded roles rather than described. */
export const GOVERNANCE_SEGREGATED_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [GOVERNANCE_PERMISSIONS.APP_SUBMIT.key, GOVERNANCE_PERMISSIONS.APP_APPROVE.key],
  [GOVERNANCE_PERMISSIONS.APP_CREATE.key, GOVERNANCE_PERMISSIONS.APP_APPROVE.key],
  [GOVERNANCE_PERMISSIONS.EXPORT_REQUEST.key, GOVERNANCE_PERMISSIONS.EXPORT_APPROVE.key],
  [GOVERNANCE_PERMISSIONS.PII_REVEAL.key, GOVERNANCE_PERMISSIONS.PII_REVEAL_APPROVE.key],
  [GOVERNANCE_PERMISSIONS.RESOURCE_REGISTER.key, GOVERNANCE_PERMISSIONS.RESOURCE_APPROVE.key],
];

export function governanceSegregationViolations(
  held: readonly string[],
): Array<readonly [string, string]> {
  const set = new Set(held);
  return GOVERNANCE_SEGREGATED_PAIRS.filter(([left, right]) => set.has(left) && set.has(right));
}
