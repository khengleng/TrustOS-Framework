import {
  GOVERNANCE_PERMISSIONS,
  STANDARD_RESOURCE_IDS,
  internalApplicationSchema,
  type InternalApplication,
} from '@trustsystem/governance-tool-core';

/**
 * §11: the Merchant Operations Console.
 *
 * An internal application definition the Governance Tool runtime executes. It is *data*, not code,
 * which is the whole shape of the Governance Tool: a console is a document describing what to show
 * and what to call, and the runtime enforces the rules.
 *
 * Two of those rules do the work here, and both are enforced by the schema rather than by review:
 *
 * **Every data source names a registered resource.** There is no query. A console cannot select
 * from a table, so "the console must not read the production database directly" is not a policy
 * somebody follows — it is a sentence with nowhere to be violated.
 *
 * **Every action names a gateway path.** There is no direct write, in any console, anywhere. The
 * console asks the platform to freeze a wallet; it does not freeze one.
 *
 * The verbs are deliberate. `approve-merchant` calls the API that refuses an approver who verified
 * the merchant — the console cannot know who verified it, because that is on the record rather
 * than in the session, which is precisely why the check belongs in the API.
 */
export function merchantOperationsConsole(): InternalApplication {
  const R = STANDARD_RESOURCE_IDS;

  const source = (
    id: string,
    resourceId: string,
    fields: string[],
    operation: 'search' | 'read' = 'search',
  ) => ({
    id,
    resourceId,
    operation,
    parameters: [],
    fields,
    fieldExceptions: [],
    maxRows: 200,
  });

  const action = (
    id: string,
    label: string,
    resourceId: string,
    apiPath: string,
    options: Record<string, unknown> = {},
  ) => ({
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
  });

  return internalApplicationSchema.parse({
    appId: 'merchant-operations-console',
    name: 'Merchant Operations Console',
    description:
      'Merchants, the approval queue, wallets, transactions, settlements, reconciliation exceptions and service health.',
    businessPurpose:
      'Gives merchant operations one place to see what is waiting and to ask the platform to act on it.',
    dataClassification: 'restricted',
    riskClassification: 'high',
    roles: ['operations', 'platform_admin', 'compliance'],
    owner: 'role:platform-engineering',
    businessOwner: 'role:operations',
    technicalOwner: 'role:platform-engineering',
    environment: 'dev',
    lifecycleStatus: 'draft',
    version: '1.0.0',
    aiFeatures: [
      // The four the pilot specification names. Each summarizes or explains; none acts.
      'summarize_merchant',
      'explain_transaction_failure',
      'explain_reconciliation_exception',
      'draft_investigation_notes',
    ],
    lastSecurityReview: null,
    nextSecurityReview: '2026-12-31T00:00:00.000Z',
    dataSources: [
      source(
        'merchants',
        R.API_MERCHANT,
        ['merchantId', 'tradingName', 'status', 'categoryCode'],
        'read',
      ),
      source('approval-queue', R.API_WORKFLOW, ['taskId', 'state', 'assignee', 'dueAt'], 'read'),
      source('wallets', R.API_WALLET, ['walletId', 'ownerId', 'currency', 'status'], 'read'),
      source('transactions', R.REPORTING_TRANSACTIONS, [
        'reference',
        'status',
        'amountMinorUnits',
        'currency',
        'createdAt',
      ]),
      source('failed-transactions', R.REPORTING_EXCEPTIONS, [
        'exceptionId',
        'type',
        'ageHours',
        'status',
      ]),
      source('settlements', R.REPORTING_SETTLEMENTS, [
        'batchRef',
        'status',
        'totalMinorUnits',
        'windowEnd',
      ]),
      source('reconciliation', R.API_RECONCILIATION, ['exceptionId', 'kind', 'ageHours'], 'read'),
      source('audit', R.API_AUDIT, ['action', 'actorId', 'entityId', 'occurredAt'], 'read'),
      source('health', R.API_HEALTH, ['providerInterface', 'status', 'checkedAt'], 'read'),
    ],
    actions: [
      /*
       * Approve, and the API refuses an approver who verified the merchant.
       *
       * The console cannot make that check: who verified it is on the record, not in the session.
       * That is the argument for the check living in the API rather than here — and for this
       * action being a call rather than a state change.
       */
      action(
        'approve-merchant',
        'Approve merchant',
        R.API_MERCHANT,
        '/internal/v1/merchants/:merchantId/approve',
        {
          requiresApproval: true,
          reversible: false,
        },
      ),
      action(
        'reject-merchant',
        'Reject merchant',
        R.API_MERCHANT,
        '/internal/v1/merchants/:merchantId/reject',
        {
          reversible: false,
        },
      ),
      action(
        'freeze-wallet',
        'Freeze wallet',
        R.API_WALLET,
        '/internal/v1/wallets/:walletId/freeze',
      ),
      /*
       * A *request*, not a change. The limit change is decided by somebody who did not raise it —
       * see docs/pilot/evidence/maker-checker.md for why the request shape matters.
       */
      action(
        'request-limit-change',
        'Request limit change',
        R.API_MERCHANT,
        '/internal/v1/merchants/:merchantId/limit-changes',
        { requiresApproval: true, reversible: false },
      ),
      action('open-case', 'Open case', R.API_CASE, '/internal/v1/operations/cases'),
    ],
    pages: [
      {
        id: 'merchants',
        title: 'Merchants',
        permission: GOVERNANCE_PERMISSIONS.APP_READ.key,
        components: [
          {
            id: 'merchant-list',
            kind: 'table',
            dataSourceId: 'merchants',
            actionIds: ['freeze-wallet', 'request-limit-change', 'open-case'],
            fields: ['merchantId', 'tradingName', 'status', 'categoryCode'],
          },
          {
            id: 'approval-queue',
            kind: 'table',
            dataSourceId: 'approval-queue',
            actionIds: ['approve-merchant', 'reject-merchant'],
            fields: ['taskId', 'state', 'assignee', 'dueAt'],
          },
        ],
      },
      {
        id: 'money',
        title: 'Wallets and transactions',
        permission: GOVERNANCE_PERMISSIONS.APP_READ.key,
        components: [
          {
            id: 'wallets',
            kind: 'table',
            dataSourceId: 'wallets',
            actionIds: ['freeze-wallet'],
            fields: ['walletId', 'ownerId', 'currency', 'status'],
          },
          {
            id: 'transactions',
            kind: 'table',
            dataSourceId: 'transactions',
            actionIds: [],
            fields: ['reference', 'status', 'amountMinorUnits', 'currency', 'createdAt'],
          },
          {
            id: 'failed',
            kind: 'table',
            dataSourceId: 'failed-transactions',
            actionIds: ['open-case'],
            fields: ['exceptionId', 'type', 'ageHours', 'status'],
          },
        ],
      },
      {
        id: 'settlement',
        title: 'Settlement and reconciliation',
        permission: GOVERNANCE_PERMISSIONS.APP_READ.key,
        components: [
          {
            id: 'settlements',
            kind: 'table',
            dataSourceId: 'settlements',
            actionIds: [],
            fields: ['batchRef', 'status', 'totalMinorUnits', 'windowEnd'],
          },
          {
            id: 'exceptions',
            kind: 'table',
            dataSourceId: 'reconciliation',
            actionIds: ['open-case'],
            fields: ['exceptionId', 'kind', 'ageHours'],
          },
        ],
      },
      {
        id: 'oversight',
        title: 'Audit and health',
        permission: GOVERNANCE_PERMISSIONS.APP_READ.key,
        components: [
          {
            id: 'audit',
            kind: 'table',
            dataSourceId: 'audit',
            actionIds: [],
            fields: ['action', 'actorId', 'entityId', 'occurredAt'],
          },
          {
            id: 'health',
            kind: 'table',
            dataSourceId: 'health',
            actionIds: [],
            fields: ['providerInterface', 'status', 'checkedAt'],
          },
        ],
      },
    ],
  });
}
