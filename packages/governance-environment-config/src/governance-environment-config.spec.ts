import { describe, expect, it } from 'vitest';
import {
  EnvironmentRegistry,
  assertNoCrossEnvironmentCredential,
  environmentConfigSchema,
  environmentRank,
  planPromotion,
} from './index';

function config(environment: 'dev' | 'uat' | 'prod', overrides: Record<string, unknown> = {}) {
  return environmentConfigSchema.parse({
    environment,
    label: environment.toUpperCase(),
    gatewayRef: `gateway://${environment}`,
    credentialRefs: { 'reporting.transactions': `secret://reporting/${environment}/readonly` },
    editable: environment !== 'prod',
    carriesProductionData: environment === 'prod',
    promotionApprovals: environment === 'prod' ? ['security', 'operations'] : ['operations'],
    ...overrides,
  });
}

describe('environment configuration', () => {
  it('refuses an editable production', () => {
    // Production is promoted into, not written in — otherwise the reviewed artefact and the
    // running one are different.
    expect(() => config('prod', { editable: true })).toThrow(/not editable/);
  });

  it('refuses production with no promotion approval', () => {
    expect(() => config('prod', { promotionApprovals: [] })).toThrow(/at least one approval/);
  });

  it('refuses a non-production environment carrying production data', () => {
    // If the data is real, the environment is PROD with weaker controls.
    expect(() => config('uat', { carriesProductionData: true })).toThrow(/the environment is PROD/);
  });

  it('carries a gateway reference rather than a URL', () => {
    expect(config('dev').gatewayRef).not.toContain('http');
  });

  it('orders the environments', () => {
    expect(environmentRank('dev')).toBeLessThan(environmentRank('uat'));
    expect(environmentRank('uat')).toBeLessThan(environmentRank('prod'));
  });
});

describe('credential isolation', () => {
  it('refuses a credential reference shared across environments', () => {
    // The copied .env. It works, which is why nobody notices until an export.
    expect(() =>
      assertNoCrossEnvironmentCredential([
        config('dev', { credentialRefs: { 'reporting.transactions': 'secret://shared' } }),
        config('prod', { credentialRefs: { 'reporting.transactions': 'secret://shared' } }),
      ]),
    ).toThrow(/used by both dev and prod/);
  });

  it('permits the same reference used twice within one environment', () => {
    expect(() =>
      assertNoCrossEnvironmentCredential([
        config('dev', {
          credentialRefs: { a: 'secret://dev/one', b: 'secret://dev/one' },
        }),
      ]),
    ).not.toThrow();
  });

  it('refuses at load rather than at first use', () => {
    // By first use it has already worked once, and a thing that works is depended on by the
    // afternoon.
    expect(
      () =>
        new EnvironmentRegistry([
          config('dev', { credentialRefs: { x: 'secret://shared' } }),
          config('prod', { credentialRefs: { x: 'secret://shared' } }),
        ]),
    ).toThrow(/used by both/);
  });

  it('builds a registry when every environment has its own credentials', () => {
    const registry = new EnvironmentRegistry([config('dev'), config('uat'), config('prod')]);
    expect(registry.all().map((entry) => entry.environment)).toEqual(['dev', 'uat', 'prod']);
  });

  it('refuses a lookup for an environment it does not have', () => {
    expect(() => new EnvironmentRegistry([config('dev')]).get('prod')).toThrow(/No configuration/);
  });
});

describe('promotion', () => {
  const registry = new EnvironmentRegistry([config('dev'), config('uat'), config('prod')]);

  function plan(overrides: Record<string, unknown> = {}) {
    return planPromotion({
      appId: 'operations-console',
      appVersion: '1.0.0',
      fromEnvironment: 'uat',
      toEnvironment: 'prod',
      registry,
      resourcesResolved: true,
      unregisteredResources: [],
      hasTestEvidence: true,
      securityReviewed: true,
      rollbackTarget: '0.9.0',
      ...overrides,
    } as never);
  }

  it('allows a well-prepared promotion and names the approvals it needs', () => {
    const promotion = plan();
    expect(promotion.allowed).toBe(true);
    expect(promotion.requiredApprovals).toEqual(['security', 'operations']);
  });

  it('refuses a skipped stage', () => {
    // The stage it skips is the one where somebody would have used it.
    const promotion = plan({ fromEnvironment: 'dev', toEnvironment: 'prod' });
    expect(promotion.allowed).toBe(false);
    expect(promotion.blockers.join(' ')).toContain('skips uat');
  });

  it('refuses a demotion', () => {
    const promotion = plan({ fromEnvironment: 'prod', toEnvironment: 'uat' });
    expect(promotion.allowed).toBe(false);
    expect(promotion.blockers.join(' ')).toContain('not a promotion');
  });

  it('refuses when a resource is not registered in the target', () => {
    const promotion = plan({ resourcesResolved: false, unregisteredResources: ['reporting.new'] });
    expect(promotion.blockers.join(' ')).toContain('reporting.new');
  });

  it('refuses with no test evidence', () => {
    expect(plan({ hasTestEvidence: false }).allowed).toBe(false);
  });

  it('refuses a production promotion with no security review', () => {
    expect(plan({ securityReviewed: false }).allowed).toBe(false);
  });

  it('refuses a production promotion with no rollback target', () => {
    const promotion = plan({ rollbackTarget: null });
    expect(promotion.blockers.join(' ')).toContain('no way back');
  });

  it('reports every blocker rather than only the first', () => {
    const promotion = plan({
      hasTestEvidence: false,
      securityReviewed: false,
      rollbackTarget: null,
    });
    expect(promotion.blockers.length).toBe(3);
  });

  it('tells a reviewer what will change', () => {
    expect(plan().effects.join(' ')).toContain('not editable');
  });
});
