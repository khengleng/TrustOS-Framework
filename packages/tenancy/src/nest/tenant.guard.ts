import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '@trustos/errors';
import type { ActorContext } from '@trustos/shared-types';
import { setTenantContext, type TenantContext } from '../tenant-context';

export const TENANT_METADATA = {
  /** Route runs without a tenant scope. Super admins only. */
  CROSS_ORGANIZATION: 'trustos:cross-organization',
  /** Route runs before an organization is selected, e.g. `POST /organizations`. */
  NO_TENANT_REQUIRED: 'trustos:no-tenant-required',
} as const;

/**
 * Opts a route out of tenant scoping. Requires `isSuperAdmin`.
 * Every use should be justified in review and audited at runtime.
 */
export const CrossOrganization = () => SetMetadata(TENANT_METADATA.CROSS_ORGANIZATION, true);

/**
 * Route legitimately has no organization yet — creating one, listing the
 * organizations you belong to, reading your own profile.
 */
export const NoTenantRequired = () => SetMetadata(TENANT_METADATA.NO_TENANT_REQUIRED, true);

const PUBLIC_METADATA = 'trustos:public';

/**
 * Establishes and enforces the tenant scope for a request.
 *
 * The organization is taken from the access token, never from the request.
 * When the caller *also* names an organization — a `:organizationId` path
 * parameter or an `X-Organization-Id` header — the two must agree; a mismatch
 * is refused rather than silently resolved in either direction.
 *
 * Register after the authentication guard and before `PermissionsGuard`.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_METADATA, targets)) return true;

    const request = context.switchToHttp().getRequest<{
      actor?: ActorContext | null;
      params?: Record<string, string>;
      headers?: Record<string, string | string[] | undefined>;
      organizationId?: string | null;
      tenant?: TenantContext | null;
    }>();

    const actor = request?.actor ?? null;
    if (!actor) throw ApiError.unauthorized();

    if (this.reflector.getAllAndOverride<boolean>(TENANT_METADATA.CROSS_ORGANIZATION, targets)) {
      if (!actor.isSuperAdmin) {
        throw ApiError.forbidden(undefined, {
          reason: 'cross_organization_requires_super_admin',
          actorId: actor.userId,
        });
      }
      request.organizationId = null;
      request.tenant = null;
      return true;
    }

    const requestedIds = this.readRequestedOrganizationIds(request);

    // A request that names two different organizations is ambiguous, and the
    // ambiguity is exactly what an attacker probes for: pick either one and
    // some layer of the stack disagrees with another. Refuse instead.
    if (requestedIds.length > 1) {
      throw ApiError.forbidden(undefined, {
        reason: 'conflicting_organization_ids',
        requestedOrganizationIds: requestedIds,
        actorId: actor.userId,
      });
    }

    const requested = requestedIds[0] ?? null;

    if (!actor.organizationId) {
      if (this.reflector.getAllAndOverride<boolean>(TENANT_METADATA.NO_TENANT_REQUIRED, targets)) {
        request.organizationId = null;
        return true;
      }
      throw ApiError.forbidden('Select an organization before performing this action.', {
        reason: 'no_organization_selected',
        actorId: actor.userId,
      });
    }

    if (requested && requested !== actor.organizationId && !actor.isSuperAdmin) {
      throw ApiError.forbidden(undefined, {
        reason: 'organization_mismatch',
        actorOrganizationId: actor.organizationId,
        requestedOrganizationId: requested,
        actorId: actor.userId,
      });
    }

    const organizationId = actor.isSuperAdmin && requested ? requested : actor.organizationId;
    const tenant: TenantContext = {
      organizationId,
      actorId: actor.userId,
      isSuperAdmin: actor.isSuperAdmin,
    };

    request.organizationId = organizationId;
    request.tenant = tenant;

    if (!setTenantContext(tenant)) {
      // The application forgot `app.use(tenantScopeMiddleware())`. Failing the
      // request is the only safe answer: proceeding would run tenant-scoped
      // queries with no scope.
      throw ApiError.internal('Tenant scope middleware is not installed.');
    }

    return true;
  }

  /**
   * Every organization id the caller named, de-duplicated.
   *
   * All of them are checked, not just the first: reading only the path
   * parameter would let a mismatched header travel further into the request
   * and be picked up by some other layer.
   */
  private readRequestedOrganizationIds(request: {
    params?: Record<string, string>;
    headers?: Record<string, string | string[] | undefined>;
  }): string[] {
    const header = request.headers?.['x-organization-id'];
    const candidates = [
      request.params?.organizationId,
      request.params?.orgId,
      typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined,
    ].filter((value): value is string => Boolean(value));

    return [...new Set(candidates)];
  }
}
