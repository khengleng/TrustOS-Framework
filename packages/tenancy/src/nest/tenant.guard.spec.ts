import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { ActorContext } from '@trustos/shared-types';
import type { ApiError } from '@trustos/errors';
import { TENANT_METADATA, TenantGuard } from './tenant.guard';
import { getTenantContext, tenantScopeMiddleware } from '../tenant-context';

interface Request {
  actor: ActorContext | null;
  params: Record<string, string>;
  headers: Record<string, string>;
  organizationId?: string | null;
  tenant?: unknown;
}

function run(options: {
  actor?: ActorContext | null;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
}): { call: () => boolean; request: Request } {
  const request: Request = {
    actor: options.actor ?? null,
    params: options.params ?? {},
    headers: options.headers ?? {},
  };
  const metadata = options.metadata ?? {};

  const context = {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  const guard = new TenantGuard({ getAllAndOverride: (key: string) => metadata[key] } as never);

  /**
   * Runs the guard the way the application does: inside the scope opened by
   * `tenantScopeMiddleware`. Calling `canActivate` bare would not reproduce
   * production, and the guard would have nowhere to publish the tenant.
   */
  const call = () => {
    let result: boolean | undefined;
    let thrown: unknown;
    tenantScopeMiddleware()(null, null, () => {
      try {
        result = guard.canActivate(context);
        observedContext = getTenantContext() ?? null;
      } catch (error) {
        thrown = error;
      }
    });
    if (thrown) throw thrown;
    return result as boolean;
  };

  let observedContext: ReturnType<typeof getTenantContext> | null = null;
  return { call, request, observed: () => observedContext };
}

const actor = (overrides: Partial<ActorContext> = {}): ActorContext => ({
  userId: 'user_1',
  email: 'ada@acme.test',
  organizationId: 'org_acme',
  roles: ['administrator'],
  permissions: [],
  isSuperAdmin: false,
  tokenId: 'jti_1',
  ...overrides,
});

describe('TenantGuard', () => {
  it('derives the organization from the token, not the request', () => {
    const { call, request } = run({ actor: actor(), headers: { 'x-organization-id': 'org_acme' } });
    expect(call()).toBe(true);
    expect(request.organizationId).toBe('org_acme');
  });

  /**
   * Regression: the tenant used to be published with `AsyncLocalStorage.enterWith`
   * from inside the guard, which does not survive the guard→handler promise
   * boundary. Everything looked correct until a handler called
   * `requireOrganizationId()` and got "Organization context is required".
   */
  it('publishes the tenant into the ambient scope, not just onto the request', () => {
    const { call, observed } = run({ actor: actor() });
    call();

    expect(observed()).toEqual({
      organizationId: 'org_acme',
      actorId: 'user_1',
      isSuperAdmin: false,
    });
  });

  it('fails the request when the scope middleware is missing', () => {
    const request = { actor: actor(), params: {}, headers: {} };
    const context = {
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    const guard = new TenantGuard({ getAllAndOverride: () => undefined } as never);

    // No tenantScopeMiddleware wrapper: proceeding would run scoped queries
    // with no scope, so the guard refuses instead.
    expect(() => guard.canActivate(context)).toThrowError(/Tenant scope middleware/);
  });

  it('rejects a request naming a different organization than the token', () => {
    const { call } = run({ actor: actor(), params: { organizationId: 'org_rival' } });
    expect(call).toThrowError(/do not have permission/);

    try {
      run({ actor: actor(), headers: { 'x-organization-id': 'org_rival' } }).call();
    } catch (error) {
      expect((error as ApiError).context?.reason).toBe('organization_mismatch');
    }
  });

  it('refuses a request that names two different organizations', () => {
    const { call } = run({
      actor: actor(),
      params: { organizationId: 'org_acme' },
      headers: { 'x-organization-id': 'org_rival' },
    });

    expect(call).toThrowError(/do not have permission/);
    try {
      call();
    } catch (error) {
      expect((error as ApiError).context?.reason).toBe('conflicting_organization_ids');
    }
  });

  it('accepts a path and header that agree', () => {
    const { call } = run({
      actor: actor(),
      params: { organizationId: 'org_acme' },
      headers: { 'x-organization-id': 'org_acme' },
    });
    expect(call()).toBe(true);
  });

  it('requires authentication', () => {
    expect(run({ actor: null }).call).toThrowError(/Authentication is required/);
  });

  it('requires an organization to be selected', () => {
    const { call } = run({ actor: actor({ organizationId: null }) });
    expect(call).toThrowError(/Select an organization/);
  });

  it('allows organization-less routes that say so explicitly', () => {
    const { call, request } = run({
      actor: actor({ organizationId: null }),
      metadata: { [TENANT_METADATA.NO_TENANT_REQUIRED]: true },
    });
    expect(call()).toBe(true);
    expect(request.organizationId).toBeNull();
  });

  it('restricts cross-organization routes to super admins', () => {
    const metadata = { [TENANT_METADATA.CROSS_ORGANIZATION]: true };

    expect(run({ actor: actor(), metadata }).call).toThrowError(/do not have permission/);
    expect(run({ actor: actor({ isSuperAdmin: true }), metadata }).call()).toBe(true);
  });

  it('lets a super admin target a named organization', () => {
    const { call, request } = run({
      actor: actor({ isSuperAdmin: true }),
      params: { organizationId: 'org_rival' },
    });
    expect(call()).toBe(true);
    expect(request.organizationId).toBe('org_rival');
  });

  it('skips public routes', () => {
    expect(run({ actor: null, metadata: { 'trustos:public': true } }).call()).toBe(true);
  });
});
