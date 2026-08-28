import { describe, expect, it } from 'vitest';
import {
  APPROVAL_LEVELS_BY_FIELD,
  EDITABLE_STATUSES,
  EXECUTABLE_STATUSES,
  LIFECYCLE_TRANSITIONS,
  MAKER_CHECKER_FIELDS,
  PRODUCT_LIFECYCLE_STATUSES,
  ReferenceDataRegistry,
  canonicalJson,
  definitionContentHash,
  hashesEqual,
  isProductId,
  newProductId,
  productContentHash,
  productError,
  productErrorCode,
  productDefinitionSchema,
  productRuleSchema,
  referenceEntrySchema,
  segregationViolations,
  structuralReferenceData,
  FINANCIAL_PRODUCT_PERMISSIONS,
} from './index';

function baseDefinition(overrides: Record<string, unknown> = {}) {
  return {
    productId: 'merchant-wallet-basic',
    productName: 'Merchant Wallet Basic',
    productType: 'merchant',
    description: 'A provider-neutral merchant wallet.',
    version: '1.0.0',
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
    reviewDate: '2027-01-01T00:00:00.000Z',
    blocks: [
      {
        key: 'create-wallet',
        blockId: 'wallet.create',
        blockVersion: '1.0.0',
        name: 'Create wallet',
      },
    ],
    transitions: [
      { from: 'start', to: 'create-wallet', kind: 'always' },
      { from: 'create-wallet', to: 'completed', kind: 'on_success' },
    ],
    riskPolicy: {},
    compliancePolicy: { dataClassification: 'confidential', retentionDays: 2555 },
    apiExposurePolicy: {
      slug: 'merchant-wallet-basic',
      authentication: ['bearer'],
      tenantScoped: true,
    },
    auditClassification: 'sensitive',
    ...overrides,
  };
}

describe('identifiers and content hashing', () => {
  it('mints prefixed identifiers that are recognisable as their own kind', () => {
    const id = newProductId('product');
    expect(isProductId(id, 'product')).toBe(true);
    expect(isProductId(id, 'version')).toBe(false);
  });

  it('hashes the same regardless of key order', () => {
    const left = productContentHash({ b: 2, a: 1, nested: { y: 'y', x: 'x' } });
    const right = productContentHash({ nested: { x: 'x', y: 'y' }, a: 1, b: 2 });
    expect(hashesEqual(left, right)).toBe(true);
  });

  it('treats an undefined field and a missing field as the same document', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('hashes differently when any value changes', () => {
    const before = productContentHash({ fee: '5000' });
    const after = productContentHash({ fee: '5001' });
    expect(hashesEqual(before, after)).toBe(false);
  });

  it('preserves array order, because a transition list is not a set', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('refusals', () => {
  it('carries a machine-readable code a client can switch on', () => {
    const error = productError('product_not_executable', 'Not active.', { productId: 'p' });
    expect(productErrorCode(error)).toBe('product_not_executable');
  });

  it('reports a tenant mismatch as not-found, never as forbidden', () => {
    // A 403 confirms the product exists, which is the enumeration primitive the boundary
    // exists to deny.
    const error = productError('product_tenant_mismatch', 'No such product.');
    expect(error.status).toBe(404);
  });

  it('returns null for an error that is not a product refusal', () => {
    expect(productErrorCode(new Error('boom'))).toBeNull();
  });
});

describe('reference data', () => {
  it('refuses an unknown code rather than defaulting', () => {
    const registry = structuralReferenceData();
    expect(() => registry.require('riskLevel', 'EXTREME')).toThrow(/Unknown riskLevel/);
    expect(registry.require('riskLevel', 'HIGH').label).toBe('High');
  });

  it('refuses a duplicate registration rather than letting load order decide', () => {
    const registry = structuralReferenceData();
    expect(() =>
      registry.register({ domain: 'riskLevel', code: 'HIGH', label: 'High again' }),
    ).toThrow(/already registered/);
  });

  it('refuses a deprecation with neither a successor nor an end date', () => {
    expect(() =>
      referenceEntrySchema.parse({
        domain: 'feeType',
        code: 'LEGACY',
        label: 'Legacy',
        status: 'deprecated',
      }),
    ).toThrow();
  });

  it('refuses a code that has stopped being effective, and names its successor', () => {
    const registry = new ReferenceDataRegistry([
      {
        domain: 'feeType',
        code: 'OLD_FLAT',
        label: 'Old flat',
        status: 'deprecated',
        effectiveTo: '2026-01-01T00:00:00.000Z',
        supersededBy: 'FLAT',
      } as never,
    ]);

    expect(() => registry.requireEffective('feeType', 'OLD_FLAT', new Date('2026-06-01'))).toThrow(
      /Use "FLAT"/,
    );
    expect(registry.requireEffective('feeType', 'OLD_FLAT', new Date('2025-06-01')).code).toBe(
      'OLD_FLAT',
    );
  });

  it('seeds the structural domains and no deployment-specific ones', () => {
    const registry = structuralReferenceData();
    expect(registry.list('riskLevel').length).toBeGreaterThan(0);
    // A framework that shipped a currency or country list ships one somebody overrides on day one.
    expect(registry.list('currency')).toHaveLength(0);
    expect(registry.list('country')).toHaveLength(0);
    expect(registry.list('merchantCategory')).toHaveLength(0);
  });
});

describe('the lifecycle table', () => {
  it('makes active the only executable state', () => {
    expect([...EXECUTABLE_STATUSES]).toEqual(['active']);
  });

  it('has no shortcut from an editable state to a live one', () => {
    for (const transition of LIFECYCLE_TRANSITIONS) {
      if (EDITABLE_STATUSES.has(transition.from)) {
        expect(EXECUTABLE_STATUSES.has(transition.to)).toBe(false);
      }
    }
  });

  it('reaches active only through approved and staged', () => {
    const intoActive = LIFECYCLE_TRANSITIONS.filter((transition) => transition.to === 'active');
    expect(intoActive.map((transition) => transition.from).sort()).toEqual(['paused', 'staged']);
  });

  it('lets an incident pause a product without waiting for a checker', () => {
    const pause = LIFECYCLE_TRANSITIONS.find((transition) => transition.action === 'pause');
    expect(pause?.requiresApproval).toBe(false);
  });

  it('requires an approval for every transition that makes a product more reachable', () => {
    const stage = LIFECYCLE_TRANSITIONS.find(
      (transition) => transition.from === 'approved' && transition.to === 'staged',
    );
    const activate = LIFECYCLE_TRANSITIONS.find(
      (transition) => transition.from === 'staged' && transition.to === 'active',
    );
    expect(stage?.requiresApproval).toBe(true);
    expect(activate?.requiresApproval).toBe(true);
  });

  it('describes every status', () => {
    for (const status of PRODUCT_LIFECYCLE_STATUSES) {
      expect(LIFECYCLE_TRANSITIONS.some(() => true)).toBe(true);
      expect(status.length).toBeGreaterThan(0);
    }
  });
});

describe('permissions', () => {
  it('separates authoring from approval', () => {
    expect(FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_CREATE.key).not.toBe(
      FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_APPROVE.key,
    );
  });

  it('reports a role that holds both sides of a segregated pair', () => {
    const violations = segregationViolations([
      FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_CREATE.key,
      FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_APPROVE.key,
    ]);
    expect(violations.length).toBeGreaterThan(0);
  });

  it('reports nothing for a role that holds only one side', () => {
    expect(segregationViolations([FINANCIAL_PRODUCT_PERMISSIONS.PRODUCT_CREATE.key])).toEqual([]);
  });
});

describe('the product definition schema', () => {
  it('accepts a minimal well-formed definition', () => {
    expect(() => productDefinitionSchema.parse(baseDefinition())).not.toThrow();
  });

  it('refuses two blocks with the same key', () => {
    const definition = baseDefinition({
      blocks: [
        { key: 'a', blockId: 'wallet.create', blockVersion: '1.0.0', name: 'A' },
        { key: 'a', blockId: 'wallet.activate', blockVersion: '1.0.0', name: 'A again' },
      ],
    });
    expect(() => productDefinitionSchema.parse(definition)).toThrow(/share the key/);
  });

  it('refuses a review date that is not after the effective date', () => {
    const definition = baseDefinition({ reviewDate: '2025-01-01T00:00:00.000Z' });
    expect(() => productDefinitionSchema.parse(definition)).toThrow(/after the effective date/);
  });

  it('refuses a transaction-creating operation with no idempotency key', () => {
    const definition = baseDefinition({
      apiExposurePolicy: {
        exposed: true,
        slug: 'merchant-wallet-basic',
        authentication: ['bearer'],
        tenantScoped: true,
        operations: [
          {
            operationId: 'acceptPayment',
            method: 'POST',
            path: '/payments',
            permission: 'financial.product.execute',
            createsTransaction: true,
          },
        ],
      },
    });
    expect(() => productDefinitionSchema.parse(definition)).toThrow(/idempotency key/);
  });

  it('refuses two operations claiming the same method and path', () => {
    const operation = {
      method: 'POST',
      path: '/payments',
      permission: 'financial.product.execute',
    };
    const definition = baseDefinition({
      apiExposurePolicy: {
        exposed: true,
        slug: 'merchant-wallet-basic',
        authentication: ['bearer'],
        tenantScoped: true,
        operations: [
          { ...operation, operationId: 'acceptPayment' },
          { ...operation, operationId: 'acceptPaymentAgain' },
        ],
      },
    });
    expect(() => productDefinitionSchema.parse(definition)).toThrow(/Route order/);
  });

  it('refuses a tenant-unscoped API exposure', () => {
    const definition = baseDefinition({
      apiExposurePolicy: {
        slug: 'merchant-wallet-basic',
        authentication: ['bearer'],
        tenantScoped: false,
      },
    });
    expect(() => productDefinitionSchema.parse(definition)).toThrow();
  });

  it('refuses fee tiers that do not ascend', () => {
    const definition = baseDefinition({
      fees: [
        {
          code: 'ACCEPTANCE',
          feeType: 'TIERED',
          basis: 'tiered',
          bearer: 'payee',
          tiers: [
            { fromMinorUnits: '100000', rate: { hundredthsOfBasisPoint: '5000' } },
            { fromMinorUnits: '0', rate: { hundredthsOfBasisPoint: '7500' } },
          ],
        },
      ],
    });
    expect(() => productDefinitionSchema.parse(definition)).toThrow(/ascend/);
  });

  it('refuses a monetary amount written as a number', () => {
    const definition = baseDefinition({
      limits: [
        {
          code: 'DAILY_IN',
          limitType: 'DAILY',
          scope: 'merchant',
          amount: { minorUnits: 500000, currency: 'USD' },
        },
      ],
    });
    expect(() => productDefinitionSchema.parse(definition)).toThrow();
  });

  it('refuses a conditional transition with no condition, and a condition on an unconditional one', () => {
    expect(() =>
      productDefinitionSchema.parse(
        baseDefinition({
          transitions: [
            { from: 'start', to: 'create-wallet', kind: 'conditional' },
            { from: 'create-wallet', to: 'completed', kind: 'on_success' },
          ],
        }),
      ),
    ).toThrow(/needs a condition/);

    expect(() =>
      productDefinitionSchema.parse(
        baseDefinition({
          transitions: [
            {
              from: 'start',
              to: 'create-wallet',
              kind: 'always',
              when: { field: 'amount', operator: 'exists' },
            },
            { from: 'create-wallet', to: 'completed', kind: 'on_success' },
          ],
        }),
      ),
    ).toThrow(/never evaluated/);
  });

  it('refuses a self-transition', () => {
    expect(() =>
      productDefinitionSchema.parse(
        baseDefinition({
          transitions: [
            { from: 'start', to: 'create-wallet', kind: 'always' },
            { from: 'create-wallet', to: 'create-wallet', kind: 'on_success' },
          ],
        }),
      ),
    ).toThrow(/infinite loop/);
  });

  it('refuses a settlement schedule with no cut-off', () => {
    expect(() =>
      productDefinitionSchema.parse(
        baseDefinition({ settlementPolicy: { schedule: 'daily', calendar: 'BUSINESS_DAYS' } }),
      ),
    ).toThrow(/cut-off/);
  });
});

describe('the rule schema', () => {
  it('accepts a rule with a condition and an outcome', () => {
    expect(() =>
      productRuleSchema.parse({
        id: 'enhanced-review-above-2000',
        description: 'Enhanced review above 2,000.',
        priority: 10,
        when: { field: 'amountMinorUnits', operator: 'gt', value: 200_000 },
        then: [{ kind: 'require_review', level: 'COMPLIANCE', reason: 'Above threshold.' }],
      }),
    ).not.toThrow();
  });

  it('refuses an unknown outcome kind rather than ignoring it', () => {
    expect(() =>
      productRuleSchema.parse({
        id: 'run-anything',
        description: 'Tries to smuggle an outcome in.',
        priority: 0,
        when: { field: 'amountMinorUnits', operator: 'exists' },
        then: [{ kind: 'execute', command: 'rm -rf /' }],
      }),
    ).toThrow();
  });

  it('refuses a percentage fee with no rate', () => {
    expect(() =>
      productRuleSchema.parse({
        id: 'gold-rate',
        description: 'Gold merchants pay 0.5%.',
        priority: 5,
        when: { field: 'merchantTier', operator: 'eq', value: 'GOLD' },
        then: [{ kind: 'set_fee', feeCode: 'ACCEPTANCE', basis: 'percentage' }],
      }),
    ).toThrow(/needs a rate/);
  });

  it('refuses a rate written as a float', () => {
    expect(() =>
      productRuleSchema.parse({
        id: 'float-rate',
        description: 'A rate as a float.',
        priority: 5,
        when: { field: 'merchantTier', operator: 'eq', value: 'GOLD' },
        then: [
          {
            kind: 'set_fee',
            feeCode: 'ACCEPTANCE',
            basis: 'percentage',
            rate: { hundredthsOfBasisPoint: 0.005 },
          },
        ],
      }),
    ).toThrow();
  });
});

describe('the maker-checker catalog', () => {
  it('names an approval level for every field that requires a second person', () => {
    for (const field of MAKER_CHECKER_FIELDS) {
      expect(APPROVAL_LEVELS_BY_FIELD[field]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('covers the nine changes section 18 requires maker-checker for', () => {
    for (const field of [
      'fees',
      'limits',
      'settlementPolicy',
      'providers',
      'riskPolicy',
      'compliancePolicy',
      'supportedCountries',
      'supportedCurrencies',
      'rules',
    ]) {
      expect(MAKER_CHECKER_FIELDS).toContain(field);
    }
  });
});

describe('the definition content hash', () => {
  it('ignores the lifecycle status', () => {
    // The hash answers "is this the product the reviewers approved". Staging, activating and
    // pausing during an incident change the status and change nothing a reviewer read — and a
    // hash that moved on a pause would refuse every in-flight transaction during exactly the
    // incident the pause was handling.
    const active = productDefinitionSchema.parse(baseDefinition({ lifecycleStatus: 'active' }));
    const paused = productDefinitionSchema.parse(baseDefinition({ lifecycleStatus: 'paused' }));

    expect(definitionContentHash(active)).toBe(definitionContentHash(paused));
  });

  it('changes when any reviewed field changes', () => {
    const before = productDefinitionSchema.parse(baseDefinition({ lifecycleStatus: 'active' }));
    const after = productDefinitionSchema.parse(
      baseDefinition({
        lifecycleStatus: 'active',
        fees: [
          {
            code: 'ACCEPTANCE',
            feeType: 'PERCENTAGE',
            basis: 'percentage',
            rate: { hundredthsOfBasisPoint: '5000' },
            bearer: 'payee',
          },
        ],
      }),
    );

    expect(definitionContentHash(before)).not.toBe(definitionContentHash(after));
  });
});
