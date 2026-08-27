import { describe, expect, it } from 'vitest';
import {
  definitionContentHash,
  productDefinitionSchema,
  productErrorCode,
  type ProductDefinition,
} from '@trustos/financial-product-core';
import {
  applyRollback,
  assertBindingIntact,
  assertSufficientBump,
  assertUnpublishedOrIdentical,
  bindVersion,
  bindingIsStale,
  planRollback,
  publishVersion,
  verifyContentHash,
  type PublishedVersion,
} from './index';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function definition(overrides: Record<string, unknown> = {}): ProductDefinition {
  return productDefinitionSchema.parse({
    productId: 'merchant-wallet',
    productName: 'Merchant Wallet',
    productType: 'merchant',
    description: 'A provider-neutral merchant wallet.',
    version: '2.1.0',
    ownership: {
      businessOwner: 'usr_business',
      technicalOwner: 'usr_tech',
      riskOwner: 'usr_risk',
      complianceOwner: 'usr_compliance',
    },
    supportedCountries: [],
    supportedCurrencies: ['USD'],
    lifecycleStatus: 'active',
    effectiveDate: '2026-01-01T00:00:00.000Z',
    reviewDate: '2027-01-01T00:00:00.000Z',
    blocks: [
      {
        key: 'accept-payment',
        blockId: 'payment.execute',
        blockVersion: '1.0.0',
        name: 'Accept payment',
      },
    ],
    transitions: [
      { from: 'start', to: 'accept-payment', kind: 'always' },
      { from: 'accept-payment', to: 'completed', kind: 'on_success' },
    ],
    riskPolicy: {},
    compliancePolicy: { dataClassification: 'confidential', retentionDays: 2555 },
    apiExposurePolicy: { slug: 'merchant-wallet', authentication: ['bearer'], tenantScoped: true },
    auditClassification: 'sensitive',
    ...overrides,
  });
}

function published(overrides: Record<string, unknown> = {}): PublishedVersion {
  return publishVersion({
    definition: definition(),
    organizationId: 'org_a',
    publishedById: 'usr_publisher',
    authoredById: 'usr_maker',
    approvedBy: [{ level: 'RISK', actorId: 'usr_checker' }],
    supersedes: '2.0.0',
    changeSummary: 'Raised the merchant acceptance rate to 0.75%.',
    changedPaths: ['fees'],
    now: NOW,
    ...overrides,
  } as never);
}

describe('publishing', () => {
  it('records the hash of the definition it publishes', () => {
    const version = published();
    expect(version.contentHash).toBe(definitionContentHash(version.definition));
    expect(() => verifyContentHash(version)).not.toThrow();
  });

  it('refuses an author publishing their own version with no approvals', () => {
    try {
      published({ publishedById: 'usr_maker', approvedBy: [] });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_self_approval_refused');
    }
  });

  it('refuses a version that does not supersede what it claims to', () => {
    expect(() => published({ supersedes: '2.2.0' })).toThrow(/is not\s+newer|not newer/);
  });

  it('refuses a change summary that says nothing', () => {
    expect(() => published({ changeSummary: 'updates' })).toThrow();
  });

  it('catches a definition edited after publication', () => {
    const version = published();
    const tampered: PublishedVersion = {
      ...version,
      definition: { ...version.definition, description: 'Quietly different.' },
    };

    try {
      verifyContentHash(tampered);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_version_binding_broken');
    }
  });
});

describe('immutability', () => {
  it('permits an edit while the product is still editable', () => {
    const draft = definition({ lifecycleStatus: 'draft' });
    expect(() =>
      assertUnpublishedOrIdentical(
        'draft',
        definitionContentHash(draft),
        definition({ lifecycleStatus: 'draft', description: 'Changed.' }),
      ),
    ).not.toThrow();
  });

  it('refuses an edit once the product is under review', () => {
    const frozen = definition({ lifecycleStatus: 'under_review' });
    try {
      assertUnpublishedOrIdentical(
        'under_review',
        definitionContentHash(frozen),
        definition({ lifecycleStatus: 'under_review', description: 'Changed.' }),
      );
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_definition_immutable');
    }
  });

  it('permits an idempotent re-save of a byte-identical definition', () => {
    const frozen = definition({ lifecycleStatus: 'active' });
    expect(() =>
      assertUnpublishedOrIdentical('active', definitionContentHash(frozen), frozen),
    ).not.toThrow();
  });
});

describe('version bumps', () => {
  it('refuses a patch bump for a workflow change', () => {
    expect(() => assertSufficientBump('2.1.0', '2.1.1', ['blocks'])).toThrow(/breaking change/);
  });

  it('accepts a major bump for a workflow change', () => {
    expect(() => assertSufficientBump('2.1.0', '3.0.0', ['blocks'])).not.toThrow();
  });

  it('treats the minor as the breaking position below 1.0.0', () => {
    expect(() => assertSufficientBump('0.9.0', '0.9.1', ['apiExposurePolicy'])).toThrow(
      /minor is the breaking position/,
    );
    expect(() => assertSufficientBump('0.9.0', '0.10.0', ['apiExposurePolicy'])).not.toThrow();
  });

  it('accepts a patch bump for a non-breaking change', () => {
    expect(() => assertSufficientBump('2.1.0', '2.1.1', ['description'])).not.toThrow();
  });

  it('refuses a bump that goes backwards', () => {
    expect(() => assertSufficientBump('2.1.0', '2.0.0', [])).toThrow(/not newer/);
  });
});

describe('version binding', () => {
  it('binds an active product in production', () => {
    const binding = bindVersion({ version: published(), environment: 'production', now: NOW });
    expect(binding.version).toBe('2.1.0');
    expect(binding.statusAtBind).toBe('active');
  });

  it('refuses a draft product in production', () => {
    const draft = published({ definition: definition({ lifecycleStatus: 'draft' }) });
    try {
      bindVersion({ version: draft, environment: 'production', now: NOW });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_not_executable');
    }
  });

  it('permits a draft product in the sandbox', () => {
    const draft = published({ definition: definition({ lifecycleStatus: 'draft' }) });
    expect(() => bindVersion({ version: draft, environment: 'sandbox', now: NOW })).not.toThrow();
  });

  it('refuses a retired product even in the sandbox', () => {
    const retired = published({ definition: definition({ lifecycleStatus: 'retired' }) });
    try {
      bindVersion({ version: retired, environment: 'sandbox', now: NOW });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_sandbox_only');
    }
  });

  it('lets a bound execution finish after the product is paused', () => {
    // The hash covers reviewed content, not lifecycle state — see `definitionContentHash`.
    // Pausing stops new transactions. A pause that killed running ones would leave
    // half-finished movements every time an incident was handled.
    const binding = bindVersion({ version: published(), environment: 'production', now: NOW });
    const paused = published({ definition: definition({ lifecycleStatus: 'paused' }) });

    expect(() => assertBindingIntact(binding, paused)).not.toThrow();
  });

  it('refuses to resume against a different version', () => {
    const binding = bindVersion({ version: published(), environment: 'production', now: NOW });
    const next = published({
      definition: definition({ version: '2.2.0' }),
      supersedes: '2.1.0',
    });

    try {
      assertBindingIntact(binding, next);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_version_binding_broken');
    }
  });

  it('refuses to resume when the definition changed under the execution', () => {
    const binding = bindVersion({ version: published(), environment: 'production', now: NOW });
    const edited: PublishedVersion = { ...published(), contentHash: `sha256:${'0'.repeat(64)}` };

    expect(() => assertBindingIntact(binding, edited)).toThrow(
      /has changed since this execution started/,
    );
  });

  it('reports a binding as stale when a newer version is active', () => {
    const binding = bindVersion({ version: published(), environment: 'production', now: NOW });
    expect(bindingIsStale(binding, '2.2.0')).toBe(true);
    expect(bindingIsStale(binding, '2.1.0')).toBe(false);
    expect(bindingIsStale(binding, null)).toBe(false);
  });
});

describe('rollback', () => {
  const current = published();
  const target = published({
    definition: definition({ version: '2.0.0' }),
    supersedes: '1.9.0',
    changeSummary: 'The version before the acceptance rate change.',
  });

  it('plans a rollback and lists what would change', () => {
    const plan = planRollback({
      current,
      target,
      reason: 'The 0.75% rate was applied to the wrong merchant tier.',
      inFlightCount: 12,
    });

    expect(plan.from).toBe('2.1.0');
    expect(plan.to).toBe('2.0.0');
    expect(plan.isDowngrade).toBe(true);
    expect(plan.effects.some((effect) => effect.includes('Nothing historical is rewritten'))).toBe(
      true,
    );
  });

  it('does not rewrite historical executions', () => {
    const plan = planRollback({
      current,
      target,
      reason: 'The 0.75% rate was applied to the wrong merchant tier.',
      inFlightCount: 12,
    });
    const outcome = applyRollback(plan, NOW);

    // The property a dispute during an incident depends on.
    expect(outcome.historicalExecutionsRewritten).toBe(0);
    expect(outcome.pausedVersion).toBe('2.1.0');
    expect(outcome.activatedVersion).toBe('2.0.0');
  });

  it('refuses a target that was never approved', () => {
    const unapproved = published({
      definition: definition({ version: '2.0.0' }),
      publishedById: 'usr_publisher',
      approvedBy: [],
      supersedes: '1.9.0',
      changeSummary: 'Published without approvals in a test fixture.',
    });

    try {
      planRollback({
        current,
        target: unapproved,
        reason: 'Incident on the live version.',
        inFlightCount: 0,
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_approval_required');
    }
  });

  it('refuses a rollback with no reason', () => {
    expect(() => planRollback({ current, target, reason: 'fix', inFlightCount: 0 })).toThrow(
      /needs a reason/,
    );
  });

  it('refuses a rollback to the version already live', () => {
    expect(() =>
      planRollback({
        current,
        target: current,
        reason: 'Trying to roll back to now.',
        inFlightCount: 0,
      }),
    ).toThrow(/already live/);
  });

  it('reports a cross-tenant rollback target as not found', () => {
    const otherTenant = published({
      definition: definition({ version: '2.0.0' }),
      organizationId: 'org_b',
      supersedes: '1.9.0',
      changeSummary: 'Another tenant’s version entirely.',
    });

    try {
      planRollback({
        current,
        target: otherTenant,
        reason: 'Incident on the live version.',
        inFlightCount: 0,
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_not_found');
    }
  });
});
