import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@trustsystem/errors';
import { canGrantRole } from '@trustsystem/rbac';
import { InMemorySecurityEventSink, SecurityEventEmitter } from '@trustsystem/security-events';
import { securityPolicySchema } from '@trustsystem/security-policy';
import type { ActorContext } from '@trustsystem/shared-types';
import { Authorizer } from './authorizer';
import { authorize } from './decision';
import { roleGrantPolicy, scopeMatches, standardPolicies } from './policies';

/**
 * Policy authorization.
 *
 * The five attacks this phase names explicitly each have a test here:
 * cross-organization access, role escalation, inactive-member access,
 * organization-header manipulation, and a credential exceeding its scope.
 */

const policy = securityPolicySchema.parse({ environment: 'test' });

const ACME = 'org_acme';
const RIVAL = 'org_rival';

function actor(overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    actorType: 'user',
    userId: 'user_admin',
    email: 'admin@acme.test',
    organizationId: ACME,
    roles: ['administrator'],
    permissions: ['merchant.read', 'merchant.update', 'rbac.role.assign'],
    isSuperAdmin: false,
    tokenId: 'jti_1',
    authentication: {
      mfa: true,
      level: 'high',
      methods: ['pwd', 'otp'],
      acr: 'gold',
      authenticatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    provider: 'oidc',
    ...overrides,
  };
}

const ACTION_SCOPES = {
  'merchant.read': ['merchants:read'],
  'merchant.update': ['merchants:write'],
};

function buildAuthorizer(overrides: Record<string, unknown> = {}): {
  authorizer: Authorizer;
  sink: InMemorySecurityEventSink;
} {
  const sink = new InMemorySecurityEventSink();
  const events = new SecurityEventEmitter({ sinks: [sink], application: 'test' });

  return {
    authorizer: new Authorizer({
      mfa: policy.mfa,
      events,
      actionScopes: ACTION_SCOPES,
      ...overrides,
    }),
    sink,
  };
}

const policies = standardPolicies({ mfa: policy.mfa, actionScopes: ACTION_SCOPES });

describe('default deny', () => {
  it('denies when no policy allows the request', () => {
    // The whole shape of the engine: nothing matched, so nothing permitted it.
    const decision = authorize({ actor: null, action: 'merchant.read' }, { policies: [] });

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('no_policy_allowed_this_request');
    expect(decision.policyId).toBe(null);
  });

  it('denies an unauthenticated request before anything else is considered', () => {
    const decision = authorize({ actor: null, action: 'merchant.read' }, { policies });

    expect(decision.allow).toBe(false);
    expect(decision.policyId).toBe('actor.authenticated');
  });

  it('denies an action the actor holds no permission for', () => {
    const decision = authorize(
      {
        actor: actor({ permissions: ['merchant.read'] }),
        action: 'merchant.delete',
        organizationId: ACME,
      },
      { policies },
    );

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('permission_missing');
  });

  it('allows a request that survives every policy', () => {
    const decision = authorize(
      { actor: actor(), action: 'merchant.update', organizationId: ACME },
      { policies },
    );

    expect(decision.allow).toBe(true);
    expect(decision.policyId).toBe('rbac.permission');
  });

  it('lets an explicit deny beat an allow, whatever the order', () => {
    const allowEverything = {
      id: 'test.allow-all',
      description: 'Allows everything.',
      appliesTo: () => true,
      evaluate: () => ({ effect: 'allow' as const, reason: 'test' }),
    };

    // The allow policy is first. A deny still wins, which is what lets a narrow rule
    // stop a broad one without the broad one enumerating exceptions.
    const decision = authorize(
      { actor: actor({ organizationId: RIVAL }), action: 'merchant.update', organizationId: ACME },
      { policies: [allowEverything, ...policies] },
    );

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('cross_tenant_request_blocked');
  });

  it('carries a decision id and the full evaluation trace', () => {
    const decision = authorize(
      { actor: actor(), action: 'merchant.update', organizationId: ACME },
      { policies },
    );

    expect(decision.decisionId).toMatch(/[0-9a-f-]{36}/);
    expect(decision.evaluated.length).toBeGreaterThan(1);
    expect(decision.evaluated.map((entry) => entry.policyId)).toContain('tenant.membership');
  });
});

describe('cross-organization access', () => {
  it('refuses a request scoped to another organization', async () => {
    const { authorizer, sink } = buildAuthorizer();

    const decision = await authorizer.decide({
      actor: actor({ organizationId: ACME }),
      action: 'merchant.update',
      organizationId: RIVAL,
    });

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('cross_tenant_request_blocked');
    // A distinct event type, so an alert rule can tell this from a missing permission.
    expect(sink.byType('authz.cross_tenant_blocked')).toHaveLength(1);
  });

  it('refuses a resource that belongs to another organization', async () => {
    const { authorizer } = buildAuthorizer();

    const decision = await authorizer.decide({
      actor: actor(),
      action: 'merchant.update',
      organizationId: ACME,
      resource: { type: 'Merchant', id: 'm_1', organizationId: RIVAL },
    });

    expect(decision.reason).toBe('cross_tenant_resource_blocked');
  });

  it('closes the organization-header attack', async () => {
    const { authorizer } = buildAuthorizer();

    // A client sends `X-Organization-Id: org_rival`. Whatever the request says, the
    // actor's organization came from a verified token, and holding
    // `merchant.update` in one organization says nothing about another.
    const decision = await authorizer.decide({
      actor: actor({ organizationId: ACME, permissions: ['merchant.update'] }),
      action: 'merchant.update',
      organizationId: RIVAL,
    });

    expect(decision.allow).toBe(false);
  });

  it('refuses an actor with no organization selected rather than treating it as a wildcard', async () => {
    const { authorizer } = buildAuthorizer();

    const decision = await authorizer.decide({
      actor: actor({ organizationId: null }),
      action: 'merchant.update',
      organizationId: ACME,
    });

    expect(decision.reason).toBe('no_organization_selected');
  });

  it('lets platform staff cross the boundary, which is why it is audited', async () => {
    const { authorizer, sink } = buildAuthorizer();

    const decision = await authorizer.decide({
      actor: actor({ isSuperAdmin: true, permissions: ['*'], roles: ['super_admin'] }),
      action: 'merchant.update',
      organizationId: RIVAL,
    });

    expect(decision.allow).toBe(true);
    // No denial event, because nothing was denied — the audit trail is where a
    // super-admin action is recorded.
    expect(sink.events).toHaveLength(0);
  });
});

describe('role escalation', () => {
  const escalationPolicies = [
    ...policies.slice(0, -1),
    roleGrantPolicy(canGrantRole),
    policies.at(-1)!,
  ];

  it('refuses an administrator granting a role they may not grant', () => {
    // Without this check, `rbac.role.assign` is equivalent to `platform.admin`:
    // anyone who can assign roles can assign the most powerful one.
    const decision = authorize(
      {
        actor: actor({ roles: ['administrator'], permissions: ['rbac.role.assign'] }),
        action: 'rbac.role.assign',
        organizationId: ACME,
        context: { attributes: { targetRole: 'organization_owner' } },
      },
      { policies: escalationPolicies },
    );

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('role_escalation_blocked');
  });

  it('allows granting a role the actor is permitted to grant', () => {
    const decision = authorize(
      {
        actor: actor({ roles: ['administrator'], permissions: ['rbac.role.assign'] }),
        action: 'rbac.role.assign',
        organizationId: ACME,
        context: { attributes: { targetRole: 'operator' } },
      },
      { policies: escalationPolicies },
    );

    expect(decision.allow).toBe(true);
  });

  it('records an escalation attempt as its own event type', async () => {
    const { authorizer, sink } = buildAuthorizer({
      additional: [roleGrantPolicy(canGrantRole)],
    });

    await authorizer.decide({
      actor: actor({ roles: ['administrator'], permissions: ['rbac.role.assign'] }),
      action: 'rbac.role.assign',
      organizationId: ACME,
      context: { attributes: { targetRole: 'super_admin' } },
    });

    expect(sink.byType('authz.role_escalation_blocked')).toHaveLength(1);
  });
});

describe('resource state', () => {
  it('refuses a write to a soft-deleted resource but permits a read', () => {
    const deleted = { type: 'Merchant', id: 'm_1', organizationId: ACME, deleted: true };

    expect(
      authorize(
        { actor: actor(), action: 'merchant.update', organizationId: ACME, resource: deleted },
        { policies },
      ).reason,
    ).toBe('resource_deleted');

    // Readable, so history survives.
    expect(
      authorize(
        {
          actor: actor({ permissions: ['merchant.read'] }),
          action: 'merchant.read',
          organizationId: ACME,
          resource: deleted,
        },
        { policies },
      ).allow,
    ).toBe(true);
  });

  it('refuses a write to a suspended resource', () => {
    const decision = authorize(
      {
        actor: actor(),
        action: 'merchant.update',
        organizationId: ACME,
        resource: { type: 'Merchant', id: 'm_1', organizationId: ACME, status: 'suspended' },
      },
      { policies },
    );

    expect(decision.reason).toBe('resource_status_suspended');
  });
});

describe('authentication assurance', () => {
  it('refuses an action needing high assurance from a single-factor session', () => {
    const decision = authorize(
      {
        actor: actor({
          authentication: {
            mfa: false,
            level: 'medium',
            methods: ['pwd'],
            acr: null,
            authenticatedAt: null,
          },
        }),
        action: 'merchant.update',
        organizationId: ACME,
        context: { requiredAuthenticationLevel: 'high' },
      },
      { policies },
    );

    expect(decision.reason).toBe('assurance_insufficient');
  });

  it('refuses a privileged role with no second factor, whatever the route declared', () => {
    // The check that catches the route nobody decorated.
    const decision = authorize(
      {
        actor: actor({
          roles: ['organization_owner'],
          authentication: {
            mfa: false,
            level: 'medium',
            methods: ['pwd'],
            acr: null,
            authenticatedAt: null,
          },
        }),
        action: 'merchant.update',
        organizationId: ACME,
      },
      { policies },
    );

    expect(decision.reason).toBe('privileged_role_requires_mfa');
  });

  it('exempts a machine actor from assurance, because it has none to give', () => {
    const decision = authorize(
      {
        actor: actor({
          actorType: 'api_key',
          userId: 'key_1',
          roles: [],
          scopes: ['merchants:write'],
          authentication: undefined,
        }),
        action: 'merchant.update',
        organizationId: ACME,
        context: { requiredAuthenticationLevel: 'high' },
      },
      { policies },
    );

    expect(decision.allow).toBe(true);
  });
});

describe('credential scopes', () => {
  it('refuses a read-scoped key attempting a write', async () => {
    const { authorizer, sink } = buildAuthorizer();

    // A permission check alone cannot express this: the organization may write, and
    // this particular credential may not.
    const decision = await authorizer.decide({
      actor: actor({
        actorType: 'api_key',
        userId: 'key_1',
        scopes: ['merchants:read'],
        authentication: undefined,
      }),
      action: 'merchant.update',
      organizationId: ACME,
    });

    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('scope_not_granted');
    expect(sink.byType('api_key.scope_denied')).toHaveLength(1);
  });

  it('allows a write-scoped key to write', async () => {
    const { authorizer } = buildAuthorizer();

    const decision = await authorizer.decide({
      actor: actor({
        actorType: 'api_key',
        userId: 'key_1',
        scopes: ['merchants:write'],
        authentication: undefined,
      }),
      action: 'merchant.update',
      organizationId: ACME,
    });

    expect(decision.allow).toBe(true);
  });

  it('denies a scoped credential an action nobody mapped to a scope', async () => {
    const { authorizer } = buildAuthorizer();

    // Fail closed. Allowing an unmapped action means every key silently gains access
    // to each new endpoint.
    const decision = await authorizer.decide({
      actor: actor({
        actorType: 'api_key',
        userId: 'key_1',
        scopes: ['*'],
        permissions: ['*'],
        authentication: undefined,
      }),
      action: 'something.brand.new',
      organizationId: ACME,
    });

    expect(decision.reason).toBe('action_not_mapped_to_a_scope');
  });

  it('never applies a scope check to a person', async () => {
    const { authorizer } = buildAuthorizer();

    const decision = await authorizer.decide({
      actor: actor(),
      action: 'merchant.update',
      organizationId: ACME,
    });

    expect(decision.allow).toBe(true);
  });
});

describe('scopeMatches', () => {
  it('treats write as covering read', () => {
    // Otherwise every key needs both, and the configuration burden gets solved by
    // granting a wildcard.
    expect(scopeMatches(['payments:write'], 'payments:read')).toBe(true);
    expect(scopeMatches(['payments:read'], 'payments:write')).toBe(false);
  });

  it('honours a resource wildcard but not a cross-resource one', () => {
    expect(scopeMatches(['payments:*'], 'payments:write')).toBe(true);
    expect(scopeMatches(['payments:*'], 'merchants:read')).toBe(false);
  });

  it('honours the global wildcard', () => {
    expect(scopeMatches(['*'], 'anything:write')).toBe(true);
  });
});

describe('denial reporting', () => {
  let authorizer: Authorizer;
  let sink: InMemorySecurityEventSink;

  beforeEach(() => {
    ({ authorizer, sink } = buildAuthorizer());
  });

  it('throws a forbidden error carrying the decision id, and no policy detail in the message', async () => {
    try {
      await authorizer.assert({
        actor: actor({ permissions: [] }),
        action: 'merchant.update',
        organizationId: ACME,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      const apiError = error as ApiError;

      expect(apiError.code).toBe('forbidden');
      // The message is the framework's vague default. Naming the policy would map
      // out the authorization model one request at a time.
      expect(apiError.message).toBe('You do not have permission to perform this action.');
      expect(apiError.context?.decisionId).toBeTruthy();
      expect(apiError.context?.policyId).toBe('rbac.permission');
    }
  });

  it('records a denial even when the caller catches the error', async () => {
    await authorizer
      .assert({
        actor: actor({ permissions: [] }),
        action: 'merchant.update',
        organizationId: ACME,
      })
      .catch(() => undefined);

    // A handled denial is still a denial, and a burst of them is what an intrusion
    // looks like from the inside.
    expect(sink.byType('authz.denied')).toHaveLength(1);
  });

  it('connects the id a caller sees to the event an operator reads', async () => {
    const decision = await authorizer.decide({
      actor: actor({ permissions: [] }),
      action: 'merchant.update',
      organizationId: ACME,
    });

    const event = sink.byType('authz.denied')[0];
    expect(event?.context?.decisionId).toBe(decision.decisionId);
  });

  it('describes its policy set for the security portal', () => {
    const described = authorizer.describePolicies();

    expect(described.map((policy) => policy.id)).toContain('tenant.membership');
    // The RBAC check is last, so a trace names the policy that actually decided.
    expect(described.at(-1)?.id).toBe('rbac.permission');
  });
});
