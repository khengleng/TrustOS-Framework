import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError } from '@trustos/errors';
import type { OrganizationId, UserId } from '@trustos/shared-types';

/**
 * The tenant a unit of work belongs to.
 *
 * Established once per request by `TenantGuard`, from the *access token* —
 * never from a request body, a query string, or anything else the caller
 * controls. Membership was verified when the token was minted.
 */
export interface TenantContext {
  organizationId: OrganizationId;
  actorId: UserId;
  isSuperAdmin: boolean;
}

/**
 * The store holds a *mutable holder*, not the context itself.
 *
 * This matters. A NestJS guard returns before the route handler runs, so it
 * cannot wrap the handler in `AsyncLocalStorage.run`, and `enterWith` does not
 * reliably survive the promise boundary between a guard and its handler — the
 * handler resumes in the async context captured before the guard ran, and the
 * store is silently empty.
 *
 * So the middleware opens an empty holder for the whole request, and the guard
 * fills it in once the tenant is known. Everything downstream reads the same
 * object. (This is the same shape `setRequestActor` uses in @trustos/logging,
 * for the same reason.)
 */
interface TenantContextHolder {
  current: TenantContext | null;
}

const storage = new AsyncLocalStorage<TenantContextHolder>();

/**
 * Opens an empty tenant scope for the request.
 *
 * Install this as middleware, before the guards:
 *
 *   app.use(tenantScopeMiddleware());
 *
 * Without it, `TenantGuard` has nowhere to publish the tenant and every scoped
 * query fails closed — loudly, at the first request, which is the intended
 * failure mode for a misconfigured application.
 */
export function tenantScopeMiddleware() {
  return function trustosTenantScope(_req: unknown, _res: unknown, next: () => void): void {
    storage.run({ current: null }, next);
  };
}

/** Runs `fn` with a fixed tenant context. Use in jobs, scripts and tests. */
export function runInTenantContext<T>(context: TenantContext, fn: () => T): T {
  return storage.run({ current: context }, fn);
}

/**
 * Publishes the tenant into the scope opened by `tenantScopeMiddleware`.
 *
 * Called by `TenantGuard`. Returns false when no scope is open, which lets the
 * guard fail the request rather than proceed unscoped.
 */
export function setTenantContext(context: TenantContext): boolean {
  const holder = storage.getStore();
  if (!holder) return false;
  holder.current = context;
  return true;
}

/**
 * Runs `fn` with no tenant context at all.
 *
 * For genuinely cross-organization work — a platform report, a migration. Its
 * verbosity is deliberate: it should be greppable and rare.
 */
export function runWithoutTenantContext<T>(fn: () => T): T {
  return storage.run({ current: null }, fn);
}

export function getTenantContext(): TenantContext | undefined {
  return storage.getStore()?.current ?? undefined;
}

/**
 * Returns the active tenant context or throws.
 *
 * Throwing `forbidden` rather than returning `undefined` is the point: a query
 * helper that cannot determine the tenant must fail the request, not fall back
 * to querying every organization's rows.
 */
export function requireTenantContext(): TenantContext {
  const context = getTenantContext();
  if (!context) {
    throw ApiError.forbidden('Organization context is required for this operation.', {
      reason: 'missing_tenant_context',
    });
  }
  return context;
}

export function getOrganizationId(): OrganizationId | undefined {
  return getTenantContext()?.organizationId;
}

export function requireOrganizationId(): OrganizationId {
  return requireTenantContext().organizationId;
}
