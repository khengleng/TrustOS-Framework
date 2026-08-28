import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ActorContext, RequestContext } from '@trustos/shared-types';

/**
 * Request-scoped logging context.
 *
 * Carried in AsyncLocalStorage so a service five layers deep can emit a log
 * line correlated to the request without every function signature growing a
 * `ctx` parameter. This store is for *observability*; authorization decisions
 * must never read from it (see @trustos/tenancy for why).
 */
const storage = new AsyncLocalStorage<RequestContext>();

export function generateRequestId(): string {
  return `req_${randomUUID().replace(/-/g, '')}`;
}

/** Runs `fn` with `context` available to everything it awaits. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Enriches the active context in place.
 *
 * Called once by the auth guard when the actor becomes known, so every log
 * line after authentication carries the actor and organization ids. Mutation
 * is intentional: `AsyncLocalStorage.run` cannot be re-entered mid-request.
 */
export function setRequestActor(actor: ActorContext | null): void {
  const context = storage.getStore();
  if (!context) return;
  context.actor = actor;
  if (actor?.organizationId) context.organizationId = actor.organizationId;
}

export function setRequestOrganization(organizationId: string | null): void {
  const context = storage.getStore();
  if (!context) return;
  context.organizationId = organizationId;
}

/** The context fields that belong on every log line. */
export function requestLogFields(context: RequestContext | undefined): Record<string, unknown> {
  if (!context) return {};
  return {
    requestId: context.requestId,
    ...(context.actor ? { actorId: context.actor.userId } : {}),
    ...(context.organizationId ? { organizationId: context.organizationId } : {}),
  };
}
