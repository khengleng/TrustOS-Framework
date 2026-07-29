import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { ActorContext } from '@trustos/shared-types';
import type { ApiError } from '@trustos/errors';
import { PermissionsGuard } from './permissions.guard';
import { ROUTE_METADATA } from './metadata';

/**
 * The guard is exercised with hand-built Nest primitives rather than a compiled
 * test module: authorization logic should be provable without booting a server.
 */
function buildContext(options: {
  metadata?: Record<string, unknown>;
  actor?: ActorContext | null;
}): { context: ExecutionContext; reflector: { getAllAndOverride: (key: string) => unknown } } {
  const metadata = options.metadata ?? {};
  const request = { actor: options.actor ?? null };

  const context = {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  const reflector = { getAllAndOverride: (key: string) => metadata[key] };
  return { context, reflector };
}

const guardFor = (options: Parameters<typeof buildContext>[0]) => {
  const { context, reflector } = buildContext(options);
  const guard = new PermissionsGuard(reflector as never);
  return () => guard.canActivate(context);
};

const actor = (overrides: Partial<ActorContext> = {}): ActorContext => ({
  userId: 'user_1',
  email: 'ada@example.com',
  organizationId: 'org_1',
  roles: ['operator'],
  permissions: ['organization.read'],
  isSuperAdmin: false,
  tokenId: 'jti_1',
  ...overrides,
});

describe('PermissionsGuard', () => {
  it('denies a route that declares no access policy', () => {
    const run = guardFor({ actor: actor() });
    expect(run).toThrowError(/do not have permission/);

    try {
      run();
    } catch (error) {
      expect((error as ApiError).context?.reason).toBe('route_declares_no_access_policy');
    }
  });

  it('allows a public route without an actor', () => {
    expect(guardFor({ metadata: { [ROUTE_METADATA.PUBLIC]: true }, actor: null })()).toBe(true);
  });

  it('rejects an unauthenticated request to a protected route with 401, not 403', () => {
    try {
      guardFor({
        metadata: { [ROUTE_METADATA.PERMISSIONS]: ['organization.read'] },
        actor: null,
      })();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('unauthorized');
    }
  });

  it('allows a held permission and denies a missing one', () => {
    expect(
      guardFor({
        metadata: { [ROUTE_METADATA.PERMISSIONS]: ['organization.read'] },
        actor: actor(),
      })(),
    ).toBe(true);

    expect(
      guardFor({
        metadata: { [ROUTE_METADATA.PERMISSIONS]: ['audit.read'] },
        actor: actor(),
      }),
    ).toThrowError(/do not have permission/);
  });

  it('honours "any" mode', () => {
    expect(
      guardFor({
        metadata: {
          [ROUTE_METADATA.PERMISSIONS]: ['audit.read', 'organization.read'],
          [ROUTE_METADATA.PERMISSIONS_MODE]: 'any',
        },
        actor: actor(),
      })(),
    ).toBe(true);
  });

  it('allows an explicitly authenticated-only route', () => {
    expect(
      guardFor({
        metadata: { [ROUTE_METADATA.ALLOW_AUTHENTICATED]: true },
        actor: actor(),
      })(),
    ).toBe(true);
  });

  it('checks roles when a route declares them', () => {
    expect(guardFor({ metadata: { [ROUTE_METADATA.ROLES]: ['operator'] }, actor: actor() })()).toBe(
      true,
    );

    expect(
      guardFor({ metadata: { [ROUTE_METADATA.ROLES]: ['auditor'] }, actor: actor() }),
    ).toThrowError(/do not have permission/);
  });

  it('lets a super admin through any policy', () => {
    expect(
      guardFor({
        metadata: { [ROUTE_METADATA.PERMISSIONS]: ['audit.read'] },
        actor: actor({ isSuperAdmin: true, permissions: [] }),
      })(),
    ).toBe(true);
  });
});
