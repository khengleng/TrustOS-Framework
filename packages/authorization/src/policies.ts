import { hasPermission } from '@trustsystem/rbac';
import { meetsAuthenticationLevel, type MfaPolicy } from '@trustsystem/security-policy';
import { isMachineActor } from '@trustsystem/shared-types';
import type { Policy, PolicyResult } from './decision';

/**
 * The built-in policies.
 *
 * Order matters. `standardPolicies()` returns them in the order they must be
 * evaluated, and the ordering is the security model:
 *
 *   1. `actor.authenticated`        — no actor, no decision
 *   2. `tenant.membership`          — the actor's organization must match the request's
 *   3. `tenant.resource-ownership`  — and the resource's must match too
 *   4. `resource.not-deleted`       — a soft-deleted resource is not writable
 *   5. `resource.status`            — nor is one whose status forbids it
 *   6. `actor.assurance`            — strong enough authentication for this action
 *   7. `actor.privileged-role-mfa`  — a privileged role needs a second factor
 *   8. `credential.scope`           — an API key's scope must cover the action
 *   9. `rbac.permission`            — and only then, does the actor hold the permission
 *
 * Every one of 1–8 is a *deny* policy: it can refuse but never permit. Only
 * `rbac.permission` allows, and it is last. That shape is what makes the whole set
 * safe to extend — a new policy added anywhere in 1–8 can only ever narrow access,
 * and a product that adds its own allow policy has to do so deliberately.
 */

/** Actions treated as reads. Used by the resource-status policy. */
const READ_ACTIONS = /(\.|^)(read|list|get|view|search|export|evaluate|run)$/;

export function isReadAction(action: string): boolean {
  return READ_ACTIONS.test(action);
}

/** No actor, no decision. */
export const authenticatedActorPolicy: Policy = {
  id: 'actor.authenticated',
  description: 'An unauthenticated request is denied before anything else is considered.',
  appliesTo: () => true,
  evaluate: (request) => (request.actor ? null : { effect: 'deny', reason: 'unauthenticated' }),
};

/**
 * The actor's organization must be the one the request is scoped to.
 *
 * This is the check that closes the organization-header attack. A client that sends
 * `X-Organization-Id: org_other` reaches a request whose `organizationId` is
 * `org_other` and whose actor's is `org_acme`, and this policy refuses it —
 * regardless of what permissions the actor holds, because holding
 * `merchant.update` in one organization says nothing about another.
 *
 * Super admins pass, which is exactly why every super-admin action is audited and
 * why `mfa.requiredForRoles` includes the role by default.
 */
export const tenantMembershipPolicy: Policy = {
  id: 'tenant.membership',
  description: "The actor's organization must match the organization the request is scoped to.",
  appliesTo: (request) => Boolean(request.actor) && request.organizationId != null,
  evaluate: (request): PolicyResult | null => {
    const actor = request.actor;
    if (!actor) return null;
    if (actor.isSuperAdmin) return null;

    if (actor.organizationId === null) {
      // Authenticated but no organization selected. Denied rather than treated as
      // a wildcard.
      return { effect: 'deny', reason: 'no_organization_selected' };
    }

    if (actor.organizationId !== request.organizationId) {
      return { effect: 'deny', reason: 'cross_tenant_request_blocked' };
    }

    return null;
  },
};

/**
 * The resource's organization must match too.
 *
 * Separate from the membership check because they fail in different ways. The
 * membership check catches a caller *asking* about another organization; this one
 * catches a resource that turned out to belong to another organization — a
 * mismatched id, a stale reference, a bug in a repository. Both are denials, and
 * only the second one means data was already loaded.
 */
export const resourceOwnershipPolicy: Policy = {
  id: 'tenant.resource-ownership',
  description: 'A tenant-owned resource must belong to the organization the request is scoped to.',
  appliesTo: (request) => Boolean(request.actor) && request.resource?.organizationId != null,
  evaluate: (request): PolicyResult | null => {
    const actor = request.actor;
    const resourceOrganization = request.resource?.organizationId;
    if (!actor || resourceOrganization == null) return null;
    if (actor.isSuperAdmin) return null;

    const scope = request.organizationId ?? actor.organizationId;
    if (scope !== resourceOrganization) {
      return { effect: 'deny', reason: 'cross_tenant_resource_blocked' };
    }

    return null;
  },
};

/** A soft-deleted resource is readable, so history survives, but not writable. */
export const notDeletedPolicy: Policy = {
  id: 'resource.not-deleted',
  description: 'A soft-deleted resource cannot be modified.',
  appliesTo: (request) => request.resource?.deleted === true,
  evaluate: (request): PolicyResult | null =>
    isReadAction(request.action) ? null : { effect: 'deny', reason: 'resource_deleted' },
};

/**
 * A resource whose status forbids the action.
 *
 * Configurable per resource type, because "archived" means something different for
 * a document and for a merchant. The default set covers the statuses that appear in
 * every product and mean the same thing everywhere.
 */
export function resourceStatusPolicy(blockedStatuses: Record<string, string[]> = {}): Policy {
  const defaults: Record<string, string[]> = {
    '*': ['archived', 'suspended', 'terminated', 'closed'],
    ...blockedStatuses,
  };

  return {
    id: 'resource.status',
    description: 'A resource whose lifecycle status forbids modification cannot be modified.',
    appliesTo: (request) => Boolean(request.resource?.status),
    evaluate: (request): PolicyResult | null => {
      const status = request.resource?.status;
      if (!status) return null;
      if (isReadAction(request.action)) return null;

      const blocked = defaults[request.resource?.type ?? ''] ?? defaults['*'] ?? [];
      if (blocked.includes(status.toLowerCase())) {
        return { effect: 'deny', reason: `resource_status_${status.toLowerCase()}` };
      }
      return null;
    },
  };
}

/**
 * The action needs stronger authentication than the actor has.
 *
 * Complements the route guard rather than duplicating it: the guard enforces what a
 * route declared, this enforces what a *caller* knows about the action — a service
 * that decides a particular payout needs step-up can say so per request.
 *
 * Machine actors are exempt. An API key has no second factor, so applying an
 * assurance requirement to one either blocks every integration or is ignored; what
 * restricts a machine is its scopes.
 */
export const assurancePolicy: Policy = {
  id: 'actor.assurance',
  description: 'The action requires stronger authentication than the actor completed.',
  appliesTo: (request) =>
    Boolean(request.actor) && Boolean(request.context?.requiredAuthenticationLevel),
  evaluate: (request): PolicyResult | null => {
    const actor = request.actor;
    const required = request.context?.requiredAuthenticationLevel;
    if (!actor || !required) return null;
    if (isMachineActor(actor)) return null;

    const actual = actor.authentication?.level ?? 'low';
    return meetsAuthenticationLevel(actual, required)
      ? null
      : { effect: 'deny', reason: 'assurance_insufficient' };
  },
};

/**
 * A privileged role may not act without a second factor.
 *
 * The same rule the route guard applies, restated as a policy so a decision made
 * outside an HTTP request — a background job acting on a person's behalf, a
 * decision evaluated in a service — cannot skip it by not going through a guard.
 */
export function privilegedRoleMfaPolicy(mfa: MfaPolicy): Policy {
  return {
    id: 'actor.privileged-role-mfa',
    description: 'A privileged role requires multi-factor authentication.',
    appliesTo: (request) => Boolean(request.actor),
    evaluate: (request): PolicyResult | null => {
      const actor = request.actor;
      if (!actor) return null;
      if (isMachineActor(actor)) return null;

      const privileged = mfa.requiredForRoles.some(
        (role) => actor.roles.includes(role) || (role === 'super_admin' && actor.isSuperAdmin),
      );

      if (!privileged) return null;
      return actor.authentication?.mfa
        ? null
        : { effect: 'deny', reason: 'privileged_role_requires_mfa' };
    },
  };
}

/**
 * An API key's scopes must cover the action.
 *
 * Scopes and permissions are both required and they are not the same thing.
 * Permissions say what the *organization* may do; scopes say what this particular
 * credential is allowed to do with them. A read-scoped key held by an administrator
 * must not write, which a permission check alone cannot express.
 *
 * The mapping from an action to a scope is supplied by the application, because
 * `merchant.update` → `merchants:write` is a product decision. An action with no
 * mapping is **denied** for a scoped credential: a new endpoint that nobody mapped
 * must not be reachable by every existing key.
 */
export function credentialScopePolicy(actionToScopes: Record<string, string[]>): Policy {
  return {
    id: 'credential.scope',
    description: "A scoped credential's scopes must cover the action.",
    appliesTo: (request) => {
      const actor = request.actor;
      return Boolean(actor) && isMachineActor(actor) && (actor?.scopes?.length ?? 0) >= 0;
    },
    evaluate: (request): PolicyResult | null => {
      const actor = request.actor;
      if (!actor || !isMachineActor(actor)) return null;

      const held = actor.scopes ?? [];
      const required = actionToScopes[request.action];

      if (!required) {
        // Fail closed. The alternative — allowing an unmapped action — means every
        // key silently gains access to each new endpoint.
        return { effect: 'deny', reason: 'action_not_mapped_to_a_scope' };
      }

      const satisfied = required.some((scope) => scopeMatches(held, scope));
      return satisfied ? null : { effect: 'deny', reason: 'scope_not_granted' };
    },
  };
}

/**
 * Matches a held scope against a required one.
 *
 * Supports `resource:*` and a write scope implying its read counterpart —
 * `payments:write` covers `payments:read`, because a credential that may change
 * something can necessarily observe it, and requiring both on every key is a
 * configuration burden that gets solved by granting `*`.
 */
export function scopeMatches(held: string[], required: string[] | string): boolean {
  const needed = Array.isArray(required) ? required : [required];

  return needed.some((requirement) =>
    held.some((grant) => {
      if (grant === '*' || grant === requirement) return true;

      const [grantResource, grantAction] = grant.split(':');
      const [needResource, needAction] = requirement.split(':');
      if (grantResource !== needResource) return false;

      if (grantAction === '*') return true;
      return grantAction === 'write' && needAction === 'read';
    }),
  );
}

/**
 * The RBAC check, as the last policy and the only one that allows.
 *
 * Deliberately last: every deny policy has already run, so an allow here means the
 * request survived tenancy, ownership, status, assurance and scope. If this were
 * first, an early allow would be recorded as the deciding policy and the trace
 * would name the wrong reason for a request that was later denied.
 */
export const permissionPolicy: Policy = {
  id: 'rbac.permission',
  description: 'The actor must hold the permission the action requires.',
  appliesTo: (request) => Boolean(request.actor),
  evaluate: (request): PolicyResult | null => {
    const actor = request.actor;
    if (!actor) return null;

    return hasPermission(actor, request.action)
      ? { effect: 'allow', reason: 'permission_granted' }
      : { effect: 'deny', reason: 'permission_missing' };
  },
};

export interface StandardPolicyOptions {
  mfa: MfaPolicy;
  /** Action → scopes, for credential-based actors. */
  actionScopes?: Record<string, string[]>;
  /** Resource type → statuses that forbid modification. */
  blockedStatuses?: Record<string, string[]>;
  /** Product policies, inserted before the RBAC check so they can deny. */
  additional?: Policy[];
}

/** The built-in set, in evaluation order. */
export function standardPolicies(options: StandardPolicyOptions): Policy[] {
  return [
    authenticatedActorPolicy,
    tenantMembershipPolicy,
    resourceOwnershipPolicy,
    notDeletedPolicy,
    resourceStatusPolicy(options.blockedStatuses),
    assurancePolicy,
    privilegedRoleMfaPolicy(options.mfa),
    ...(options.actionScopes ? [credentialScopePolicy(options.actionScopes)] : []),
    ...(options.additional ?? []),
    // Last, and the only policy that allows.
    permissionPolicy,
  ];
}

/**
 * Refuses an attempt to grant a role the actor may not grant.
 *
 * Not part of the standard set, because it needs the *target* role and so belongs at
 * the call site that is assigning one. Included here because role escalation is one
 * of the five attacks the phase names explicitly, and this is the check that stops
 * it: an administrator who holds `rbac.role.assign` must not be able to grant
 * `organization_owner`, or the permission is equivalent to `platform.admin`.
 */
export function roleGrantPolicy(
  canGrant: (holderRoles: string[], targetRole: string) => boolean,
): Policy {
  return {
    id: 'rbac.role-grant',
    description: 'The actor must be permitted to grant the role being assigned.',
    appliesTo: (request) =>
      Boolean(request.actor) && typeof request.context?.attributes?.targetRole === 'string',
    evaluate: (request): PolicyResult | null => {
      const actor = request.actor;
      const targetRole = request.context?.attributes?.targetRole;
      if (!actor || typeof targetRole !== 'string') return null;

      // Super admins may grant anything, and every use is audited.
      if (actor.isSuperAdmin) return null;

      return canGrant(actor.roles, targetRole)
        ? null
        : { effect: 'deny', reason: 'role_escalation_blocked' };
    },
  };
}
