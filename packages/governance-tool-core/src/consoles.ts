import {
  internalApplicationSchema,
  type InternalApplication,
  type InternalAction,
  type DataSource,
  type InternalPage,
} from './application';
import { GOVERNANCE_PERMISSIONS } from './permissions';

/**
 * The ten console templates.
 *
 * Section 31 of the specification asks for a template library. These are it — and they are
 * **internal application definitions**, which is data, rather than generator templates under
 * `templates/`. That distinction matters here for a specific reason: `templates/` in this
 * repository is generated from `scripts/template-specs.mjs`, and anything written there by hand
 * is discarded on the next regeneration. A console is not an application to be scaffolded; it is
 * a document the Governance Tool runtime executes.
 *
 * Every one of them **validates**, and every one of them is built from the same two facts:
 *
 *   * A data source names a **registered resource** and an operation. There is no query.
 *   * An action names a **gateway path**. There is no direct write, in any console, anywhere.
 *
 * The consoles are deliberately thin. They demonstrate the shape and the controls; the pages a
 * deployment actually wants are its own, and a console library that tried to guess them would be
 * a library everybody forks on the first day.
 */

/**
 * Canonical resource ids.
 *
 * Shared with `@trustos/governance-resource-policy`, which classifies them. Two lists that had to
 * agree by convention would disagree within a month, and the symptom would be a console whose
 * data source resolves to nothing.
 */
export const STANDARD_RESOURCE_IDS = {
  // Class A — approved read-only reporting.
  REPORTING_TRANSACTIONS: 'reporting.transactions',
  REPORTING_SETTLEMENTS: 'reporting.settlements',
  REPORTING_MERCHANTS: 'reporting.merchants',
  REPORTING_CUSTOMERS: 'reporting.customers',
  REPORTING_EXCEPTIONS: 'reporting.exceptions',
  REPORTING_AI_USAGE: 'reporting.ai_usage',
  REFERENCE_DATA: 'reference.data',

  // Class B — authoritative, through the API.
  API_WALLET: 'trustos.wallet',
  API_LEDGER: 'trustos.ledger',
  API_SETTLEMENT: 'trustos.settlement',
  API_RECONCILIATION: 'trustos.reconciliation',
  API_WORKFLOW: 'trustos.workflow',
  API_CASE: 'trustos.case',
  API_CUSTOMER: 'trustos.customer',
  API_MERCHANT: 'trustos.merchant',
  API_PRODUCT: 'trustos.financial_product',
  API_IDENTITY: 'trustos.identity',
  API_RBAC: 'trustos.rbac',
  API_API_KEYS: 'trustos.api_keys',
  API_AI: 'trustos.ai',
  API_HEALTH: 'trustos.health',
  API_AUDIT: 'trustos.audit',
  API_SECURITY_EVENTS: 'trustos.security_events',

  /*
   * Phase 13 — the enterprise governance surfaces.
   *
   * Every one of them is Class B: authoritative, reached through the API, never read from a
   * database. That is not a cautious default here but the only correct one — a console that read
   * the policy registry directly would be reading the rules the platform enforces, from a surface
   * where nothing checks whether the version it found is active.
   */
  API_DATA_CATALOG: 'trustos.data_catalog',
  API_DATA_LINEAGE: 'trustos.data_lineage',
  API_POLICY: 'trustos.policy',
  API_POLICY_DECISIONS: 'trustos.policy_decisions',
  API_SRE_SERVICE: 'trustos.sre_service',
  API_SRE_SLO: 'trustos.sre_slo',
  API_SRE_INCIDENT: 'trustos.sre_incident',
  API_API_CATALOG: 'trustos.api_catalog',
  API_API_CONSUMER: 'trustos.api_consumer',
  API_BACKUP: 'trustos.backup',
  API_DR_PLAN: 'trustos.dr_plan',
  API_CONTINUITY: 'trustos.continuity',
} as const;

const R = STANDARD_RESOURCE_IDS;

function source(
  id: string,
  resourceId: string,
  fields: string[],
  options: Partial<DataSource> = {},
): DataSource {
  return {
    id,
    resourceId,
    operation: 'search',
    parameters: [],
    fields,
    fieldExceptions: [],
    maxRows: 200,
    ...options,
  } as DataSource;
}

function action(
  id: string,
  label: string,
  resourceId: string,
  apiPath: string,
  options: Partial<InternalAction> = {},
): InternalAction {
  return {
    id,
    label,
    resourceId,
    operation: 'execute',
    apiPath,
    method: 'POST',
    permission: GOVERNANCE_PERMISSIONS.APP_READ.key,
    requiresReason: true,
    requiresApproval: false,
    reversible: true,
    ...options,
  } as InternalAction;
}

function page(
  id: string,
  title: string,
  permission: string,
  components: InternalPage['components'],
): InternalPage {
  return { id, title, permission, components };
}

function console_(input: {
  appId: string;
  name: string;
  description: string;
  businessPurpose: string;
  dataClassification: InternalApplication['dataClassification'];
  riskClassification: InternalApplication['riskClassification'];
  roles: string[];
  dataSources: DataSource[];
  actions: InternalAction[];
  pages: InternalPage[];
  aiFeatures?: string[];
}): InternalApplication {
  return internalApplicationSchema.parse({
    ...input,
    owner: 'role:platform-engineering',
    businessOwner: 'role:operations',
    technicalOwner: 'role:platform-engineering',
    environment: 'dev',
    lifecycleStatus: 'draft',
    version: '1.0.0',
    aiFeatures: input.aiFeatures ?? [],
    lastSecurityReview: null,
    nextSecurityReview: '2026-12-31T00:00:00.000Z',
  });
}

// --- 1. operations ----------------------------------------------------------

export function operationsConsole(): InternalApplication {
  return console_({
    appId: 'operations-console',
    name: 'Operations Console',
    description: 'Transaction search, workflow and exception queues, provider health, incidents.',
    businessPurpose:
      'Gives operations one place to see what is stuck and to ask the platform to retry, resubmit or escalate it.',
    dataClassification: 'restricted',
    riskClassification: 'high',
    roles: ['operations', 'platform_admin'],
    dataSources: [
      source('transactions', R.REPORTING_TRANSACTIONS, [
        'reference',
        'status',
        'amountMinorUnits',
        'currency',
        'createdAt',
      ]),
      source('exceptions', R.REPORTING_EXCEPTIONS, ['exceptionId', 'type', 'ageHours', 'status']),
      source('queues', R.API_WORKFLOW, ['taskId', 'state', 'assignee', 'dueAt'], {
        operation: 'read',
      }),
      source('provider-health', R.API_HEALTH, ['providerInterface', 'status', 'checkedAt'], {
        operation: 'read',
      }),
      source('settlements', R.REPORTING_SETTLEMENTS, [
        'batchRef',
        'status',
        'totalMinorUnits',
        'windowEnd',
      ]),
    ],
    actions: [
      action('retry-job', 'Retry', R.API_WORKFLOW, '/internal/v1/operations/jobs/:jobId/retry'),
      action(
        'escalate',
        'Escalate',
        R.API_WORKFLOW,
        '/internal/v1/operations/tasks/:taskId/escalate',
      ),
      action('open-case', 'Open case', R.API_CASE, '/internal/v1/operations/cases'),
      /*
       * A correction is a *request*, not a correction.
       *
       * The console asks the financial runtime to post an adjustment through maker-checker; it
       * does not post one. Direct ledger mutation from a console is the single most attractive
       * shortcut in this whole layer, and the one that removes every financial control at once.
       */
      action(
        'request-correction',
        'Request correction',
        R.API_LEDGER,
        '/internal/v1/finance/adjustments/requests',
        {
          requiresApproval: true,
          reversible: false,
        },
      ),
    ],
    pages: [
      page('dashboard', 'Dashboard', GOVERNANCE_PERMISSIONS.OPERATIONS_CONSOLE.key, [
        {
          id: 'kpis',
          kind: 'kpi',
          dataSourceId: 'transactions',
          actionIds: [],
          fields: ['status'],
        },
        {
          id: 'health',
          kind: 'table',
          dataSourceId: 'provider-health',
          actionIds: [],
          fields: ['providerInterface', 'status', 'checkedAt'],
        },
      ]),
      page('transactions', 'Transactions', GOVERNANCE_PERMISSIONS.OPERATIONS_CONSOLE.key, [
        {
          id: 'search',
          kind: 'search',
          dataSourceId: 'transactions',
          actionIds: [],
          fields: ['reference'],
        },
        {
          id: 'list',
          kind: 'table',
          dataSourceId: 'transactions',
          actionIds: ['open-case', 'request-correction'],
          fields: ['reference', 'status', 'amountMinorUnits', 'currency', 'createdAt'],
        },
      ]),
      page('queues', 'Queues', GOVERNANCE_PERMISSIONS.OPERATIONS_CONSOLE.key, [
        {
          id: 'workflow',
          kind: 'queue',
          dataSourceId: 'queues',
          actionIds: ['escalate'],
          fields: ['taskId', 'state', 'assignee', 'dueAt'],
        },
        {
          id: 'exceptions',
          kind: 'queue',
          dataSourceId: 'exceptions',
          actionIds: ['retry-job', 'open-case'],
          fields: ['exceptionId', 'type', 'ageHours', 'status'],
        },
      ]),
      page('settlements', 'Settlements', GOVERNANCE_PERMISSIONS.OPERATIONS_CONSOLE.key, [
        {
          id: 'batches',
          kind: 'table',
          dataSourceId: 'settlements',
          actionIds: [],
          fields: ['batchRef', 'status', 'totalMinorUnits', 'windowEnd'],
        },
      ]),
    ],
  });
}

// --- 2. customer support ----------------------------------------------------

export function customerSupportConsole(): InternalApplication {
  return console_({
    appId: 'customer-support-console',
    name: 'Customer Support Console',
    description:
      'Customer and merchant search, profile, transaction timeline, case and notification history.',
    businessPurpose:
      'Lets a support agent answer "what happened to my payment" without asking engineering, and without touching a balance.',
    dataClassification: 'restricted',
    riskClassification: 'high',
    roles: ['customer_support'],
    dataSources: [
      source('customers', R.REPORTING_CUSTOMERS, [
        'customerRef',
        'status',
        'kycLevel',
        'maskedPhone',
        'maskedEmail',
      ]),
      source('timeline', R.REPORTING_TRANSACTIONS, [
        'reference',
        'status',
        'amountMinorUnits',
        'createdAt',
      ]),
      source('cases', R.API_CASE, ['caseId', 'status', 'openedAt'], { operation: 'read' }),
      source('notifications', R.REPORTING_CUSTOMERS, ['notificationId', 'templateCode', 'sentAt']),
    ],
    actions: [
      action('add-note', 'Add note', R.API_CASE, '/internal/v1/support/cases/:caseId/notes', {
        requiresReason: false,
      }),
      action('open-case', 'Open case', R.API_CASE, '/internal/v1/support/cases'),
      /*
       * Support may *request* a freeze; support may not freeze.
       *
       * The distinction is the point of the console. Freezing a wallet is a financial control
       * with an authorization policy and an audit trail behind it, and the request path is what
       * makes both run.
       */
      action(
        'request-freeze',
        'Request wallet freeze',
        R.API_WALLET,
        '/internal/v1/support/wallets/:walletRef/freeze-requests',
        {
          requiresApproval: true,
        },
      ),
      action(
        'reveal-contact',
        'Reveal contact details',
        R.API_CUSTOMER,
        '/internal/v1/support/customers/:customerRef/reveal',
        {
          permission: GOVERNANCE_PERMISSIONS.PII_REVEAL.key,
          operation: 'read',
          method: 'POST',
        },
      ),
    ],
    pages: [
      page('search', 'Search', GOVERNANCE_PERMISSIONS.SUPPORT_CONSOLE.key, [
        {
          id: 'customer-search',
          kind: 'search',
          dataSourceId: 'customers',
          actionIds: [],
          fields: ['customerRef'],
        },
        {
          id: 'results',
          kind: 'table',
          dataSourceId: 'customers',
          actionIds: ['reveal-contact'],
          fields: ['customerRef', 'status', 'kycLevel', 'maskedPhone', 'maskedEmail'],
        },
      ]),
      page('customer', 'Customer', GOVERNANCE_PERMISSIONS.SUPPORT_CONSOLE.key, [
        {
          id: 'profile',
          kind: 'detail',
          dataSourceId: 'customers',
          actionIds: ['request-freeze', 'open-case'],
          fields: ['customerRef', 'status', 'kycLevel'],
        },
        {
          id: 'transactions',
          kind: 'timeline',
          dataSourceId: 'timeline',
          actionIds: [],
          fields: ['reference', 'status', 'amountMinorUnits', 'createdAt'],
        },
        {
          id: 'cases',
          kind: 'table',
          dataSourceId: 'cases',
          actionIds: ['add-note'],
          fields: ['caseId', 'status', 'openedAt'],
        },
        {
          id: 'notifications',
          kind: 'table',
          dataSourceId: 'notifications',
          actionIds: [],
          fields: ['notificationId', 'templateCode', 'sentAt'],
        },
      ]),
    ],
  });
}

// --- 3. risk and compliance -------------------------------------------------

export function riskComplianceConsole(): InternalApplication {
  return console_({
    appId: 'risk-compliance-console',
    name: 'Risk & Compliance Console',
    description:
      'Alerts, KYC and EDD review, AML cases, sanctions and PEP hits, investigation and escalation.',
    businessPurpose:
      'Gives risk and compliance the queue, the evidence and the decision trail for every case they own.',
    dataClassification: 'highly_restricted',
    riskClassification: 'critical',
    roles: ['risk', 'compliance'],
    dataSources: [
      source('alerts', R.REPORTING_EXCEPTIONS, [
        'alertId',
        'type',
        'riskLevel',
        'raisedAt',
        'status',
      ]),
      source('cases', R.API_CASE, ['caseId', 'status', 'priority', 'slaDueAt'], {
        operation: 'read',
      }),
      source('subject', R.REPORTING_CUSTOMERS, [
        'customerRef',
        'kycLevel',
        'riskLevel',
        'maskedName',
      ]),
      source('approvals', R.API_WORKFLOW, ['taskId', 'state', 'dueAt'], { operation: 'read' }),
    ],
    actions: [
      action('assign', 'Assign', R.API_CASE, '/internal/v1/risk/cases/:caseId/assign', {
        requiresReason: false,
      }),
      action('escalate', 'Escalate', R.API_CASE, '/internal/v1/risk/cases/:caseId/escalate'),
      action(
        'request-information',
        'Request information',
        R.API_CASE,
        '/internal/v1/risk/cases/:caseId/information-requests',
      ),
      action(
        'decide',
        'Record decision',
        R.API_WORKFLOW,
        '/internal/v1/risk/tasks/:taskId/decisions',
        {
          requiresApproval: false,
          reversible: false,
        },
      ),
      action('resolve', 'Resolve', R.API_CASE, '/internal/v1/risk/cases/:caseId/resolve', {
        reversible: false,
      }),
      action(
        'reveal-subject',
        'Reveal subject identity',
        R.API_CUSTOMER,
        '/internal/v1/risk/customers/:customerRef/reveal',
        {
          permission: GOVERNANCE_PERMISSIONS.PII_REVEAL.key,
          operation: 'read',
        },
      ),
    ],
    pages: [
      page('alerts', 'Alerts', GOVERNANCE_PERMISSIONS.RISK_CONSOLE.key, [
        {
          id: 'queue',
          kind: 'queue',
          dataSourceId: 'alerts',
          actionIds: ['assign', 'escalate'],
          fields: ['alertId', 'type', 'riskLevel', 'raisedAt', 'status'],
        },
      ]),
      page('cases', 'Cases', GOVERNANCE_PERMISSIONS.RISK_CONSOLE.key, [
        {
          id: 'list',
          kind: 'case',
          dataSourceId: 'cases',
          actionIds: ['assign', 'request-information', 'resolve'],
          fields: ['caseId', 'status', 'priority', 'slaDueAt'],
        },
        {
          id: 'subject',
          kind: 'detail',
          dataSourceId: 'subject',
          actionIds: ['reveal-subject'],
          fields: ['customerRef', 'kycLevel', 'riskLevel', 'maskedName'],
        },
      ]),
      page('approvals', 'Approvals', GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key, [
        {
          id: 'pending',
          kind: 'approval',
          dataSourceId: 'approvals',
          actionIds: ['decide'],
          fields: ['taskId', 'state', 'dueAt'],
        },
      ]),
    ],
  });
}

// --- 4. finance -------------------------------------------------------------

export function financeConsole(): InternalApplication {
  return console_({
    appId: 'finance-console',
    name: 'Finance Operations Console',
    description: 'Settlement, reconciliation, exceptions, fees, revenue share and the GL summary.',
    businessPurpose:
      'Lets finance see what settled, what did not, and what it cost — and request a correction through the controls rather than around them.',
    dataClassification: 'restricted',
    riskClassification: 'critical',
    roles: ['finance'],
    dataSources: [
      source('settlements', R.REPORTING_SETTLEMENTS, [
        'batchRef',
        'status',
        'totalMinorUnits',
        'currency',
        'windowEnd',
      ]),
      source('exceptions', R.REPORTING_EXCEPTIONS, [
        'exceptionId',
        'type',
        'differenceMinorUnits',
        'ageHours',
      ]),
      source('fees', R.REPORTING_TRANSACTIONS, [
        'feeCode',
        'totalMinorUnits',
        'currency',
        'period',
      ]),
      source('gl-summary', R.API_LEDGER, ['accountRef', 'balanceMinorUnits', 'currency'], {
        operation: 'aggregate',
      }),
    ],
    actions: [
      /*
       * Direct ledger posting from a console is prohibited, and this is what replaces it.
       *
       * The request goes to the adjustment API, which runs maker-checker, and the financial
       * runtime posts a reversal or an adjustment. Finance never posts; finance asks.
       */
      action(
        'request-adjustment',
        'Request adjustment',
        R.API_LEDGER,
        '/internal/v1/finance/adjustments/requests',
        {
          requiresApproval: true,
          reversible: false,
        },
      ),
      action(
        'resolve-exception',
        'Resolve exception',
        R.API_RECONCILIATION,
        '/internal/v1/finance/reconciliation/:exceptionId/resolve',
        {
          reversible: false,
        },
      ),
      action(
        'export-report',
        'Export report',
        R.REPORTING_SETTLEMENTS,
        '/internal/v1/finance/exports',
        {
          permission: GOVERNANCE_PERMISSIONS.EXPORT_REQUEST.key,
          requiresApproval: true,
        },
      ),
    ],
    pages: [
      page('settlement', 'Settlement', GOVERNANCE_PERMISSIONS.FINANCE_CONSOLE.key, [
        {
          id: 'batches',
          kind: 'table',
          dataSourceId: 'settlements',
          actionIds: ['export-report'],
          fields: ['batchRef', 'status', 'totalMinorUnits', 'currency', 'windowEnd'],
        },
      ]),
      page('reconciliation', 'Reconciliation', GOVERNANCE_PERMISSIONS.FINANCE_CONSOLE.key, [
        {
          id: 'exceptions',
          kind: 'queue',
          dataSourceId: 'exceptions',
          actionIds: ['resolve-exception', 'request-adjustment'],
          fields: ['exceptionId', 'type', 'differenceMinorUnits', 'ageHours'],
        },
      ]),
      page('revenue', 'Fees and revenue', GOVERNANCE_PERMISSIONS.FINANCE_CONSOLE.key, [
        {
          id: 'fees',
          kind: 'chart',
          dataSourceId: 'fees',
          actionIds: ['export-report'],
          fields: ['feeCode', 'totalMinorUnits', 'currency', 'period'],
        },
        {
          id: 'gl-summary',
          kind: 'report',
          dataSourceId: 'gl-summary',
          actionIds: [],
          fields: ['accountRef', 'balanceMinorUnits', 'currency'],
        },
      ]),
    ],
  });
}

// --- 5. financial product studio --------------------------------------------

export function financialProductStudio(): InternalApplication {
  return console_({
    appId: 'financial-product-studio',
    name: 'Financial Product Studio',
    description:
      'The catalog, designer, blocks, connectors, rules, sandbox, simulator, approvals, versions and monitoring.',
    businessPurpose:
      'Lets a product owner compose and exercise a financial product, and submit it — without being able to publish it.',
    dataClassification: 'confidential',
    riskClassification: 'high',
    roles: ['product_owner', 'risk', 'compliance', 'finance'],
    dataSources: [
      source(
        'catalog',
        R.API_PRODUCT,
        ['productId', 'productName', 'lifecycleStatus', 'activeVersion'],
        { operation: 'read' },
      ),
      source(
        'blocks',
        R.API_PRODUCT,
        ['blockId', 'category', 'monetaryEffect', 'providerInterface'],
        { operation: 'read' },
      ),
      source('connectors', R.API_PRODUCT, ['connectorId', 'providerInterface', 'lifecycleStatus'], {
        operation: 'read',
      }),
      source(
        'versions',
        R.API_PRODUCT,
        ['version', 'lifecycleStatus', 'changeSummary', 'publishedAt'],
        { operation: 'read' },
      ),
      source('approvals', R.API_WORKFLOW, ['taskId', 'state', 'dueAt'], { operation: 'read' }),
    ],
    actions: [
      action('create-draft', 'Create draft', R.API_PRODUCT, '/internal/v1/products/drafts', {
        requiresReason: false,
      }),
      action('validate', 'Validate', R.API_PRODUCT, '/internal/v1/products/:productId/validate', {
        requiresReason: false,
        operation: 'read',
      }),
      action('sandbox', 'Run sandbox', R.API_PRODUCT, '/internal/v1/products/:productId/sandbox', {
        requiresReason: false,
      }),
      action('simulate', 'Simulate', R.API_PRODUCT, '/internal/v1/products/:productId/simulate', {
        requiresReason: false,
      }),
      action(
        'submit',
        'Submit for approval',
        R.API_PRODUCT,
        '/internal/v1/products/:productId/submit',
      ),
      /*
       * There is no publish action, and there is no activate action.
       *
       * The Studio composes and submits; TrustOS approves and publishes. A publish button here
       * would be a way to reach production from a low-code console, which is precisely the thing
       * the whole Governance Tool is constructed not to be.
       */
    ],
    pages: [
      page('catalog', 'Product catalog', GOVERNANCE_PERMISSIONS.PRODUCT_STUDIO.key, [
        {
          id: 'products',
          kind: 'table',
          dataSourceId: 'catalog',
          actionIds: ['create-draft'],
          fields: ['productId', 'productName', 'lifecycleStatus', 'activeVersion'],
        },
      ]),
      page('designer', 'Designer', GOVERNANCE_PERMISSIONS.PRODUCT_STUDIO.key, [
        {
          id: 'palette',
          kind: 'table',
          dataSourceId: 'blocks',
          actionIds: [],
          fields: ['blockId', 'category', 'monetaryEffect', 'providerInterface'],
        },
        {
          id: 'actions',
          kind: 'action_panel',
          dataSourceId: 'catalog',
          actionIds: ['validate', 'sandbox', 'simulate', 'submit'],
          fields: [],
        },
      ]),
      page('connectors', 'Connectors', GOVERNANCE_PERMISSIONS.PRODUCT_STUDIO.key, [
        {
          id: 'list',
          kind: 'table',
          dataSourceId: 'connectors',
          actionIds: [],
          fields: ['connectorId', 'providerInterface', 'lifecycleStatus'],
        },
      ]),
      page('versions', 'Versions and deployments', GOVERNANCE_PERMISSIONS.PRODUCT_STUDIO.key, [
        {
          id: 'history',
          kind: 'timeline',
          dataSourceId: 'versions',
          actionIds: [],
          fields: ['version', 'lifecycleStatus', 'changeSummary', 'publishedAt'],
        },
      ]),
      page('approvals', 'Approval queue', GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key, [
        {
          id: 'pending',
          kind: 'approval',
          dataSourceId: 'approvals',
          actionIds: [],
          fields: ['taskId', 'state', 'dueAt'],
        },
      ]),
    ],
  });
}

// --- 6. AI operations -------------------------------------------------------

export function aiOperationsConsole(): InternalApplication {
  return console_({
    appId: 'ai-operations-console',
    name: 'AI Operations Console',
    description:
      'Models, prompts, agents, guardrail results, evaluations, human review, token spend and incidents.',
    businessPurpose:
      'Gives AI operations the usage, the cost and the refusals in one place, and the queue of outputs waiting on a person.',
    dataClassification: 'confidential',
    riskClassification: 'high',
    roles: ['ai_operations'],
    dataSources: [
      source('models', R.API_AI, ['modelId', 'provider', 'status'], { operation: 'read' }),
      source('prompts', R.API_AI, ['promptId', 'version', 'status'], { operation: 'read' }),
      source('guardrails', R.REPORTING_AI_USAGE, [
        'requestId',
        'guardrail',
        'outcome',
        'occurredAt',
      ]),
      source(
        'usage',
        R.REPORTING_AI_USAGE,
        ['period', 'requests', 'inputTokens', 'outputTokens', 'costMinorUnits'],
        {
          // Counts, not credentials. Named individually so the exception is visible in review.
          fieldExceptions: ['inputTokens', 'outputTokens'],
        },
      ),
      source('reviews', R.API_AI, ['reviewId', 'status', 'priority', 'slaDueAt'], {
        operation: 'read',
      }),
    ],
    actions: [
      action(
        'decide-review',
        'Record review decision',
        R.API_AI,
        '/internal/v1/ai/reviews/:reviewId/decisions',
        {
          permission: GOVERNANCE_PERMISSIONS.AI_REVIEW.key,
          reversible: false,
        },
      ),
    ],
    pages: [
      page('registry', 'Models and prompts', GOVERNANCE_PERMISSIONS.AI_CONSOLE.key, [
        {
          id: 'models',
          kind: 'table',
          dataSourceId: 'models',
          actionIds: [],
          fields: ['modelId', 'provider', 'status'],
        },
        {
          id: 'prompts',
          kind: 'table',
          dataSourceId: 'prompts',
          actionIds: [],
          fields: ['promptId', 'version', 'status'],
        },
      ]),
      page('governance', 'Guardrails and cost', GOVERNANCE_PERMISSIONS.AI_CONSOLE.key, [
        {
          id: 'guardrails',
          kind: 'table',
          dataSourceId: 'guardrails',
          actionIds: [],
          fields: ['requestId', 'guardrail', 'outcome', 'occurredAt'],
        },
        {
          id: 'usage',
          kind: 'chart',
          dataSourceId: 'usage',
          actionIds: [],
          fields: ['period', 'requests', 'costMinorUnits'],
        },
      ]),
      page('review', 'Human review', GOVERNANCE_PERMISSIONS.AI_CONSOLE.key, [
        {
          id: 'queue',
          kind: 'queue',
          dataSourceId: 'reviews',
          actionIds: ['decide-review'],
          fields: ['reviewId', 'status', 'priority', 'slaDueAt'],
        },
      ]),
    ],
  });
}

// --- 7. platform administration ---------------------------------------------

export function platformAdminConsole(): InternalApplication {
  return console_({
    appId: 'platform-admin-console',
    name: 'Platform Administration Console',
    description:
      'Organizations, users, roles, service accounts, API key metadata, modules, flags, health and audit.',
    businessPurpose:
      'The administrative surface for the platform itself, with every sensitive change routed through the API that authorizes it.',
    dataClassification: 'restricted',
    riskClassification: 'critical',
    roles: ['platform_admin', 'security'],
    dataSources: [
      source('organizations', R.API_IDENTITY, ['organizationId', 'name', 'status'], {
        operation: 'read',
      }),
      source('roles', R.API_RBAC, ['roleId', 'name', 'permissionCount'], { operation: 'read' }),
      /*
       * Key *metadata*. Never a key.
       *
       * `@trustos/api-keys` stores a prefix, a hash and metadata, and there is no code path that
       * produces the plaintext after creation — so there is nothing here to expose even if
       * somebody added a field for it.
       */
      source('api-keys', R.API_API_KEYS, ['keyPrefix', 'status', 'lastUsedAt', 'expiresAt'], {
        operation: 'read',
      }),
      source('health', R.API_HEALTH, ['component', 'status', 'checkedAt'], { operation: 'read' }),
      source(
        'security-events',
        R.API_SECURITY_EVENTS,
        ['eventId', 'type', 'severity', 'occurredAt'],
        { operation: 'read' },
      ),
      source('audit', R.API_AUDIT, ['recordId', 'action', 'actorId', 'occurredAt'], {
        operation: 'read',
      }),
    ],
    actions: [
      action(
        'request-role-change',
        'Request role change',
        R.API_RBAC,
        '/internal/v1/platform/role-changes/requests',
        {
          requiresApproval: true,
          reversible: false,
        },
      ),
      action(
        'revoke-key',
        'Revoke API key',
        R.API_API_KEYS,
        '/internal/v1/platform/api-keys/:keyPrefix/revoke',
        {
          reversible: false,
        },
      ),
    ],
    pages: [
      page('tenants', 'Organizations', GOVERNANCE_PERMISSIONS.PLATFORM_CONSOLE.key, [
        {
          id: 'list',
          kind: 'table',
          dataSourceId: 'organizations',
          actionIds: [],
          fields: ['organizationId', 'name', 'status'],
        },
      ]),
      page('access', 'Roles and credentials', GOVERNANCE_PERMISSIONS.PLATFORM_CONSOLE.key, [
        {
          id: 'roles',
          kind: 'table',
          dataSourceId: 'roles',
          actionIds: ['request-role-change'],
          fields: ['roleId', 'name', 'permissionCount'],
        },
        {
          id: 'keys',
          kind: 'table',
          dataSourceId: 'api-keys',
          actionIds: ['revoke-key'],
          fields: ['keyPrefix', 'status', 'lastUsedAt', 'expiresAt'],
        },
      ]),
      page('health', 'Health and security', GOVERNANCE_PERMISSIONS.PLATFORM_CONSOLE.key, [
        {
          id: 'components',
          kind: 'table',
          dataSourceId: 'health',
          actionIds: [],
          fields: ['component', 'status', 'checkedAt'],
        },
        {
          id: 'events',
          kind: 'table',
          dataSourceId: 'security-events',
          actionIds: [],
          fields: ['eventId', 'type', 'severity', 'occurredAt'],
        },
      ]),
      page('audit', 'Audit', GOVERNANCE_PERMISSIONS.PLATFORM_CONSOLE.key, [
        {
          id: 'trail',
          kind: 'table',
          dataSourceId: 'audit',
          actionIds: [],
          fields: ['recordId', 'action', 'actorId', 'occurredAt'],
        },
      ]),
    ],
  });
}

// --- 8. approval workbench --------------------------------------------------

export function approvalWorkbench(): InternalApplication {
  return console_({
    appId: 'approval-workbench',
    name: 'Approval Workbench',
    description:
      'Pending approvals, the change being approved, supporting evidence, and the decision.',
    businessPurpose:
      'One queue for every approval a person owns, whatever produced it — a product change, a limit change, a role change, an adjustment.',
    dataClassification: 'confidential',
    riskClassification: 'high',
    roles: ['risk', 'compliance', 'finance', 'security', 'product_owner'],
    dataSources: [
      source(
        'pending',
        R.API_WORKFLOW,
        ['taskId', 'subject', 'requestedBy', 'dueAt', 'slaBreached'],
        { operation: 'read' },
      ),
      source('history', R.API_WORKFLOW, ['taskId', 'decision', 'actorId', 'decidedAt', 'reason'], {
        operation: 'read',
      }),
    ],
    /*
     * These are **gateway** operations, not the Governance Tool's own routes.
     *
     * Each one is declared in `@trustos/governance-tool-integration`'s operation
     * catalog, and an integration test asserts that every path a console calls is
     * declared there. That is a two-sided contract, which is worth stating because I
     * changed one side of it and the test caught me: pointing these at the Governance
     * Tool's own `/api/governance/approvals` routes left four console actions calling
     * operations nobody had declared.
     *
     * The Governance Tool serves the workbench today at `/api/governance/approvals`,
     * documented in docs/applications/approval-workbench.md. The two surfaces are
     * deliberately separate: one is what an internal application is permitted to call
     * through the gateway, the other is what this deployment happens to serve.
     */
    /*
     * The routes the Governance Tool actually serves.
     *
     * Approve, reject and return share one endpoint because they differ only in the
     * action and the reason, while the authorization, freshness and maker-checker
     * questions are identical — three routes would be three places to forget that an
     * approval must come from a person.
     *
     * The paths stay on the `/internal/v1` gateway convention the descriptor schema
     * enforces — these describe the gateway contract, not the Governance Tool's own
     * `/api/governance/approvals` routes that serve it today. What changed is the shape:
     * they previously declared three separate per-task endpoints, and the application
     * has one decision endpoint, because approve, reject and return differ only in the
     * action and the reason.
     */
    actions: [
      action(
        'approve',
        'Approve',
        R.API_WORKFLOW,
        '/internal/v1/operations/tasks/:taskId/approve',
        { reversible: false },
      ),
      action('reject', 'Reject', R.API_WORKFLOW, '/internal/v1/operations/tasks/:taskId/reject', {
        reversible: false,
      }),
      action(
        'return',
        'Return for rework',
        R.API_WORKFLOW,
        '/internal/v1/operations/tasks/:taskId/return',
      ),
      action(
        'reassign',
        'Reassign',
        R.API_WORKFLOW,
        '/internal/v1/operations/tasks/:taskId/reassign',
      ),
    ],
    pages: [
      page('queue', 'Pending', GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key, [
        {
          id: 'pending',
          kind: 'approval',
          dataSourceId: 'pending',
          actionIds: ['approve', 'reject', 'return', 'reassign'],
          fields: ['taskId', 'subject', 'requestedBy', 'dueAt', 'slaBreached'],
        },
      ]),
      page('history', 'History', GOVERNANCE_PERMISSIONS.APPROVAL_WORKBENCH.key, [
        {
          id: 'decisions',
          kind: 'table',
          dataSourceId: 'history',
          actionIds: [],
          fields: ['taskId', 'decision', 'actorId', 'decidedAt', 'reason'],
        },
      ]),
    ],
  });
}

// --- 9. case management -----------------------------------------------------

export function caseManagementWorkbench(): InternalApplication {
  return console_({
    appId: 'case-management',
    name: 'Case Management',
    description:
      'Case queue, ownership, priority, SLA, tasks, comments, evidence, timeline and closure.',
    businessPurpose:
      'The shared case surface every other console opens into, so a case looks the same to support, risk and operations.',
    dataClassification: 'restricted',
    riskClassification: 'high',
    roles: ['operations', 'customer_support', 'risk', 'compliance'],
    dataSources: [
      source('cases', R.API_CASE, ['caseId', 'type', 'status', 'priority', 'owner', 'slaDueAt'], {
        operation: 'read',
      }),
      source('timeline', R.API_CASE, ['entryId', 'kind', 'actorId', 'occurredAt'], {
        operation: 'read',
      }),
    ],
    actions: [
      action('assign', 'Assign', R.API_CASE, '/internal/v1/operations/cases/:caseId/assign', {
        requiresReason: false,
      }),
      action('comment', 'Comment', R.API_CASE, '/internal/v1/operations/cases/:caseId/comments', {
        requiresReason: false,
      }),
      action('escalate', 'Escalate', R.API_CASE, '/internal/v1/operations/cases/:caseId/escalate'),
      action('close', 'Close', R.API_CASE, '/internal/v1/operations/cases/:caseId/close', {
        reversible: false,
      }),
    ],
    pages: [
      page('queue', 'Queue', GOVERNANCE_PERMISSIONS.CASE_WORKBENCH.key, [
        {
          id: 'cases',
          kind: 'case',
          dataSourceId: 'cases',
          actionIds: ['assign', 'escalate'],
          fields: ['caseId', 'type', 'status', 'priority', 'owner', 'slaDueAt'],
        },
      ]),
      page('case', 'Case', GOVERNANCE_PERMISSIONS.CASE_WORKBENCH.key, [
        {
          id: 'detail',
          kind: 'detail',
          dataSourceId: 'cases',
          actionIds: ['comment', 'close'],
          fields: ['caseId', 'type', 'status', 'priority', 'owner', 'slaDueAt'],
        },
        {
          id: 'timeline',
          kind: 'timeline',
          dataSourceId: 'timeline',
          actionIds: [],
          fields: ['entryId', 'kind', 'actorId', 'occurredAt'],
        },
      ]),
    ],
  });
}

// --- 10. generic dashboard --------------------------------------------------

export function genericDashboard(): InternalApplication {
  return console_({
    appId: 'generic-dashboard',
    name: 'Generic Dashboard',
    description: 'KPI cards, trends, tables and filters over approved reporting sources.',
    businessPurpose:
      'A starting point for a team that needs a read-only view and should not have to build a console to get one.',
    dataClassification: 'internal',
    riskClassification: 'low',
    roles: ['operations', 'finance', 'product_owner'],
    dataSources: [
      source('summary', R.REPORTING_TRANSACTIONS, [
        'period',
        'count',
        'successRate',
        'totalMinorUnits',
      ]),
      source('reference', R.REFERENCE_DATA, ['domain', 'code', 'label'], { operation: 'read' }),
    ],
    actions: [],
    pages: [
      page('overview', 'Overview', GOVERNANCE_PERMISSIONS.APP_READ.key, [
        {
          id: 'kpis',
          kind: 'kpi',
          dataSourceId: 'summary',
          actionIds: [],
          fields: ['count', 'successRate', 'totalMinorUnits'],
        },
        {
          id: 'trend',
          kind: 'chart',
          dataSourceId: 'summary',
          actionIds: [],
          fields: ['period', 'count'],
        },
        {
          id: 'filters',
          kind: 'filter',
          dataSourceId: 'reference',
          actionIds: [],
          fields: ['domain', 'code', 'label'],
        },
      ]),
    ],
  });
}

// --- 11. enterprise governance ----------------------------------------------

/**
 * The Enterprise Governance Console.
 *
 * The navigation the phase-13 specification asks for, as an internal application definition.
 *
 * Two things about it are worth reading before adapting it.
 *
 * **Every data source is Class B.** Not one of them reads a reporting replica. The other consoles
 * mix Class A reporting reads with Class B authoritative calls, which is right for them — a
 * transaction list is a report. A policy version is not: reading it from anywhere but the
 * authoritative API means reading a rule from a surface where nothing checks whether the version
 * found is the one in force.
 *
 * **Every action is a request.** `propose-classification`, `request-policy-activation`,
 * `request-dr-activation` — the verbs are deliberate. Each one calls an API that applies the
 * segregation the framework requires, so a console user who holds the proposing permission cannot
 * complete the approval by clicking a second button. Naming them `approve-*` would be shorter and
 * would misdescribe what the console can do.
 */
export function enterpriseGovernanceConsole(): InternalApplication {
  return console_({
    appId: 'enterprise-governance-console',
    name: 'Enterprise Governance Console',
    description:
      'Data governance, policy, SRE, API management and continuity, over the authoritative TrustOS APIs.',
    businessPurpose:
      'Gives the people accountable for governance one place to see the estate and to raise the requests that change it.',
    dataClassification: 'restricted',
    riskClassification: 'high',
    roles: ['platform_admin', 'compliance', 'operations'],
    dataSources: [
      source(
        'catalog',
        R.API_DATA_CATALOG,
        ['entryId', 'kind', 'classification', 'owner', 'businessName'],
        {
          operation: 'read',
        },
      ),
      source('lineage', R.API_DATA_LINEAGE, ['entryId', 'declared', 'propagated'], {
        operation: 'read',
      }),
      source('policies', R.API_POLICY, ['policyId', 'version', 'status', 'category', 'owner'], {
        operation: 'read',
      }),
      source(
        'decisions',
        R.API_POLICY_DECISIONS,
        ['decisionId', 'policyId', 'policyVersion', 'decision'],
        {
          operation: 'read',
        },
      ),
      source(
        'services',
        R.API_SRE_SERVICE,
        ['serviceId', 'tier', 'ownerTeam', 'onCallRotation', 'health'],
        {
          operation: 'read',
        },
      ),
      source('objectives', R.API_SRE_SLO, ['sloId', 'target', 'verdict', 'budgetState'], {
        operation: 'read',
      }),
      source('incidents', R.API_SRE_INCIDENT, ['incidentId', 'severity', 'state', 'ownerId'], {
        operation: 'read',
      }),
      source(
        'apis',
        R.API_API_CATALOG,
        ['apiId', 'version', 'lifecycle', 'classification', 'consumers'],
        {
          operation: 'read',
        },
      ),
      source('consumers', R.API_API_CONSUMER, ['consumerId', 'kind', 'status', 'environment'], {
        operation: 'read',
      }),
      source('backups', R.API_BACKUP, ['backupId', 'source', 'completedAt', 'statement'], {
        operation: 'read',
      }),
      source('dr-plans', R.API_DR_PLAN, ['planId', 'scenario', 'rtoMinutes', 'statement'], {
        operation: 'read',
      }),
      source('continuity', R.API_CONTINUITY, ['processId', 'criticality', 'rtoMinutes', 'state'], {
        operation: 'read',
      }),
    ],
    actions: [
      /*
       * A proposal, not a reclassification.
       *
       * Lowering a classification makes previously-restricted data readable, and every downstream
       * control reads the label. The API records the proposal; an approver with a different
       * permission acts on it.
       */
      action(
        'propose-classification',
        'Propose classification',
        R.API_DATA_CATALOG,
        '/internal/v1/enterprise/data/catalog/:entryId/classification',
        { requiresApproval: true, reversible: false },
      ),
      action(
        'simulate-policy',
        'Simulate policy',
        R.API_POLICY,
        '/internal/v1/enterprise/policies/simulate',
        { requiresReason: false, reversible: true },
      ),
      /*
       * Activation is requested here and refused by the API when the requester authored the
       * policy. The console cannot know that — the author is on the document, not on the session —
       * which is precisely why the check belongs in the API.
       */
      action(
        'request-policy-activation',
        'Request activation',
        R.API_POLICY,
        '/internal/v1/enterprise/policies/:policyId/versions/:version/activate',
        { requiresApproval: true, reversible: false },
      ),
      action(
        'declare-incident',
        'Declare incident',
        R.API_SRE_INCIDENT,
        '/internal/v1/sre/incidents',
        { reversible: false },
      ),
      action(
        'record-restore-test',
        'Record restore test',
        R.API_BACKUP,
        '/internal/v1/enterprise/continuity/restore-tests',
        { reversible: false },
      ),
      /*
       * Activating a DR plan moves production. It is a request with an approval, and the API
       * refuses an unexercised plan unless somebody overrides it with a reason that will be read
       * during the review.
       */
      action(
        'request-dr-activation',
        'Request DR activation',
        R.API_DR_PLAN,
        '/internal/v1/enterprise/continuity/dr-plans/:planId/activate',
        { requiresApproval: true, reversible: false },
      ),
    ],
    pages: [
      page('data-governance', 'Data Governance', GOVERNANCE_PERMISSIONS.APP_READ.key, [
        {
          id: 'catalog',
          kind: 'table',
          dataSourceId: 'catalog',
          actionIds: ['propose-classification'],
          fields: ['entryId', 'kind', 'classification', 'owner', 'businessName'],
        },
        {
          id: 'lineage',
          kind: 'table',
          dataSourceId: 'lineage',
          actionIds: [],
          fields: ['entryId', 'declared', 'propagated'],
        },
      ]),
      page('policies', 'Policies', GOVERNANCE_PERMISSIONS.APP_READ.key, [
        {
          id: 'registry',
          kind: 'table',
          dataSourceId: 'policies',
          actionIds: ['simulate-policy', 'request-policy-activation'],
          fields: ['policyId', 'version', 'status', 'category', 'owner'],
        },
        {
          id: 'decisions',
          kind: 'table',
          dataSourceId: 'decisions',
          actionIds: [],
          fields: ['decisionId', 'policyId', 'policyVersion', 'decision'],
        },
      ]),
      page('sre', 'SRE', GOVERNANCE_PERMISSIONS.APP_READ.key, [
        {
          id: 'services',
          kind: 'table',
          dataSourceId: 'services',
          actionIds: [],
          fields: ['serviceId', 'tier', 'ownerTeam', 'onCallRotation', 'health'],
        },
        {
          id: 'objectives',
          kind: 'table',
          dataSourceId: 'objectives',
          actionIds: [],
          fields: ['sloId', 'target', 'verdict', 'budgetState'],
        },
        {
          id: 'incidents',
          kind: 'table',
          dataSourceId: 'incidents',
          actionIds: ['declare-incident'],
          fields: ['incidentId', 'severity', 'state', 'ownerId'],
        },
      ]),
      page('apis', 'APIs', GOVERNANCE_PERMISSIONS.APP_READ.key, [
        {
          id: 'catalog',
          kind: 'table',
          dataSourceId: 'apis',
          actionIds: [],
          fields: ['apiId', 'version', 'lifecycle', 'classification', 'consumers'],
        },
        {
          id: 'consumers',
          kind: 'table',
          dataSourceId: 'consumers',
          actionIds: [],
          fields: ['consumerId', 'kind', 'status', 'environment'],
        },
      ]),
      page('continuity', 'Continuity', GOVERNANCE_PERMISSIONS.APP_READ.key, [
        {
          id: 'processes',
          kind: 'table',
          dataSourceId: 'continuity',
          actionIds: [],
          fields: ['processId', 'criticality', 'rtoMinutes', 'state'],
        },
        {
          id: 'backups',
          kind: 'table',
          dataSourceId: 'backups',
          actionIds: ['record-restore-test'],
          fields: ['backupId', 'source', 'completedAt', 'statement'],
        },
        {
          id: 'dr-plans',
          kind: 'table',
          dataSourceId: 'dr-plans',
          actionIds: ['request-dr-activation'],
          fields: ['planId', 'scenario', 'rtoMinutes', 'statement'],
        },
      ]),
    ],
  });
}

export interface ConsoleTemplate {
  id: string;
  name: string;
  description: string;
  build: () => InternalApplication;
}

export const CONSOLE_TEMPLATES: readonly ConsoleTemplate[] = Object.freeze([
  {
    id: 'operations-console',
    name: 'Operations Console',
    description: 'Transactions, queues, exceptions, provider health.',
    build: operationsConsole,
  },
  {
    id: 'customer-support-console',
    name: 'Customer Support Console',
    description: 'Customer search, timeline, cases, notifications.',
    build: customerSupportConsole,
  },
  {
    id: 'risk-compliance-console',
    name: 'Risk & Compliance Console',
    description: 'Alerts, KYC and AML cases, investigation, escalation.',
    build: riskComplianceConsole,
  },
  {
    id: 'finance-console',
    name: 'Finance Operations Console',
    description: 'Settlement, reconciliation, fees, the GL summary.',
    build: financeConsole,
  },
  {
    id: 'financial-product-studio',
    name: 'Financial Product Studio',
    description: 'Compose, exercise and submit a financial product.',
    build: financialProductStudio,
  },
  {
    id: 'ai-operations-console',
    name: 'AI Operations Console',
    description: 'Models, prompts, guardrails, cost, human review.',
    build: aiOperationsConsole,
  },
  {
    id: 'platform-admin-console',
    name: 'Platform Administration Console',
    description: 'Tenants, roles, credentials, health, audit.',
    build: platformAdminConsole,
  },
  {
    id: 'approval-workbench',
    name: 'Approval Workbench',
    description: 'One queue for every approval a person owns.',
    build: approvalWorkbench,
  },
  {
    id: 'case-management',
    name: 'Case Management',
    description: 'The shared case surface every console opens into.',
    build: caseManagementWorkbench,
  },
  {
    id: 'generic-dashboard',
    name: 'Generic Dashboard',
    description: 'A read-only view over approved reporting sources.',
    build: genericDashboard,
  },
  {
    id: 'enterprise-governance-console',
    name: 'Enterprise Governance Console',
    description: 'Data governance, policy, SRE, APIs and continuity, over authoritative APIs only.',
    build: enterpriseGovernanceConsole,
  },
]);

export function findConsoleTemplate(id: string): ConsoleTemplate | undefined {
  return CONSOLE_TEMPLATES.find((template) => template.id === id);
}
