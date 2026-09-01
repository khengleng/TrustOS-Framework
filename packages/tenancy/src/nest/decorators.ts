import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { ApiError } from '@trustsystem/errors';
import type { TenantContext } from '../tenant-context';

/**
 * Injects the active organization id.
 *
 *   findAll(@OrganizationId() organizationId: string) { ... }
 *
 * Reads the value `TenantGuard` derived from the access token, so a handler
 * cannot accidentally use a client-supplied organization id.
 */
export const OrganizationId = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<{ organizationId?: string | null }>();
  if (!request?.organizationId) {
    throw ApiError.forbidden('Organization context is required for this operation.', {
      reason: 'missing_tenant_context',
    });
  }
  return request.organizationId;
});

/** Injects the full tenant context. */
export const CurrentTenant = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<{ tenant?: TenantContext | null }>();
  if (!request?.tenant) {
    throw ApiError.forbidden('Organization context is required for this operation.', {
      reason: 'missing_tenant_context',
    });
  }
  return request.tenant;
});
