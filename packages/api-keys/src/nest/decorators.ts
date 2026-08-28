import { SetMetadata, type CustomDecorator } from '@nestjs/common';

/** Route metadata for scope requirements. */
export const SCOPE_METADATA = {
  REQUIRED: 'trustos:required-scopes',
} as const;

/**
 * Declares the scopes a credential needs for this route.
 *
 *   @RequireScopes('merchants:write')
 *   @Post()
 *   create() {}
 *
 * Applies only to credential-based actors — an API key or a service account. A
 * person's session has no scopes, and the route's permission requirement is what
 * governs them.
 *
 * Both are required for a machine: `@RequirePermissions` says what the owning
 * organization may do, this says what this particular credential may do with it. A
 * read-scoped key held by an owner still cannot write.
 */
export function RequireScopes(...scopes: string[]): CustomDecorator<string> {
  return SetMetadata(SCOPE_METADATA.REQUIRED, scopes);
}
