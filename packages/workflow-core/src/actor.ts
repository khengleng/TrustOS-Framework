import type { ActorContext, ActorType } from '@trustos/shared-types';

/**
 * What a workflow package needs to know about the caller.
 *
 * A narrow projection of `ActorContext` rather than the thing itself, for one
 * reason: it makes the *absence* of fields part of the type. There is no
 * `submittedBy`, no `approvalStatus` and no `taskOwner` here, because none of
 * those may come from the caller — they are read from the database. A workflow
 * package that accepted the full request body would eventually read one of them
 * from it.
 *
 * `@trustos/shared-types` already guarantees the fields that are here were
 * resolved server-side: `roles` and `permissions` come from the membership tables,
 * never from a token claim.
 */
export interface WorkflowActor {
  userId: string;
  actorType: ActorType;
  /** Carried through so a policy decision can be rebuilt without a second lookup. */
  email: string;
  tokenId: string;
  organizationId: string;
  roles: string[];
  permissions: string[];
  isSuperAdmin: boolean;
  /** Group memberships, for group-assigned tasks. Resolved server-side. */
  groupIds: string[];
  /** Set when the identity provider reported an authentication level. */
  authenticationLevel: 'low' | 'medium' | 'high' | null;
  mfa: boolean;
}

/**
 * Projects a verified actor into the workflow shape.
 *
 * `organizationId` is required and this throws without one, deliberately: a
 * workflow operation with no tenant is a query with no `WHERE` clause. The check
 * belongs here rather than at every call site, because there are dozens of call
 * sites and one of them would forget.
 *
 * Groups are not on `ActorContext` — the framework has no group table yet — so
 * they are passed alongside. When one exists, this is the single place that changes.
 */
export function toWorkflowActor(
  actor: ActorContext,
  options: { groupIds?: string[] } = {},
): WorkflowActor {
  if (!actor.organizationId) {
    throw new Error(
      'A workflow operation needs an organization. The actor has none, which means ' +
        'TenantGuard did not run or the actor is platform staff acting without a scope.',
    );
  }

  return {
    userId: actor.userId,
    actorType: actor.actorType,
    email: actor.email,
    tokenId: actor.tokenId,
    organizationId: actor.organizationId,
    roles: actor.roles,
    permissions: actor.permissions,
    isSuperAdmin: actor.isSuperAdmin,
    groupIds: options.groupIds ?? [],
    authenticationLevel: actor.authentication?.level ?? null,
    mfa: actor.authentication?.mfa ?? false,
  };
}

/**
 * Whether the actor holds a permission.
 *
 * Wildcard-aware, so platform staff are not special-cased at every call site. The
 * wildcard belongs to `super_admin` alone — see `@trustos/rbac`.
 */
export function actorHasPermission(actor: WorkflowActor, permission: string): boolean {
  return actor.permissions.includes('*') || actor.permissions.includes(permission);
}

/** Whether the actor holds any of the permissions. Empty list means no. */
export function actorHasAnyPermission(actor: WorkflowActor, permissions: string[]): boolean {
  return permissions.some((permission) => actorHasPermission(actor, permission));
}

export function actorHasRole(actor: WorkflowActor, role: string): boolean {
  return actor.roles.includes(role);
}

/**
 * Whether two actor references are the same person.
 *
 * A named function rather than `===` at thirty call sites, because this comparison
 * *is* the maker-checker rule and it should be findable. It also documents the
 * decision that identity is by user id and nothing else: not by email, which
 * changes, and not by name, which is not unique.
 *
 * Two null ids are not the same actor. A system-initiated workflow has no
 * initiator, and treating "nobody" as matching "nobody" would let a self-approval
 * check pass by accident on exactly the records where it matters least and the
 * bug would be hardest to see.
 */
export function isSameActor(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a === b;
}
