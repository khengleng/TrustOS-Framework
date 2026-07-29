import type { AuthRequestMeta } from '@trustos/auth';
import { getRequestContext } from '@trustos/logging';

/**
 * Reads request metadata from the ambient context.
 *
 * Controllers do not take `@Req()` just to forward an IP address: the values
 * were already resolved once, correctly — including the `TRUST_PROXY` rule —
 * by the request-context middleware.
 */
export function currentRequestMeta(): AuthRequestMeta {
  const context = getRequestContext();
  return {
    ipAddress: context?.ipAddress ?? null,
    userAgent: context?.userAgent ?? null,
    requestId: context?.requestId ?? null,
  };
}
