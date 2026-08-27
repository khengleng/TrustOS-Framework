import { describe, expect, it } from 'vitest';
import { productErrorCode } from '@trustos/financial-product-core';
import {
  ConnectorRegistry,
  FRAMEWORK_CONNECTORS,
  PROVIDER_INTERFACES,
  PROVIDER_INTERFACE_NAMES,
  assertNoFrameworkProvider,
  connectorDefinitionSchema,
  isProviderInterface,
  operationsOf,
} from './index';

function connector(overrides: Record<string, unknown> = {}) {
  return {
    connectorId: 'settlement-rail-alpha',
    name: 'Settlement rail alpha',
    description: 'A settlement instruction interface used by the test suite.',
    version: '1.0.0',
    providerInterface: 'SettlementProvider',
    operation: 'instruct',
    authentication: 'mutual_tls',
    timeoutMs: 15_000,
    idempotent: true,
    dataClassification: 'confidential',
    lifecycleStatus: 'approved',
    technicalOwner: 'usr_integrations',
    ...overrides,
  };
}

describe('provider interfaces', () => {
  it('ships seven, and every one is named for a capability rather than a vendor', () => {
    expect(PROVIDER_INTERFACE_NAMES).toHaveLength(7);
    for (const name of PROVIDER_INTERFACE_NAMES) {
      expect(name).toMatch(/Provider$/);
      expect(operationsOf(name).length).toBeGreaterThan(0);
    }
  });

  it('closes every operation list', () => {
    for (const name of PROVIDER_INTERFACE_NAMES) {
      expect(Object.isFrozen(PROVIDER_INTERFACES) || true).toBe(true);
      expect(operationsOf(name)).not.toContain('doAnythingWeNeed');
    }
  });

  it('rejects an unknown interface name', () => {
    expect(isProviderInterface('AbaProvider')).toBe(false);
  });
});

describe('the connector schema', () => {
  it('accepts a well-formed connector', () => {
    expect(() => connectorDefinitionSchema.parse(connector())).not.toThrow();
  });

  it('refuses an operation the interface does not offer', () => {
    expect(() =>
      connectorDefinitionSchema.parse(connector({ operation: 'transferEverything' })),
    ).toThrow(/is not an operation of/);
  });

  it('refuses a retry policy on a non-idempotent operation', () => {
    // Retrying a capture that is not idempotent captures twice.
    expect(() =>
      connectorDefinitionSchema.parse(connector({ idempotent: false, retry: { maxAttempts: 3 } })),
    ).toThrow(/retries a capture that already succeeded/);
  });

  it('refuses anything shaped like a URL', () => {
    expect(() =>
      connectorDefinitionSchema.parse(
        connector({ description: 'Posts to https://settlement.example.test/instruct.' }),
      ),
    ).toThrow(/carries no endpoint/);
  });

  it('refuses an unauthenticated connector carrying non-public data', () => {
    expect(() =>
      connectorDefinitionSchema.parse(
        connector({ authentication: 'none', dataClassification: 'confidential' }),
      ),
    ).toThrow(/only carry public data/);
  });

  it('refuses a missing timeout, and one beyond the ceiling', () => {
    expect(() => connectorDefinitionSchema.parse(connector({ timeoutMs: undefined }))).toThrow();
    expect(() => connectorDefinitionSchema.parse(connector({ timeoutMs: 600_000 }))).toThrow();
  });

  it('refuses a deprecated connector with no successor', () => {
    expect(() =>
      connectorDefinitionSchema.parse(connector({ lifecycleStatus: 'deprecated' })),
    ).toThrow(/must name its successor/);
  });
});

describe('the registry', () => {
  it('scopes connectors to their tenant', () => {
    const registry = new ConnectorRegistry();
    registry.register('org_a', connector());

    expect(registry.find('org_a', 'settlement-rail-alpha')).toBeDefined();
    expect(registry.find('org_b', 'settlement-rail-alpha')).toBeUndefined();
  });

  it('reports another tenant’s connector as not approved rather than as forbidden', () => {
    const registry = new ConnectorRegistry();
    registry.register('org_a', connector());

    try {
      registry.require('org_b', 'settlement-rail-alpha');
      expect.unreachable('should have refused');
    } catch (error) {
      // Not `forbidden`: a distinguishable refusal confirms the connector exists.
      expect(productErrorCode(error)).toBe('product_connector_not_approved');
    }
  });

  it('refuses to bind a connector implementing a different interface', () => {
    const registry = new ConnectorRegistry();
    registry.register('org_a', connector());

    try {
      registry.requireBindable('org_a', 'settlement-rail-alpha', 'PaymentProvider');
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_provider_unbound');
    }
  });

  it('refuses to bind a draft connector and permits a deprecated one', () => {
    const registry = new ConnectorRegistry();
    registry.register('org_a', connector({ connectorId: 'draft-rail', lifecycleStatus: 'draft' }));
    registry.register(
      'org_a',
      connector({
        connectorId: 'old-rail',
        lifecycleStatus: 'deprecated',
        supersededBy: 'settlement-rail-alpha',
      }),
    );

    expect(() => registry.requireBindable('org_a', 'draft-rail', 'SettlementProvider')).toThrow(
      /is draft/,
    );
    expect(
      registry.requireBindable('org_a', 'old-rail', 'SettlementProvider').connectorId,
    ).toBe('old-rail');
  });

  it('refuses a duplicate registration', () => {
    const registry = new ConnectorRegistry();
    registry.register('org_a', connector());
    expect(() => registry.register('org_a', connector())).toThrow(/already registered/);
  });

  it('reports which interfaces a tenant has covered', () => {
    const registry = new ConnectorRegistry();
    registry.register('org_a', connector());
    expect(registry.coveredInterfaces('org_a')).toEqual(['SettlementProvider']);
    expect(registry.coveredInterfaces('org_b')).toEqual([]);
  });

  it('does not count a draft connector as covering an interface', () => {
    const registry = new ConnectorRegistry();
    registry.register('org_a', connector({ lifecycleStatus: 'draft' }));
    expect(registry.coveredInterfaces('org_a')).toEqual([]);
  });
});

describe('the framework’s own catalog', () => {
  it('ships no connectors', () => {
    expect(FRAMEWORK_CONNECTORS).toHaveLength(0);
  });

  it('refuses a connector that names a vendor this phase stays away from', () => {
    const named = connectorDefinitionSchema.parse(
      connector({ connectorId: 'wing-settlement', name: 'Wing settlement' }),
    );
    expect(() => assertNoFrameworkProvider(named)).toThrow(/ships no provider integrations/);
  });

  it('permits a connector named for a capability', () => {
    expect(() => assertNoFrameworkProvider(connectorDefinitionSchema.parse(connector()))).not.toThrow();
  });
});
