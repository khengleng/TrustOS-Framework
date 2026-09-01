import { describe, expect, it } from 'vitest';
import {
  collectingAuditRecorder,
  PRODUCT_AUDIT_ACTIONS,
  productDefinitionSchema,
  productErrorCode,
  type ProductDefinition,
} from '@trustsystem/financial-product-core';
import {
  assertApprovalComplete,
  assertGovernanceHealthy,
  assessGovernance,
  auditGovernanceAction,
  classifyChange,
  deriveApprovalState,
  governanceEntry,
  outstandingApprovals,
  recordDecision,
  type ProductDecision,
} from './index';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function definition(overrides: Record<string, unknown> = {}): ProductDefinition {
  return productDefinitionSchema.parse({
    productId: 'merchant-wallet',
    productName: 'Merchant Wallet',
    productType: 'merchant',
    description: 'A provider-neutral merchant wallet.',
    version: '2.0.0',
    ownership: {
      businessOwner: 'usr_business',
      technicalOwner: 'usr_tech',
      riskOwner: 'usr_risk',
      complianceOwner: 'usr_compliance',
    },
    supportedCountries: [],
    supportedCurrencies: ['USD'],
    lifecycleStatus: 'draft',
    effectiveDate: '2026-01-01T00:00:00.000Z',
    reviewDate: '2026-12-01T00:00:00.000Z',
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
    fees: [
      {
        code: 'ACCEPTANCE',
        feeType: 'PERCENTAGE',
        basis: 'percentage',
        rate: { hundredthsOfBasisPoint: '7500' },
        bearer: 'payee',
      },
    ],
    riskPolicy: {},
    compliancePolicy: { dataClassification: 'confidential', retentionDays: 2555 },
    apiExposurePolicy: { slug: 'merchant-wallet', authentication: ['bearer'], tenantScoped: true },
    auditClassification: 'sensitive',
    ...overrides,
  });
}

describe('change classification', () => {
  it('treats a new product as a change to everything it declares', () => {
    // A first version needing no approvals because "nothing changed" is the hole somebody
    // would use: create the product with the fee already in it.
    const classification = classifyChange(null, definition());
    expect(classification.hasChanges).toBe(true);
    expect(classification.sensitivePaths).toContain('fees');
    expect(classification.requiredApprovalLevels).toContain('FINANCE');
  });

  it('reports no change when the definition is identical', () => {
    expect(classifyChange(definition(), definition()).hasChanges).toBe(false);
  });

  it('ignores the lifecycle status and the version number', () => {
    const before = definition({ lifecycleStatus: 'draft', version: '2.0.0' });
    const after = definition({ lifecycleStatus: 'active', version: '2.1.0' });
    expect(classifyChange(before, after).hasChanges).toBe(false);
  });

  it('detects a fee change and demands finance', () => {
    const after = definition({
      fees: [
        {
          code: 'ACCEPTANCE',
          feeType: 'PERCENTAGE',
          basis: 'percentage',
          rate: { hundredthsOfBasisPoint: '5000' },
          bearer: 'payee',
        },
      ],
    });

    const classification = classifyChange(definition(), after);
    expect(classification.sensitivePaths).toEqual(['fees']);
    expect(classification.requiredApprovalLevels).toEqual(['FINANCE', 'PRODUCT_OWNER']);
  });

  it('unions the levels when a change touches two sensitive areas', () => {
    const after = definition({
      fees: [
        {
          code: 'ACCEPTANCE',
          feeType: 'FLAT',
          basis: 'flat',
          flat: { minorUnits: '100', currency: 'USD' },
          bearer: 'payee',
        },
      ],
      compliancePolicy: { dataClassification: 'restricted', retentionDays: 2555 },
    });

    const classification = classifyChange(definition(), after);
    // A union rather than the strictest set: taking a maximum of two sets is not a thing.
    expect(classification.requiredApprovalLevels).toEqual([
      'COMPLIANCE',
      'FINANCE',
      'PRODUCT_OWNER',
    ]);
  });

  it('detects a reordering of transitions, because order decides which branch runs first', () => {
    const before = definition();
    const after = definition({ transitions: [...before.transitions].reverse() });
    expect(classifyChange(before, after).changedPaths).toContain('transitions');
  });

  it('names counts rather than values in the summary', () => {
    const after = definition({ fees: [] });
    const classification = classifyChange(definition(), after);
    expect(classification.summary.join(' ')).toContain('1 -> 0 entries');
    // Never the commercial term itself: the summary reaches more people than the product does.
    expect(classification.summary.join(' ')).not.toContain('7500');
  });

  it('reports which approvals are still outstanding', () => {
    const classification = classifyChange(null, definition());
    expect(outstandingApprovals(classification, ['PRODUCT_OWNER'])).not.toContain('PRODUCT_OWNER');
  });
});

describe('maker-checker', () => {
  const classification = classifyChange(null, definition());

  function decisionInput(overrides: Record<string, unknown> = {}) {
    return {
      classification,
      existing: [] as ProductDecision[],
      productId: 'merchant-wallet',
      version: '2.0.0',
      organizationId: 'org_a',
      authoredById: 'usr_maker',
      actorId: 'usr_checker',
      level: classification.requiredApprovalLevels[0] as string,
      decision: 'approved' as const,
      now: NOW,
      ...overrides,
    };
  }

  it('records an independent approval', () => {
    const { decision, state } = recordDecision(decisionInput());
    expect(decision.actorId).toBe('usr_checker');
    expect(state.approvedLevels).toContain(decision.level);
  });

  it('refuses the maker deciding their own version', () => {
    try {
      recordDecision(decisionInput({ actorId: 'usr_maker' }));
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_self_approval_refused');
    }
  });

  it('refuses a second decision from the same person', () => {
    const { decision } = recordDecision(decisionInput());
    // Without this, a two-of-three requirement is satisfiable by one person clicking twice.
    expect(() =>
      recordDecision(
        decisionInput({ existing: [decision], level: classification.requiredApprovalLevels[1] }),
      ),
    ).toThrow(/already recorded a decision/);
  });

  it('refuses an approval at a level the change does not require', () => {
    // A new product touches every sensitive field, so it needs all six standard levels. The
    // refusal is for a level nothing in the change maps to.
    expect(classification.requiredApprovalLevels).not.toContain('MARKETING');
    expect(() => recordDecision(decisionInput({ level: 'MARKETING' }))).toThrow(
      /does not require approval/,
    );
  });

  it('refuses a rejection with no reason', () => {
    expect(() => recordDecision(decisionInput({ decision: 'rejected', reason: 'no' }))).toThrow();
  });

  it('lets a rejection settle the matter regardless of prior approvals', () => {
    const approvals = classification.requiredApprovalLevels.map((level, index) => ({
      decisionId: `fpap_${index}`,
      productId: 'merchant-wallet',
      version: '2.0.0',
      organizationId: 'org_a',
      level,
      actorId: `usr_approver_${index}`,
      decision: 'approved' as const,
      decidedAt: NOW.toISOString(),
    }));

    const withRejection: ProductDecision[] = [
      ...approvals,
      {
        decisionId: 'fpap_reject',
        productId: 'merchant-wallet',
        version: '2.0.0',
        organizationId: 'org_a',
        level: 'COMPLIANCE',
        actorId: 'usr_compliance',
        decision: 'rejected',
        reason: 'The retention period is shorter than the dispute window.',
        decidedAt: NOW.toISOString(),
      },
    ];

    const state = deriveApprovalState(classification, withRejection);
    expect(state.complete).toBe(false);
    expect(state.rejected?.actorId).toBe('usr_compliance');

    expect(() => assertApprovalComplete(state, 'merchant-wallet', '2.0.0')).toThrow(/was rejected/);
  });

  it('counts distinct deciders rather than decisions', () => {
    const state = deriveApprovalState(classification, [
      {
        decisionId: 'fpap_1',
        productId: 'merchant-wallet',
        version: '2.0.0',
        organizationId: 'org_a',
        level: 'PRODUCT_OWNER',
        actorId: 'usr_a',
        decision: 'approved',
        decidedAt: NOW.toISOString(),
      },
    ]);
    expect(state.distinctDeciders).toBe(1);
  });

  it('refuses publication while a level is outstanding', () => {
    const state = deriveApprovalState(classification, []);
    expect(() => assertApprovalComplete(state, 'merchant-wallet', '2.0.0')).toThrow(
      /missing approval/,
    );
  });
});

describe('governance assessment', () => {
  it('reports a healthy product', () => {
    const assessment = assessGovernance(definition(), new Date('2026-06-01T00:00:00.000Z'));
    expect(assessment.healthy).toBe(true);
  });

  it('reports an overdue review', () => {
    const assessment = assessGovernance(definition(), new Date('2027-03-01T00:00:00.000Z'));
    expect(assessment.healthy).toBe(false);
    expect(assessment.findings.some((finding) => finding.area === 'review')).toBe(true);
  });

  it('escalates a long-overdue review to a breach', () => {
    const assessment = assessGovernance(definition(), new Date('2027-06-01T00:00:00.000Z'));
    expect(assessment.findings.some((finding) => finding.severity === 'breach')).toBe(true);
  });

  it('warns without failing when a review is due soon', () => {
    const assessment = assessGovernance(definition(), new Date('2026-11-15T00:00:00.000Z'));
    expect(assessment.healthy).toBe(true);
    expect(assessment.findings[0]?.severity).toBe('due_soon');
  });

  it('notes when fewer people hold the owner roles than the model implies', () => {
    const oneOwner = definition({
      ownership: {
        businessOwner: 'usr_solo',
        technicalOwner: 'usr_solo',
        riskOwner: 'usr_solo',
        complianceOwner: 'usr_solo',
      },
    });

    const assessment = assessGovernance(oneOwner, NOW);
    // A staffing fact rather than a failure — but one that has to be said.
    expect(assessment.healthy).toBe(true);
    expect(assessment.findings.some((finding) => finding.area === 'ownership')).toBe(true);
  });

  it('treats a restricted product exposed over an API as a breach', () => {
    const exposed = definition({
      compliancePolicy: { dataClassification: 'restricted', retentionDays: 2555 },
      apiExposurePolicy: {
        exposed: true,
        slug: 'merchant-wallet',
        authentication: ['bearer'],
        tenantScoped: true,
        operations: [
          {
            operationId: 'acceptPayment',
            method: 'POST',
            path: '/payments',
            permission: 'financial.product.execute',
            createsTransaction: true,
            requiresIdempotencyKey: true,
          },
        ],
      },
    });

    const assessment = assessGovernance(exposed, NOW);
    expect(assessment.findings.some((finding) => finding.area === 'exposure')).toBe(true);
    expect(() => assertGovernanceHealthy(assessment)).toThrow(/not in good standing/);
  });

  it('refuses a lending product audited as standard', () => {
    const lending = definition({ productType: 'lending', auditClassification: 'standard' });
    expect(assessGovernance(lending, NOW).healthy).toBe(false);
  });

  it('refuses a retention shorter than the dispute window', () => {
    const shortRetention = definition({
      compliancePolicy: { dataClassification: 'confidential', retentionDays: 90 },
    });
    expect(assessGovernance(shortRetention, NOW).healthy).toBe(false);
  });

  it('builds the catalog entry a governance review reads', () => {
    const entry = governanceEntry(definition(), null);
    expect(entry.riskOwner).toBe('usr_risk');
    expect(entry.lastReviewedAt).toBeNull();
  });
});

describe('the audit trail', () => {
  it('records a governance action with the version it applied to', async () => {
    const recorder = collectingAuditRecorder();

    await auditGovernanceAction(recorder, {
      action: PRODUCT_AUDIT_ACTIONS.PRODUCT_APPROVED,
      productId: 'merchant-wallet',
      version: '2.0.0',
      organizationId: 'org_a',
      actorId: 'usr_checker',
      outcome: 'allowed',
      detail: { level: 'RISK' },
      now: NOW,
    });

    expect(recorder.records).toHaveLength(1);
    expect(recorder.records[0]?.entityId).toBe('merchant-wallet@2.0.0');
    expect(recorder.records[0]?.action).toBe('financial.product.approved');
  });
});
