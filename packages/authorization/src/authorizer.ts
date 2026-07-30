import type { SecurityEventEmitter } from '@trustos/security-events';
import type { MfaPolicy } from '@trustos/security-policy';
import {
  authorize,
  authorizationDenied,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type Policy,
} from './decision';
import { standardPolicies, type StandardPolicyOptions } from './policies';

/**
 * The authorization service.
 *
 * One object an application injects, holding the policy set and the event emitter,
 * so a call site is `authorizer.assert({ actor, action, resource })` rather than a
 * function call that has to be handed the whole configuration each time.
 *
 * Every denial emits a security event, and the event carries the decision id. That
 * is the whole reason denials are worth recording: a caller sees an opaque id, an
 * operator finds the same id with the policy trace attached, and nobody had to put
 * the authorization model in a response body.
 *
 * Denials are recorded even when the caller catches the error. A denial that is
 * handled is still a denial, and a burst of them is what an intrusion looks like
 * from the inside.
 */
export interface AuthorizerOptions extends StandardPolicyOptions {
  events?: SecurityEventEmitter;
  /** Replaces the built-in set entirely. Rarely correct; usually `additional`. */
  policies?: Policy[];
  application?: string;
}

export class Authorizer {
  private readonly policies: Policy[];

  constructor(private readonly options: AuthorizerOptions) {
    this.policies = options.policies ?? standardPolicies(options);
  }

  /** The policy set, in evaluation order. Rendered by the security portal. */
  describePolicies(): Array<{ id: string; description: string }> {
    return this.policies.map((policy) => ({ id: policy.id, description: policy.description }));
  }

  /** Evaluates and records. Never throws. */
  async decide(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    const decision = authorize(request, { policies: this.policies });

    if (!decision.allow) {
      await this.options.events?.emit({
        type: eventTypeFor(decision.reason),
        result: 'blocked',
        reason: decision.reason,
        actorId: request.actor?.userId ?? null,
        actorType: request.actor?.actorType ?? null,
        organizationId: request.organizationId ?? request.actor?.organizationId ?? null,
        requestId: request.context?.requestId ?? null,
        ipAddress: request.context?.ipAddress ?? null,
        provider: request.actor?.provider ?? null,
        application: request.context?.application ?? this.options.application ?? null,
        ...(request.context?.risk ? { risk: request.context.risk } : {}),
        context: {
          decisionId: decision.decisionId,
          policyId: decision.policyId,
          action: request.action,
          resourceType: request.resource?.type ?? null,
          resourceId: request.resource?.id ?? null,
          evaluated: decision.evaluated,
        },
      });
    }

    return decision;
  }

  /** Evaluates, records, and throws on a denial. */
  async assert(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    const decision = await this.decide(request);
    if (!decision.allow) throw authorizationDenied(decision, request);
    return decision;
  }
}

/**
 * Maps a denial reason to a specific event type.
 *
 * A cross-tenant denial and a missing permission are both refusals and they mean
 * completely different things: one is somebody's role not covering an action, the
 * other is an attempt to reach another customer's data. An alert rule has to be able
 * to tell them apart without parsing a reason string.
 */
function eventTypeFor(reason: string): Parameters<SecurityEventEmitter['emit']>[0]['type'] {
  if (reason.startsWith('cross_tenant')) return 'authz.cross_tenant_blocked';
  if (reason === 'role_escalation_blocked') return 'authz.role_escalation_blocked';
  if (reason === 'no_organization_selected') return 'authz.inactive_member_blocked';
  if (reason === 'scope_not_granted' || reason === 'action_not_mapped_to_a_scope') {
    return 'api_key.scope_denied';
  }
  if (reason === 'assurance_insufficient') return 'auth.assurance_insufficient';
  if (reason === 'privileged_role_requires_mfa') return 'auth.mfa_required';
  return 'authz.denied';
}

/** Builds an authorizer with the standard policies. */
export function createAuthorizer(options: {
  mfa: MfaPolicy;
  events?: SecurityEventEmitter;
  actionScopes?: Record<string, string[]>;
  blockedStatuses?: Record<string, string[]>;
  additional?: Policy[];
  application?: string;
}): Authorizer {
  return new Authorizer(options);
}
