import { describe, expect, it } from 'vitest';
import {
  productDefinitionSchema,
  productErrorCode,
  type ProductDefinition,
} from '@trustos/financial-product-core';
import {
  OVERRIDABLE_PATHS,
  changedPaths,
  parseVariant,
  productVariantSchema,
  resolveVariant,
} from './index';

function base(overrides: Record<string, unknown> = {}): ProductDefinition {
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
    supportedCountries: ['COUNTRY_A', 'COUNTRY_B'],
    supportedCurrencies: ['USD', 'EUR'],
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
    fees: [
      {
        code: 'ACCEPTANCE',
        feeType: 'PERCENTAGE',
        basis: 'percentage',
        rate: { hundredthsOfBasisPoint: '7500' },
        bearer: 'payee',
      },
    ],
    limits: [
      {
        code: 'DAILY_IN',
        limitType: 'DAILY',
        scope: 'merchant',
        amount: { minorUnits: '500000', currency: 'USD' },
      },
    ],
    rules: [
      {
        id: 'enhanced-review',
        description: 'Enhanced review above 2,000.',
        priority: 10,
        when: { field: 'amountMinorUnits', operator: 'gt', value: 200_000 },
        then: [{ kind: 'require_review', level: 'COMPLIANCE', reason: 'Above threshold.' }],
      },
    ],
    providers: [{ providerInterface: 'PaymentProvider', connectorId: 'rail-alpha' }],
    riskPolicy: {},
    compliancePolicy: { dataClassification: 'confidential', retentionDays: 2555 },
    apiExposurePolicy: { slug: 'merchant-wallet', authentication: ['bearer'], tenantScoped: true },
    auditClassification: 'sensitive',
    ...overrides,
  });
}

function variant(overrides: Record<string, unknown> = {}) {
  return parseVariant({
    variantId: 'sme',
    name: 'SME',
    description: 'The small-business variant.',
    baseProductId: 'merchant-wallet',
    baseVersion: '2.0.0',
    version: '1.0.0',
    lifecycleStatus: 'draft',
    effectiveDate: '2026-01-01T00:00:00.000Z',
    reviewDate: '2027-01-01T00:00:00.000Z',
    overrides: { supportedCountries: ['COUNTRY_A'] },
    ...overrides,
  });
}

describe('the variant schema', () => {
  it('has no field for blocks or transitions', () => {
    // The control, enforced by absence: a variant that could reorder a limit check and a debit
    // could remove the limit check.
    expect(OVERRIDABLE_PATHS).not.toContain('blocks');
    expect(OVERRIDABLE_PATHS).not.toContain('transitions');

    expect(() =>
      productVariantSchema.parse({
        ...variant(),
        overrides: { blocks: [] },
      }),
    ).toThrow();
  });

  it('refuses a variant that overrides nothing', () => {
    expect(() => variant({ overrides: {} })).toThrow(/overrides nothing/);
  });

  it('pins the base version exactly rather than to a range', () => {
    expect(() => variant({ baseVersion: '2.x' })).toThrow();
  });
});

describe('resolution', () => {
  it('produces an effective definition and says where each field came from', () => {
    const resolved = resolveVariant(base(), variant());

    expect(resolved.definition.supportedCountries).toEqual(['COUNTRY_A']);
    expect(resolved.provenance.source.supportedCountries).toBe('variant');
    expect(resolved.provenance.source.fees).toBe('base');
    expect(changedPaths(resolved.provenance)).toEqual(['supportedCountries']);
  });

  it('keeps the base workflow untouched', () => {
    const resolved = resolveVariant(base(), variant());
    expect(resolved.definition.blocks).toEqual(base().blocks);
    expect(resolved.definition.transitions).toEqual(base().transitions);
  });

  it('replaces a fee by code and records the replacement', () => {
    const resolved = resolveVariant(
      base(),
      variant({
        overrides: {
          fees: [
            {
              code: 'ACCEPTANCE',
              feeType: 'PERCENTAGE',
              basis: 'percentage',
              rate: { hundredthsOfBasisPoint: '5000' },
              bearer: 'payee',
            },
          ],
        },
      }),
    );

    expect(resolved.definition.fees).toHaveLength(1);
    expect(resolved.definition.fees[0]?.rate?.hundredthsOfBasisPoint).toBe('5000');
    expect(resolved.provenance.replaced).toEqual([{ path: 'fees', identity: 'ACCEPTANCE' }]);
  });

  it('appends a fee the base does not have', () => {
    const resolved = resolveVariant(
      base(),
      variant({
        overrides: {
          fees: [
            {
              code: 'PLATFORM',
              feeType: 'FLAT',
              basis: 'flat',
              flat: { minorUnits: '25', currency: 'USD' },
              bearer: 'platform',
            },
          ],
        },
      }),
    );

    expect(resolved.definition.fees.map((fee) => fee.code).sort()).toEqual([
      'ACCEPTANCE',
      'PLATFORM',
    ]);
    expect(resolved.provenance.added).toEqual([{ path: 'fees', identity: 'PLATFORM' }]);
  });

  it('cannot express removing a fee', () => {
    // The merge starts from the base list and only replaces or appends. There is no operation
    // that would drop one.
    const resolved = resolveVariant(base(), variant({ overrides: { fees: [] } }));
    expect(resolved.definition.fees.map((fee) => fee.code)).toEqual(['ACCEPTANCE']);
  });

  it('refuses a variant that widens the country list', () => {
    try {
      resolveVariant(
        base(),
        variant({ overrides: { supportedCountries: ['COUNTRY_A', 'COUNTRY_C'] } }),
      );
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_variant_override_refused');
      expect((error as Error).message).toContain('COUNTRY_C');
    }
  });

  it('refuses a variant that widens the currency list', () => {
    expect(() =>
      resolveVariant(base(), variant({ overrides: { supportedCurrencies: ['USD', 'GBP'] } })),
    ).toThrow(/GBP/);
  });

  it('permits narrowing', () => {
    const resolved = resolveVariant(
      base(),
      variant({ overrides: { supportedCurrencies: ['USD'] } }),
    );
    expect(resolved.definition.supportedCurrencies).toEqual(['USD']);
  });

  it('refuses a variant that disables a rule demanding review', () => {
    expect(() =>
      resolveVariant(
        base(),
        variant({
          overrides: {
            rules: [
              {
                id: 'enhanced-review',
                description: 'Turned off for this variant.',
                priority: 10,
                enabled: false,
                when: { field: 'amountMinorUnits', operator: 'gt', value: 200_000 },
                then: [{ kind: 'require_review', level: 'COMPLIANCE', reason: 'Above threshold.' }],
              },
            ],
          },
        }),
      ),
    ).toThrow(/stricter and may not make it looser/);
  });

  it('refuses a replacement that drops the review outcome', () => {
    expect(() =>
      resolveVariant(
        base(),
        variant({
          overrides: {
            rules: [
              {
                id: 'enhanced-review',
                description: 'Now just a tag.',
                priority: 10,
                when: { field: 'amountMinorUnits', operator: 'gt', value: 200_000 },
                then: [{ kind: 'tag', tag: 'large' }],
              },
            ],
          },
        }),
      ),
    ).toThrow(/control removed through a configuration change/);
  });

  it('permits a replacement that makes the control stricter', () => {
    const resolved = resolveVariant(
      base(),
      variant({
        overrides: {
          rules: [
            {
              id: 'enhanced-review',
              description: 'Enhanced review above 500.',
              priority: 10,
              when: { field: 'amountMinorUnits', operator: 'gt', value: 50_000 },
              then: [{ kind: 'require_review', level: 'COMPLIANCE', reason: 'Above threshold.' }],
            },
          ],
        },
      }),
    );

    expect(resolved.definition.rules[0]?.description).toContain('above 500');
  });

  it('permits adding a rule the base does not have', () => {
    const resolved = resolveVariant(
      base(),
      variant({
        overrides: {
          rules: [
            {
              id: 'sme-rate',
              description: 'SME rate.',
              priority: 5,
              when: { field: 'merchantTier', operator: 'eq', value: 'SME' },
              then: [
                {
                  kind: 'set_fee',
                  feeCode: 'ACCEPTANCE',
                  basis: 'percentage',
                  rate: { hundredthsOfBasisPoint: '6000' },
                },
              ],
            },
          ],
        },
      }),
    );

    expect(resolved.definition.rules.map((rule) => rule.id).sort()).toEqual([
      'enhanced-review',
      'sme-rate',
    ]);
  });

  it('refuses to resolve against a different base version', () => {
    try {
      resolveVariant(base({ version: '2.1.0' }), variant());
      expect.unreachable('should have refused');
    } catch (error) {
      expect(productErrorCode(error)).toBe('product_version_binding_broken');
    }
  });

  it('re-validates the merged document', () => {
    // An override that produces an invalid definition is refused here, not at execution time.
    expect(() =>
      resolveVariant(
        base(),
        variant({
          overrides: { settlementPolicy: { schedule: 'daily', calendar: 'BUSINESS_DAYS' } },
        }),
      ),
    ).toThrow(/cut-off/);
  });

  it('carries the variant’s additional approval levels through', () => {
    const resolved = resolveVariant(
      base(),
      variant({
        overrides: {
          supportedCountries: ['COUNTRY_A'],
          additionalApprovalLevels: ['RISK', 'COMPLIANCE'],
        },
      }),
    );
    expect(resolved.additionalApprovalLevels).toEqual(['COMPLIANCE', 'RISK']);
  });
});
