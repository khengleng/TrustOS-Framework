import type { AuthorizationRequest, Policy, PolicyResult } from '@trustsystem/authorization';
import {
  EDITABLE_STATUSES,
  EXECUTABLE_STATUSES,
  MAKER_CHECKER_FIELDS,
  FINANCIAL_PRODUCT_PERMISSIONS,
  type ProductLifecycleStatus,
} from '@trustsystem/financial-product-core';

/**
 * Financial product separation of duties, as policies on the phase 4 authorization engine.
 *
 * Every policy here can only **refuse** — none returns `allow` — so the set inherits default-deny
 * and adding a policy can only make the system stricter. That is why separation of duties lives
 * here rather than inside the registry: a check in a service covers one call path, and a policy
 * is evaluated by `PolicyAuthorizationGuard` on every route that declares a product action,
 * including one written next year by somebody who never read the registry.
 *
 * The engine cannot load a product in a guard — a guard runs before the handler — so the registry
 * calls `authorizer.assert` with the record in hand, passed through
 * `AuthorizationResource.attributes`. Build it with `productResource()`. Hand-assembling the
 * object is how a field gets misspelled, and **a policy that cannot find its field abstains** —
 * an abstaining separation-of-duty policy is a control that silently does not run, which is worse
 * than not having written it, because the runbook says it is there.
 */

export const PRODUCT_RESOURCE_TYPES = {
  PRODUCT: 'FinancialProduct',
  VERSION: 'FinancialProductVersion',
  VARIANT: 'FinancialProductVariant',
  EXECUTION: 'FinancialProductExecution',
  CONNECTOR: 'FinancialConnector',
} as const;

export type ProductResourceType =
  (typeof PRODUCT_RESOURCE_TYPES)[keyof typeof PRODUCT_RESOURCE_TYPES];

/**
 * The product facts a policy reads.
 *
 * Every field is loaded from the database by the caller. None of it comes from a request body,
 * and that is not a convention — it is the reason these policies are worth anything. A
 * client-supplied `authoredById` would make self-approval prevention a field the maker fills in.
 */
export interface ProductResourceAttributes {
  /** Who composed this version. The maker. */
  authoredById?: string | null;
  /** Who submitted it for review, when that is a different person. */
  submittedById?: string | null;
  lifecycleStatus?: ProductLifecycleStatus | null;
  /** Decisions already recorded against this version. */
  decisions?: Array<{ actorId: string; level: string; decision: 'approved' | 'rejected' }>;
  /** Fields this request would change. Derived server-side from a diff, never sent by a client. */
  changedPaths?: string[];
  /** The environment the execution would run in. */
  environment?: 'production' | 'sandbox' | null;
  /** Connectors approved for this tenant. A binding outside the list is a substitution. */
  approvedConnectorIds?: string[];
  /** The connector this request would bind. */
  requestedConnectorId?: string | null;
}

/**
 * Builds the resource a product policy expects.
 *
 * One constructor rather than object literals at every call site. `ownerId` is populated with the
 * author so the framework's own resource-ownership policy also sees it, and `status` with the
 * lifecycle status so `resourceStatusPolicy` can be configured against it.
 */
export function productResource(input: {
  type: ProductResourceType;
  id: string;
  organizationId: string | null;
  attributes: ProductResourceAttributes;
}): {
  type: string;
  id: string;
  organizationId: string | null;
  ownerId: string | null;
  status: string | null;
  attributes: Record<string, unknown>;
} {
  return {
    type: input.type,
    id: input.id,
    organizationId: input.organizationId,
    ownerId: input.attributes.authoredById ?? null,
    status: input.attributes.lifecycleStatus ?? null,
    attributes: { ...input.attributes } as Record<string, unknown>,
  };
}

function attributesOf(request: AuthorizationRequest): ProductResourceAttributes {
  return (request.resource?.attributes ?? {}) as ProductResourceAttributes;
}

function isProductResource(request: AuthorizationRequest, type?: ProductResourceType): boolean {
  const resourceType = request.resource?.type;
  if (!resourceType) return false;
  if (type) return resourceType === type;
  return (Object.values(PRODUCT_RESOURCE_TYPES) as string[]).includes(resourceType);
}

/**
 * Actions that count as an approval decision.
 *
 * An explicit set rather than a suffix match, for the reason `@trustsystem/workflow-policy` gives:
 * `endsWith('.approve')` also catches an action somebody adds later whose meaning is different,
 * and a set that silently grows is a control nobody re-reviewed.
 */
const APPROVAL_ACTIONS = new Set<string>([
  FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_APPROVE.key,
  'financial.product.reject',
]);

const PUBLICATION_ACTIONS = new Set<string>([
  FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_PUBLISH.key,
  FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_ROLLBACK.key,
]);

/**
 * A maker may not approve their own product.
 *
 * The single most important policy in the package. It compares the actor against the *recorded
 * author of the version*, which the caller loaded — never against a submitter field in a request.
 */
export const productSelfApprovalPolicy: Policy = {
  id: 'financial-product.self-approval',
  description: 'The author of a product version may not approve or reject it.',

  appliesTo: (request) => isProductResource(request) && APPROVAL_ACTIONS.has(request.action),

  evaluate: (request): PolicyResult | null => {
    const attributes = attributesOf(request);
    const actorId = request.actor?.userId ?? null;

    if (!actorId || attributes.authoredById === undefined) return null;

    if (attributes.authoredById === actorId) {
      return {
        effect: 'deny',
        reason:
          'The actor composed this version. A maker who can approve their own product is not a ' +
          'control; it is a log entry that looks like one.',
      };
    }

    if (attributes.submittedById && attributes.submittedById === actorId) {
      return {
        effect: 'deny',
        reason: 'The actor submitted this version for review and may not also decide it.',
      };
    }

    return null;
  },
};

/**
 * A maker may not publish their own product either.
 *
 * Separate from approval because they are separate acts and a deployment may separate the people
 * differently. The author is refused outright; the *approver* is refused only when they would be
 * the sole recorded decision, because in a two-person deployment the checker publishing what they
 * approved is a defensible configuration and refusing it would make the framework unusable at
 * that scale.
 */
export const productSelfPublicationPolicy: Policy = {
  id: 'financial-product.self-publication',
  description: 'The author may not publish their own version, and a sole approver may not either.',

  appliesTo: (request) => isProductResource(request) && PUBLICATION_ACTIONS.has(request.action),

  evaluate: (request): PolicyResult | null => {
    const attributes = attributesOf(request);
    const actorId = request.actor?.userId ?? null;

    if (!actorId || attributes.authoredById === undefined) return null;

    if (attributes.authoredById === actorId) {
      return {
        effect: 'deny',
        reason: 'The actor composed this version and may not publish it.',
      };
    }

    const approvals = (attributes.decisions ?? []).filter(
      (decision) => decision.decision === 'approved',
    );

    if (approvals.length === 1 && approvals[0]?.actorId === actorId) {
      return {
        effect: 'deny',
        reason:
          'The actor is the only recorded approver. Publishing on the strength of one’s own ' +
          'single approval collapses maker, checker and publisher into one person.',
      };
    }

    return null;
  },
};

/**
 * Nobody decides twice.
 *
 * An actor who already recorded a decision on this version cannot record a second. Without this,
 * a two-of-three approval requirement is satisfiable by one person clicking twice — which passes
 * every count-based check, because the count is right.
 */
export const productDuplicateDecisionPolicy: Policy = {
  id: 'financial-product.duplicate-decision',
  description: 'An actor may record at most one decision on a product version.',

  appliesTo: (request) => isProductResource(request) && APPROVAL_ACTIONS.has(request.action),

  evaluate: (request): PolicyResult | null => {
    const attributes = attributesOf(request);
    const actorId = request.actor?.userId ?? null;

    if (!actorId || !attributes.decisions) return null;

    return attributes.decisions.some((decision) => decision.actorId === actorId)
      ? {
          effect: 'deny',
          reason:
            'The actor has already recorded a decision on this version. Two decisions from one ' +
            'person satisfies a two-of-three requirement with one person.',
        }
      : null;
  },
};

/**
 * A change that moves money may not travel as a generic edit.
 *
 * `financial.product.update` covers the composition. Changing a fee, a limit, a provider binding
 * or a rule needs its own permission — the four changes that alter money, exposure, counterparty
 * and routing without altering the workflow, and the four an attacker with product-editor access
 * would reach for.
 *
 * The policy is what makes the permission split real. Without it, a product editor changes a fee
 * through the same endpoint they change a description through, and the separate permission exists
 * only in the catalog.
 */
export const productSensitiveChangePolicy: Policy = {
  id: 'financial-product.sensitive-change',
  description: 'A fee, limit, provider or rule change may not travel as a generic product edit.',

  appliesTo: (request) =>
    isProductResource(request, PRODUCT_RESOURCE_TYPES.PRODUCT) &&
    request.action === FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_UPDATE.key,

  evaluate: (request): PolicyResult | null => {
    const changed = attributesOf(request).changedPaths;
    if (!changed) return null;

    const sensitive = changed.filter((path) => MAKER_CHECKER_FIELDS.includes(path));
    if (sensitive.length === 0) return null;

    return {
      effect: 'deny',
      reason:
        `This edit changes ${sensitive.join(', ')}, which needs its own permission and its own ` +
        'approval. A fee change that travels as a description edit is a fee change nobody ' +
        'reviewed.',
    };
  },
};

/**
 * A published product may not be edited.
 *
 * A policy as well as a service check, because the service check covers the service. This covers
 * every route that declares an update action, including the bulk-edit endpoint somebody adds for
 * a migration and forgets to guard.
 */
export const productImmutabilityPolicy: Policy = {
  id: 'financial-product.immutability',
  description: 'A product past the editable states may not be updated.',

  appliesTo: (request) =>
    isProductResource(request) &&
    (request.action === FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_UPDATE.key ||
      MAKER_CHECKER_FIELDS.some((field) => request.action.includes(field))),

  evaluate: (request): PolicyResult | null => {
    const status = attributesOf(request).lifecycleStatus;
    if (!status) return null;

    return EDITABLE_STATUSES.has(status)
      ? null
      : {
          effect: 'deny',
          reason:
            `A product in "${status}" is immutable. A running transaction reads its rules from ` +
            'this version, so editing it would retroactively change the rules a decision was ' +
            'made under. Create a new version.',
        };
  },
};

/**
 * Only an active product executes in production.
 *
 * Also enforced by `bindVersion` in the versioning package, and deliberately duplicated here. The
 * two enforcement points cover different things: the binding covers the runtime, and the policy
 * covers every route that declares an execute action — including a "replay this execution"
 * operator endpoint, which is the one that would otherwise re-run a draft.
 */
export const productExecutionEnvironmentPolicy: Policy = {
  id: 'financial-product.execution-environment',
  description: 'Only an active product may execute in production.',

  appliesTo: (request) =>
    request.action === FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_EXECUTE.key &&
    isProductResource(request),

  evaluate: (request): PolicyResult | null => {
    const attributes = attributesOf(request);
    const status = attributes.lifecycleStatus;
    const environment = attributes.environment;

    if (!status || !environment) return null;
    if (environment === 'sandbox') return null;

    return EXECUTABLE_STATUSES.has(status)
      ? null
      : {
          effect: 'deny',
          reason:
            `A product in "${status}" does not execute in production. A draft that could ` +
            'execute would make every control above it optional.',
        };
  },
};

/**
 * A product may not bind a connector its tenant has not approved.
 *
 * Provider substitution is on the specification's threat list and it is the quiet one: the
 * product still works, the transactions still complete, and the money goes somewhere nobody
 * reviewed. The approved list is loaded server-side; the requested connector comes from the
 * change being made.
 */
export const productProviderSubstitutionPolicy: Policy = {
  id: 'financial-product.provider-substitution',
  description: 'A product may only bind a connector approved for its tenant.',

  appliesTo: (request) => isProductResource(request),

  evaluate: (request): PolicyResult | null => {
    const attributes = attributesOf(request);
    const requested = attributes.requestedConnectorId;
    const approved = attributes.approvedConnectorIds;

    if (!requested || !approved) return null;

    return approved.includes(requested)
      ? null
      : {
          effect: 'deny',
          reason:
            `Connector "${requested}" is not approved for this tenant. The product would still ` +
            'work and the money would go somewhere nobody reviewed.',
        };
  },
};

/**
 * Every product policy, in evaluation order.
 *
 * Order does not change the outcome — they can only deny, so any denial wins — but it changes the
 * *trace*, and the trace is how a denial is explained to whoever has to fix it. Tenancy first,
 * then the separation-of-duty policies, then the state ones: the order somebody reading the trace
 * would ask the questions in.
 */
export const FINANCIAL_PRODUCT_POLICIES: Policy[] = [
  productSelfApprovalPolicy,
  productSelfPublicationPolicy,
  productDuplicateDecisionPolicy,
  productSensitiveChangePolicy,
  productImmutabilityPolicy,
  productExecutionEnvironmentPolicy,
  productProviderSubstitutionPolicy,
];
