import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import { STANDARD_RESOURCE_IDS, type ResourceOperation } from '@trustsystem/governance-tool-core';

/**
 * The typed operations an internal application may call.
 *
 * A catalog, not a client. Each entry says: this gateway path exists, it maps to this TrustOS
 * resource, it is this kind of operation, it needs this permission on the *API* side, and it
 * carries these parameters.
 *
 * The reason it is a catalog rather than a set of functions: the gateway needs to answer "is this
 * path a real operation, and which resource does it touch" for a request it has never seen, and a
 * set of functions cannot be asked that. The catalog can, and it is what makes an internal
 * application's declared actions checkable against something.
 *
 * **No business logic lives here.** Every entry is a mapping. A helper that computed something —
 * a fee, an eligibility, a total — would be a second implementation of whatever it computed, in
 * the layer specifically designated as not being the system of record.
 */

export const gatewayOperationSchema = z
  .object({
    operationId: z.string().regex(/^[a-z][a-zA-Z0-9]{2,59}$/),
    /** The gateway path, with `:params`. */
    path: z
      .string()
      .regex(/^\/internal\/v1\/[A-Za-z0-9\-/:{}]{1,180}$/)
      .refine((value) => !value.includes('..'), 'A path may not contain "..".'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    /** The TrustOS resource this reaches. Checked against the registry. */
    resourceId: z.string().min(1).max(120),
    operation: z.enum(['read', 'search', 'aggregate', 'create', 'update', 'delete', 'execute']),
    /**
     * The permission the **TrustOS API** requires.
     *
     * Distinct from the Governance Tool permission on the action, which decides whether a button
     * renders. This one is the authorization, and it is checked by the API rather than here.
     */
    apiPermission: z.string().min(3).max(80),
    /** Whether the operation creates something and therefore needs an idempotency key. */
    createsRecord: z.boolean().default(false),
    description: z.string().min(1).max(300),
  })
  .strict()
  .superRefine((operation, ctx) => {
    if (operation.createsRecord && operation.method === 'GET') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['method'],
        message: 'A GET that creates something will be retried by every proxy on the path.',
      });
    }
  });

export type GatewayOperation = z.infer<typeof gatewayOperationSchema>;

const R = STANDARD_RESOURCE_IDS;

function operation(input: {
  id: string;
  path: string;
  method?: GatewayOperation['method'];
  resourceId: string;
  operation?: ResourceOperation;
  apiPermission: string;
  createsRecord?: boolean;
  description: string;
}): GatewayOperation {
  return gatewayOperationSchema.parse({
    operationId: input.id,
    path: input.path,
    method: input.method ?? 'POST',
    resourceId: input.resourceId,
    operation: input.operation ?? 'execute',
    apiPermission: input.apiPermission,
    createsRecord: input.createsRecord ?? false,
    description: input.description,
  });
}

/**
 * The operations the console templates need.
 *
 * Every path a console template declares appears here, which is what makes the two checkable
 * against each other — a console naming a path this catalog does not carry is a console calling
 * something that does not exist, and it is better to find that at review than at 3am.
 */
export const GATEWAY_OPERATIONS: readonly GatewayOperation[] = Object.freeze([
  // --- operations ---------------------------------------------------------
  operation({
    id: 'retryJob',
    path: '/internal/v1/operations/jobs/:jobId/retry',
    resourceId: R.API_WORKFLOW,
    apiPermission: 'workflow.instance.transition',
    description: 'Asks the platform to retry a failed job.',
  }),
  operation({
    id: 'escalateTask',
    path: '/internal/v1/operations/tasks/:taskId/escalate',
    resourceId: R.API_WORKFLOW,
    apiPermission: 'workflow.task.escalate',
    description: 'Escalates a task past its SLA.',
  }),
  operation({
    id: 'approveTask',
    path: '/internal/v1/operations/tasks/:taskId/approve',
    resourceId: R.API_WORKFLOW,
    apiPermission: 'workflow.instance.approve',
    description: 'Records an approval decision.',
  }),
  operation({
    id: 'rejectTask',
    path: '/internal/v1/operations/tasks/:taskId/reject',
    resourceId: R.API_WORKFLOW,
    apiPermission: 'workflow.instance.approve',
    description: 'Records a rejection, with a reason.',
  }),
  operation({
    id: 'returnTask',
    path: '/internal/v1/operations/tasks/:taskId/return',
    resourceId: R.API_WORKFLOW,
    apiPermission: 'workflow.instance.approve',
    description: 'Returns a request for rework.',
  }),
  operation({
    id: 'reassignTask',
    path: '/internal/v1/operations/tasks/:taskId/reassign',
    resourceId: R.API_WORKFLOW,
    apiPermission: 'workflow.task.reassign',
    description: 'Reassigns a task to another holder.',
  }),
  operation({
    id: 'openCase',
    path: '/internal/v1/operations/cases',
    resourceId: R.API_CASE,
    apiPermission: 'workflow.case.create',
    createsRecord: true,
    description: 'Opens a case.',
  }),
  operation({
    id: 'assignCase',
    path: '/internal/v1/operations/cases/:caseId/assign',
    resourceId: R.API_CASE,
    apiPermission: 'workflow.case.update',
    description: 'Assigns a case owner.',
  }),
  operation({
    id: 'commentCase',
    path: '/internal/v1/operations/cases/:caseId/comments',
    resourceId: R.API_CASE,
    apiPermission: 'workflow.case.comment',
    createsRecord: true,
    description: 'Adds a comment to a case.',
  }),
  operation({
    id: 'escalateCase',
    path: '/internal/v1/operations/cases/:caseId/escalate',
    resourceId: R.API_CASE,
    apiPermission: 'workflow.case.update',
    description: 'Escalates a case.',
  }),
  operation({
    id: 'closeCase',
    path: '/internal/v1/operations/cases/:caseId/close',
    resourceId: R.API_CASE,
    apiPermission: 'workflow.case.close',
    description: 'Closes a case.',
  }),

  // --- support -------------------------------------------------------------
  operation({
    id: 'supportOpenCase',
    path: '/internal/v1/support/cases',
    resourceId: R.API_CASE,
    apiPermission: 'workflow.case.create',
    createsRecord: true,
    description: 'Opens a support case.',
  }),
  operation({
    id: 'supportAddNote',
    path: '/internal/v1/support/cases/:caseId/notes',
    resourceId: R.API_CASE,
    apiPermission: 'workflow.case.comment',
    createsRecord: true,
    description: 'Adds a support note.',
  }),
  operation({
    id: 'requestWalletFreeze',
    path: '/internal/v1/support/wallets/:walletRef/freeze-requests',
    resourceId: R.API_WALLET,
    apiPermission: 'wallet.freeze.request',
    createsRecord: true,
    description: 'Requests a wallet freeze through maker-checker. Does not freeze.',
  }),
  operation({
    id: 'revealCustomer',
    path: '/internal/v1/support/customers/:customerRef/reveal',
    resourceId: R.API_CUSTOMER,
    operation: 'read',
    apiPermission: 'governance.pii.reveal',
    createsRecord: true,
    description: 'Reveals masked contact details for a bounded window, with a reason.',
  }),
  operation({
    id: 'createReveal',
    path: '/internal/v1/support/reveals',
    resourceId: R.API_CUSTOMER,
    operation: 'read',
    apiPermission: 'governance.pii.reveal',
    createsRecord: true,
    description: 'Requests a reveal.',
  }),

  // --- risk and compliance --------------------------------------------------
  operation({
    id: 'assignRiskCase',
    path: '/internal/v1/risk/cases/:caseId/assign',
    resourceId: R.API_CASE,
    apiPermission: 'workflow.case.update',
    description: 'Assigns a risk case.',
  }),
  operation({
    id: 'escalateRiskCase',
    path: '/internal/v1/risk/cases/:caseId/escalate',
    resourceId: R.API_CASE,
    apiPermission: 'workflow.case.update',
    description: 'Escalates a risk case.',
  }),
  operation({
    id: 'requestInformation',
    path: '/internal/v1/risk/cases/:caseId/information-requests',
    resourceId: R.API_CASE,
    apiPermission: 'workflow.case.update',
    createsRecord: true,
    description: 'Requests information on a case.',
  }),
  operation({
    id: 'resolveRiskCase',
    path: '/internal/v1/risk/cases/:caseId/resolve',
    resourceId: R.API_CASE,
    apiPermission: 'workflow.case.close',
    description: 'Resolves a risk case.',
  }),
  operation({
    id: 'recordRiskDecision',
    path: '/internal/v1/risk/tasks/:taskId/decisions',
    resourceId: R.API_WORKFLOW,
    apiPermission: 'workflow.instance.approve',
    createsRecord: true,
    description: 'Records a compliance decision.',
  }),
  operation({
    id: 'revealRiskSubject',
    path: '/internal/v1/risk/customers/:customerRef/reveal',
    resourceId: R.API_CUSTOMER,
    operation: 'read',
    apiPermission: 'governance.pii.reveal',
    createsRecord: true,
    description: 'Reveals a subject identity for an investigation.',
  }),

  // --- finance --------------------------------------------------------------
  operation({
    id: 'requestAdjustment',
    path: '/internal/v1/finance/adjustments/requests',
    resourceId: R.API_LEDGER,
    apiPermission: 'financial.adjustment.request',
    createsRecord: true,
    description: 'Requests a ledger adjustment through maker-checker. Does not post.',
  }),
  operation({
    id: 'resolveReconciliation',
    path: '/internal/v1/finance/reconciliation/:exceptionId/resolve',
    resourceId: R.API_RECONCILIATION,
    apiPermission: 'financial.reconciliation.resolve',
    description: 'Resolves a reconciliation exception.',
  }),
  operation({
    id: 'requestFinanceExport',
    path: '/internal/v1/finance/exports',
    resourceId: R.REPORTING_SETTLEMENTS,
    operation: 'read',
    apiPermission: 'governance.export.request',
    createsRecord: true,
    description: 'Requests a finance export.',
  }),

  // --- products --------------------------------------------------------------
  operation({
    id: 'createProductDraft',
    path: '/internal/v1/products/drafts',
    resourceId: R.API_PRODUCT,
    apiPermission: 'financial.product.create',
    createsRecord: true,
    description: 'Creates a draft financial product.',
  }),
  operation({
    id: 'validateProduct',
    path: '/internal/v1/products/:productId/validate',
    resourceId: R.API_PRODUCT,
    operation: 'read',
    apiPermission: 'financial.product.validate',
    description: 'Validates a draft product.',
  }),
  operation({
    id: 'sandboxProduct',
    path: '/internal/v1/products/:productId/sandbox',
    resourceId: R.API_PRODUCT,
    apiPermission: 'financial.product.sandbox',
    description: 'Runs a product against mock providers.',
  }),
  operation({
    id: 'simulateProduct',
    path: '/internal/v1/products/:productId/simulate',
    resourceId: R.API_PRODUCT,
    apiPermission: 'financial.product.simulate',
    description: 'Runs a volume simulation.',
  }),
  operation({
    id: 'submitProduct',
    path: '/internal/v1/products/:productId/submit',
    resourceId: R.API_PRODUCT,
    apiPermission: 'financial.product.submit',
    description: 'Submits a product for approval. There is no publish here.',
  }),

  // --- platform --------------------------------------------------------------
  operation({
    id: 'requestRoleChange',
    path: '/internal/v1/platform/role-changes/requests',
    resourceId: R.API_RBAC,
    apiPermission: 'rbac.role.assign',
    createsRecord: true,
    description: 'Requests a role change through maker-checker.',
  }),
  operation({
    id: 'revokeApiKey',
    path: '/internal/v1/platform/api-keys/:keyPrefix/revoke',
    resourceId: R.API_API_KEYS,
    apiPermission: 'api_key.revoke',
    description: 'Revokes an API key by its prefix. There is no reveal.',
  }),
  operation({
    id: 'requestExport',
    path: '/internal/v1/platform/exports',
    resourceId: R.REPORTING_TRANSACTIONS,
    operation: 'read',
    apiPermission: 'governance.export.request',
    createsRecord: true,
    description: 'Requests an export.',
  }),

  // --- AI ---------------------------------------------------------------------
  operation({
    id: 'recordAiReview',
    path: '/internal/v1/ai/reviews/:reviewId/decisions',
    resourceId: R.API_AI,
    apiPermission: 'governance.ai.review',
    createsRecord: true,
    description: 'Records a human review decision on an AI output.',
  }),
  // --- enterprise governance (phase 13) -------------------------------------
  //
  // Every one of these reaches an authoritative API rather than a replica, and every one that
  // changes something is a *request*: the API applies the segregation the framework requires, so
  // holding the proposing permission in the console cannot complete an approval.
  operation({
    id: 'proposeClassification',
    path: '/internal/v1/enterprise/data/catalog/:entryId/classification',
    resourceId: R.API_DATA_CATALOG,
    apiPermission: 'enterprise.data.classify',
    createsRecord: true,
    description:
      'Proposes a classification change. An approver with a different permission acts on it.',
  }),
  operation({
    id: 'simulatePolicy',
    path: '/internal/v1/enterprise/policies/simulate',
    resourceId: R.API_POLICY,
    operation: 'read',
    apiPermission: 'enterprise.policy.simulate',
    description: 'Evaluates a policy — including a draft — without enforcing or recording it.',
  }),
  operation({
    id: 'requestPolicyActivation',
    path: '/internal/v1/enterprise/policies/:policyId/versions/:version/activate',
    resourceId: R.API_POLICY,
    apiPermission: 'enterprise.policy.activate',
    createsRecord: true,
    description: 'Requests activation of a policy version. Refused when the requester authored it.',
  }),
  operation({
    id: 'declareIncident',
    path: '/internal/v1/sre/incidents',
    resourceId: R.API_SRE_INCIDENT,
    apiPermission: 'sre.incident.declare',
    createsRecord: true,
    description: 'Declares an incident with a severity the caller states.',
  }),
  operation({
    id: 'recordRestoreTest',
    path: '/internal/v1/enterprise/continuity/restore-tests',
    resourceId: R.API_BACKUP,
    apiPermission: 'enterprise.continuity.write',
    createsRecord: true,
    description: 'Records a restore test, completing the backup it validates.',
  }),
  operation({
    id: 'requestDrActivation',
    path: '/internal/v1/enterprise/continuity/dr-plans/:planId/activate',
    resourceId: R.API_DR_PLAN,
    apiPermission: 'enterprise.continuity.dr.activate',
    createsRecord: true,
    description:
      'Activates a DR plan. Refused for an unexercised plan without a recorded override.',
  }),
]);

/**
 * Finds the declared operation for a method and a path.
 *
 * Segment by segment, with a declared `:param` matching **one** concrete segment. Not a prefix
 * match and not a regular expression over the whole path: a prefix match sends
 * `/internal/v1/operations/cases/../../platform/role-changes` somewhere, and "somewhere" in a
 * gateway is a sentence that ends badly.
 *
 * A concrete segment of `..` or an empty one never matches a parameter, so a traversal is a
 * lookup failure rather than a route.
 */
export function findOperation(method: string, path: string): GatewayOperation | null {
  const requested = path.split('/').filter(Boolean);

  for (const operation of GATEWAY_OPERATIONS) {
    if (operation.method !== method) continue;

    const declared = operation.path.split('/').filter(Boolean);
    if (declared.length !== requested.length) continue;

    let matched = true;

    for (const [index, segment] of declared.entries()) {
      const actual = requested[index] as string;

      if (segment.startsWith(':')) {
        if (actual.length === 0 || actual === '..' || actual === '.') {
          matched = false;
          break;
        }
        continue;
      }

      if (segment !== actual) {
        matched = false;
        break;
      }
    }

    if (matched) return operation;
  }

  return null;
}

/**
 * Refuses a path the catalog does not declare.
 *
 * Called by the gateway before routing. An internal application calling an undeclared path is
 * calling something nobody mapped to a resource — so nobody classified it, and the access class
 * check has nothing to check.
 */
export function requireOperation(method: string, path: string): GatewayOperation {
  const operation = findOperation(method, path);

  if (!operation) {
    throw new ApiError('not_found', {
      message:
        `${method} ${path} is not a declared internal operation. An undeclared path is a path ` +
        'nobody mapped to a resource, so nothing classified it and the access check has nothing ' +
        'to check.',
      context: { method, path },
    });
  }

  return operation;
}

/** Every operation touching a resource. What "which tools can write to the ledger" is answered with. */
export function operationsForResource(resourceId: string): GatewayOperation[] {
  return GATEWAY_OPERATIONS.filter((entry) => entry.resourceId === resourceId);
}
