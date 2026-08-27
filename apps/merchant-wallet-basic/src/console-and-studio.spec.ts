import { describe, expect, it } from 'vitest';
import { classifyStandardResource } from '@trustos/governance-resource-policy';
import { merchantWalletBasicTemplate, validateProduct } from '@trustos/financial-product-composer';
import { assessGovernance, classifyChange } from '@trustos/financial-product-governance';
import { publishVersion } from '@trustos/financial-product-versioning';
import { SANDBOX_EPOCH } from '@trustos/financial-product-sandbox';
import { APPROVED_BLOCKS } from '@trustos/financial-block-registry';
import { merchantOperationsConsole } from './console';

/**
 * §11 the Merchant Operations Console and §12 the Financial Product Studio.
 *
 * Both are demonstrations that the framework's surfaces work for this product, so the assertions
 * are about *shape* rather than about behaviour the framework already tests: that the console can
 * only call APIs, that the product validates, that publishing refuses a self-approval.
 */

describe('the Merchant Operations Console', () => {
  const app = merchantOperationsConsole();

  it('validates as an internal application', () => {
    // The assertion is that construction did not throw. The schema enforces the rest.
    expect(app.appId).toBe('merchant-operations-console');
  });

  it('shows the nine things the specification asks for', () => {
    const sources = app.dataSources.map((source) => source.id);

    for (const required of [
      'merchants',
      'approval-queue',
      'wallets',
      'transactions',
      'failed-transactions',
      'settlements',
      'reconciliation',
      'audit',
      'health',
    ]) {
      expect(sources, required).toContain(required);
    }
  });

  it('offers the five controlled actions', () => {
    expect(app.actions.map((action) => action.id).sort()).toEqual([
      'approve-merchant',
      'freeze-wallet',
      'open-case',
      'reject-merchant',
      'request-limit-change',
    ]);
  });

  it('calls an API for every action, and mutates nothing directly', () => {
    /*
     * "No direct authoritative database mutation" is not a policy the console follows — a console
     * has no query and no write, so it is a sentence with nowhere to be violated.
     */
    for (const action of app.actions) {
      expect(action.apiPath.startsWith('/internal/v1/'), action.id).toBe(true);
      expect(action.operation).toBe('execute');
    }
  });

  it('reads every authoritative source through the API rather than a replica', () => {
    const authoritative = app.dataSources.filter((source) =>
      source.resourceId.startsWith('trustos.'),
    );

    for (const source of authoritative) {
      expect(classifyStandardResource(source.resourceId), source.id).toBe('api_only');
    }
  });

  it('requires approval for the two irreversible actions', () => {
    const approving = app.actions.filter((action) => action.requiresApproval).map((a) => a.id);

    expect(approving).toContain('approve-merchant');
    expect(approving).toContain('request-limit-change');
  });

  it('requires a reason for every action', () => {
    // An action taken with no reason is an action nobody can review afterwards.
    for (const action of app.actions) {
      expect(action.requiresReason, action.id).toBe(true);
    }
  });

  it('declares only AI features that summarize or explain', () => {
    for (const feature of app.aiFeatures) {
      expect(feature).toMatch(/^(summarize|explain|draft)_/);
    }
  });

  it('is classified restricted and high risk', () => {
    // It shows wallets, transactions and the audit trail.
    expect(app.dataClassification).toBe('restricted');
    expect(app.riskClassification).toBe('high');
  });

  it('starts as a draft in dev, not live in production', () => {
    // A console definition that shipped as published in production would be a console nobody
    // approved, live, over restricted data.
    expect(app.lifecycleStatus).toBe('draft');
    expect(app.environment).toBe('dev');
  });
});

describe('the Financial Product Studio', () => {
  const definition = merchantWalletBasicTemplate();

  it('shows the product definition with its eleven blocks', () => {
    expect(definition.productId).toBe('merchant-wallet-basic');
    expect(definition.blocks).toHaveLength(11);
  });

  it('shows the blocks resolving against the approved catalog', () => {
    const approved = new Set(APPROVED_BLOCKS.all().map((block) => block.blockId));

    for (const block of definition.blocks) {
      expect(approved.has(block.blockId), block.key).toBe(true);
    }
  });

  it('validates, with the unbound providers reported as warnings', () => {
    /*
     * Two warnings, both correct: nothing binds a PaymentProvider. The pilot uses declared mocks
     * rather than connectors, and a validator that reported this as an error would refuse a
     * product nobody intends to publish.
     */
    const result = validateProduct(definition);
    const errors = result.findings.filter((finding) => finding.severity === 'error');
    const warnings = result.findings.filter((finding) => finding.code === 'provider_unbound');

    expect(result.valid).toBe(true);
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it('shows the fee and limit configuration on the definition', () => {
    /*
     * The rate is in hundredths of a basis point: "5000" is 0.5%. Not a float anywhere, and not a
     * number in code — the studio shows what the definition says.
     */
    const fee = definition.fees[0];
    expect(fee?.rate?.hundredthsOfBasisPoint).toBe('5000');

    const limit = definition.limits[0];
    expect(limit?.amount?.minorUnits).toBe('500000');
  });

  it('publishes a version with a content hash', () => {
    const version = publishVersion({
      definition: { ...definition, lifecycleStatus: 'active' },
      organizationId: 'org_pilot',
      publishedById: 'usr_publisher',
      authoredById: 'usr_maker',
      approvedBy: [{ level: 'RISK', actorId: 'usr_risk' }],
      supersedes: null,
      changeSummary: 'The pilot product, published for the studio demonstration.',
      changedPaths: [],
      now: SANDBOX_EPOCH,
    });

    expect(version.contentHash).toMatch(/^sha256:[0-9a-f]{16,}$/);
    expect(version.definition.productId).toBe('merchant-wallet-basic');
  });

  it('refuses a publication the author approved alone', () => {
    /*
     * The studio's own maker-checker. Publishing a product is as consequential as any change
     * maker-checker protects — it decides what happens to money.
     */
    expect(() =>
      publishVersion({
        definition: { ...definition, lifecycleStatus: 'active' },
        organizationId: 'org_pilot',
        publishedById: 'usr_maker',
        authoredById: 'usr_maker',
        approvedBy: [],
        supersedes: null,
        changeSummary: 'Publishing my own product with nobody approving it.',
        changedPaths: [],
        now: SANDBOX_EPOCH,
      }),
    ).toThrow();
  });

  it('classifies a fee change and says which approvals it needs', () => {
    const changed = {
      ...definition,
      fees: definition.fees.map((fee, index) =>
        index === 0 ? { ...fee, basisPoints: (fee.basisPoints ?? 50) * 2 } : fee,
      ),
    };

    const change = classifyChange(definition, changed);

    expect(change.hasChanges).toBe(true);
    expect(change.changedPaths.length).toBeGreaterThan(0);
    // A fee change needs a finance approval, which is the point of classifying it.
    expect(change.requiredApprovalLevels).toContain('FINANCE');
  });

  it('treats a first version as a change to everything', () => {
    /*
     * Not an empty diff. A first version needing no approvals because "nothing changed" is the
     * exact hole somebody would use: create the product with the fee already in it, and the fee
     * never goes through a fee review.
     */
    const change = classifyChange(null, definition);

    expect(change.requiredApprovalLevels).toContain('FINANCE');
    expect(change.requiredApprovalLevels).toContain('RISK');
  });

  it('reports the product’s governance health and its review date', () => {
    const assessment = assessGovernance(definition, new Date('2026-06-15T00:00:00.000Z'));

    expect(assessment.productId).toBe('merchant-wallet-basic');
    expect(typeof assessment.daysUntilReview).toBe('number');
  });
});
