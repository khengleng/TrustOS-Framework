import { ApiError } from '@trustos/errors';
import type { ActorContext, OrganizationId } from '@trustos/shared-types';
import { requireOrganizationId } from './tenant-context';

/** Column carrying the tenant on every tenant-owned model. */
export const TENANT_COLUMN = 'organizationId';

/**
 * Builds a `where` clause pinned to the active organization.
 *
 * Rejects, rather than overwrites, a caller-supplied `organizationId` that
 * disagrees. Overwriting would hide the bug; a deliberate cross-tenant read
 * attempt and an honest mistake look identical at this layer, and both should
 * stop the request.
 */
export function tenantWhere<T extends Record<string, unknown>>(
  where?: T,
  organizationId?: OrganizationId,
): T & { organizationId: OrganizationId } {
  const scope = organizationId ?? requireOrganizationId();
  const supplied = where?.[TENANT_COLUMN];

  if (supplied !== undefined && supplied !== scope) {
    throw crossTenantError('where', scope, supplied);
  }

  return { ...(where ?? ({} as T)), organizationId: scope };
}

/** Builds a `data` payload pinned to the active organization. */
export function tenantData<T extends Record<string, unknown>>(
  data: T,
  organizationId?: OrganizationId,
): T & { organizationId: OrganizationId } {
  const scope = organizationId ?? requireOrganizationId();
  const supplied = data[TENANT_COLUMN];

  if (supplied !== undefined && supplied !== scope) {
    throw crossTenantError('data', scope, supplied);
  }

  return { ...data, organizationId: scope };
}

/**
 * Verifies that a row already loaded from the database belongs to the tenant.
 *
 * The last line of defence for code paths that legitimately fetch by primary
 * key — a token lookup, a webhook payload — where the scope cannot be part of
 * the query.
 */
export function assertTenantMatch<T extends { organizationId?: string | null } | null | undefined>(
  entity: T,
  organizationId?: OrganizationId,
): NonNullable<T> {
  const scope = organizationId ?? requireOrganizationId();

  // A missing row and a row belonging to another tenant produce the same
  // `not_found`: distinguishing them turns any id endpoint into an oracle that
  // confirms which ids exist in other organizations.
  if (!entity) throw ApiError.notFound();
  if (entity.organizationId !== scope) {
    throw ApiError.notFound(undefined, {
      reason: 'cross_tenant_access_blocked',
      expectedOrganizationId: scope,
      actualOrganizationId: entity.organizationId,
    });
  }
  return entity as NonNullable<T>;
}

/**
 * Checks an actor may act inside `organizationId`.
 *
 * The actor's organization comes from their access token, so this compares two
 * server-side values. Super admins pass, which is precisely why that flag is
 * audited on every use.
 */
export function assertOrganizationAccess(
  actor: ActorContext | null,
  organizationId: OrganizationId,
): void {
  if (!actor) throw ApiError.unauthorized();
  if (actor.isSuperAdmin) return;

  if (actor.organizationId !== organizationId) {
    throw ApiError.forbidden(undefined, {
      reason: 'organization_mismatch',
      actorOrganizationId: actor.organizationId,
      requestedOrganizationId: organizationId,
      actorId: actor.userId,
    });
  }
}

function crossTenantError(source: string, expected: string, actual: unknown): ApiError {
  return ApiError.forbidden('Cross-organization access is not permitted.', {
    reason: 'cross_tenant_scope_conflict',
    source,
    expectedOrganizationId: expected,
    suppliedOrganizationId: actual,
  });
}
