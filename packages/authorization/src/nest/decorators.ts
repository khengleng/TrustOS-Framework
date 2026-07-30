import { SetMetadata, applyDecorators } from '@nestjs/common';
import { AUTHORIZATION_METADATA } from './metadata';

/**
 * Declares the action a route performs, for policy authorization.
 *
 *   @Authorize('merchant.update', 'Merchant')
 *   @Put(':id')
 *   update() {}
 *
 * Complements `@RequirePermissions`, which the framework's RBAC guard enforces:
 * that guard answers "does the actor hold the permission", this one runs the full
 * policy set, which additionally sees the organization, the resource and the
 * authentication strength.
 *
 * The resource *type* is declarable here; the resource *instance* is not, because
 * a guard runs before the handler has loaded anything. A route that needs a
 * decision about a specific row calls `authorizer.assert` in the handler with the
 * row in hand — see `docs/authorization-model.md`.
 */
export function Authorize(action: string, resourceType?: string) {
  return applyDecorators(
    SetMetadata(AUTHORIZATION_METADATA.ACTION, action),
    ...(resourceType ? [SetMetadata(AUTHORIZATION_METADATA.RESOURCE_TYPE, resourceType)] : []),
  );
}
