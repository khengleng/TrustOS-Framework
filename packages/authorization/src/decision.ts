import { randomUUID } from 'node:crypto';
import { ApiError } from '@trustsystem/errors';
import type { AuthenticationLevel, PolicyEnvironment } from '@trustsystem/security-policy';
import type { ActorContext } from '@trustsystem/shared-types';

/**
 * The authorization request and its answer.
 *
 * RBAC answers "does this actor hold this permission". That is necessary and not
 * sufficient: an administrator of one organization holds `organization.member.remove`
 * and must not be able to use it on another organization's member, on a member whose
 * own role outranks theirs, or on a resource that has been archived. Those are
 * properties of the *request*, not of the actor, and a permission check cannot see
 * them.
 *
 * So a decision is made against the whole request — actor, action, resource,
 * organization, context — and it defaults to deny. Every decision carries a
 * `decisionId`, which is what makes a denial reportable: a caller sees a 403 with an
 * opaque id, an operator finds the same id in the security event, and the two are
 * connected without the response ever explaining which policy refused.
 */

export interface AuthorizationResource {
  /** Resource type, e.g. `Merchant`. Matched by policies. */
  type: string;
  id?: string | null;
  /** Owning organization. The single most important field for tenancy. */
  organizationId?: string | null;
  /** Owning user, for policies about a resource's own author. */
  ownerId?: string | null;
  /** Lifecycle status, e.g. `active`, `archived`, `suspended`. */
  status?: string | null;
  /** True when the resource has been soft-deleted. */
  deleted?: boolean;
  /** Anything else a product policy needs. Never used for tenancy. */
  attributes?: Record<string, unknown>;
}

export interface AuthorizationContext {
  environment?: PolicyEnvironment;
  /** Application making the request. */
  application?: string;
  /** Minimum assurance this action needs, when the caller knows better than the route. */
  requiredAuthenticationLevel?: AuthenticationLevel;
  /** Risk signals, when something upstream produced them. */
  risk?: { score?: number; signals?: string[] };
  ipAddress?: string | null;
  requestId?: string | null;
  /** Free-form, for a product policy. */
  attributes?: Record<string, unknown>;
}

export interface AuthorizationRequest {
  actor: ActorContext | null;
  /** What is being attempted, e.g. `merchant.update`. Usually a permission key. */
  action: string;
  resource?: AuthorizationResource;
  /** Organization the request is scoped to, after server-side validation. */
  organizationId?: string | null;
  context?: AuthorizationContext;
}

export type PolicyEffect = 'allow' | 'deny';

export interface AuthorizationDecision {
  /** Correlates a 403 with the security event that explains it. */
  decisionId: string;
  allow: boolean;
  /** Machine-readable reason. Safe for a log, not for a response body. */
  reason: string;
  /** Which policy decided, or null when nothing matched and the default applied. */
  policyId: string | null;
  /** Every policy that produced a result, in evaluation order. Diagnostic. */
  evaluated: Array<{ policyId: string; effect: PolicyEffect | null; reason: string }>;
  decidedAt: Date;
}

export interface PolicyResult {
  effect: PolicyEffect;
  reason: string;
}

/**
 * A policy.
 *
 * `appliesTo` is separate from `evaluate` on purpose: a policy that does not apply
 * is not the same as a policy that abstains, and conflating them makes an
 * evaluation trace unreadable — which matters, because the trace is how a denial is
 * explained to whoever has to fix it.
 */
export interface Policy {
  readonly id: string;
  readonly description: string;
  /**
   * True when this policy has an opinion about this request.
   *
   * Keep it cheap and side-effect free: it runs for every policy on every
   * decision.
   */
  appliesTo(request: AuthorizationRequest): boolean;
  /** The opinion. Returning null abstains. */
  evaluate(request: AuthorizationRequest): PolicyResult | null;
}

export interface AuthorizeOptions {
  policies: Policy[];
  /** Injectable, so a decision id is assertable. */
  newDecisionId?: () => string;
  now?: () => Date;
}

/**
 * Evaluates a request.
 *
 * Three rules, in this order, and each one is a deliberate choice:
 *
 *   1. **An explicit deny wins.** Always, over any number of allows. A policy that
 *      says "not this resource" has to be able to stop a policy that says "this
 *      role may generally do this", or the second one has to enumerate every
 *      exception.
 *   2. **Then an allow.** One is enough.
 *   3. **Otherwise deny.** Nothing matched, so nothing permitted it. A route with no
 *      applicable policy is refused, which means adding a resource type without a
 *      policy produces a 403 in staging rather than an open endpoint in production.
 *
 * `authorize` never throws. A denial is a value, so a caller can inspect it, record
 * it and decide what to do — and `assertAuthorized` is the wrapper for the common
 * case where the answer is a 403.
 */
export function authorize(
  request: AuthorizationRequest,
  options: AuthorizeOptions,
): AuthorizationDecision {
  const decisionId = (options.newDecisionId ?? randomUUID)();
  const decidedAt = (options.now ?? (() => new Date()))();
  const evaluated: AuthorizationDecision['evaluated'] = [];

  let allowedBy: { policyId: string; reason: string } | null = null;

  for (const policy of options.policies) {
    if (!policy.appliesTo(request)) continue;

    const result = policy.evaluate(request);
    evaluated.push({
      policyId: policy.id,
      effect: result?.effect ?? null,
      reason: result?.reason ?? 'abstained',
    });

    if (result?.effect === 'deny') {
      // Short-circuited: a deny is final, and continuing would only produce a
      // longer trace for a decision that cannot change.
      return {
        decisionId,
        allow: false,
        reason: result.reason,
        policyId: policy.id,
        evaluated,
        decidedAt,
      };
    }

    // The *first* allow is recorded rather than the last, so the trace names the
    // policy that actually permitted the request. Evaluation continues, because a
    // later deny still wins.
    if (result?.effect === 'allow' && !allowedBy) {
      allowedBy = { policyId: policy.id, reason: result.reason };
    }
  }

  if (allowedBy) {
    return {
      decisionId,
      allow: true,
      reason: allowedBy.reason,
      policyId: allowedBy.policyId,
      evaluated,
      decidedAt,
    };
  }

  return {
    decisionId,
    allow: false,
    reason: 'no_policy_allowed_this_request',
    policyId: null,
    evaluated,
    decidedAt,
  };
}

/**
 * The error a denial produces.
 *
 * The message is the framework's vague default. The reason, the matched policy and
 * the full evaluation trace go in the context, where an operator sees them in a
 * log and the caller does not — telling a caller which policy refused, and why,
 * maps out the authorization model one request at a time.
 *
 * `decisionId` is the exception: it is in the context *and* worth surfacing to a
 * caller, because "quote this id to support" is how a legitimate user gets a
 * denial investigated without anyone describing the rules.
 */
export function authorizationDenied(
  decision: AuthorizationDecision,
  request: AuthorizationRequest,
): ApiError {
  return ApiError.forbidden(undefined, {
    reason: decision.reason,
    decisionId: decision.decisionId,
    policyId: decision.policyId,
    action: request.action,
    resourceType: request.resource?.type ?? null,
    resourceId: request.resource?.id ?? null,
    organizationId: request.organizationId ?? null,
    actorId: request.actor?.userId ?? null,
    actorType: request.actor?.actorType ?? null,
    evaluated: decision.evaluated,
  });
}

/** Authorizes or throws. The common case. */
export function assertAuthorized(
  request: AuthorizationRequest,
  options: AuthorizeOptions,
): AuthorizationDecision {
  const decision = authorize(request, options);
  if (!decision.allow) throw authorizationDenied(decision, request);
  return decision;
}
