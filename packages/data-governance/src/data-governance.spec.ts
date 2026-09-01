import { describe, expect, it } from 'vitest';
import { DataCatalog, catalogEntrySchema } from '@trustsystem/data-catalog';
import { retentionRuleSchema } from '@trustsystem/data-retention';
import { assertGoverned, assess, residencyPolicySchema, validatePlacement } from './index';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function entry(overrides: Record<string, unknown> = {}) {
  return catalogEntrySchema.parse({
    entryId: 'db.core.customer',
    kind: 'table',
    technicalName: 'customer',
    businessName: 'Customer',
    description: 'One row per customer.',
    parentId: null,
    owner: 'usr_data',
    steward: 'usr_steward',
    businessDomain: 'customer',
    classification: 'CONFIDENTIAL',
    personalData: true,
    environment: 'prod',
    residencyRegion: 'ap-southeast-1',
    purpose: 'Operating the customer account.',
    legalBasis: 'contract',
    nextReviewDate: '2026-12-31T00:00:00.000Z',
    lastReviewDate: null,
    ...overrides,
  });
}

const coveringRule = retentionRuleSchema.parse({
  ruleId: 'customer-records',
  description: 'Customer records are kept for the contractual period.',
  appliesTo: { classification: 'CONFIDENTIAL', personalData: true },
  minimumRetentionDays: 365,
  maximumRetentionDays: 2555,
  action: 'anonymize',
  legalBasis: 'Contractual and statutory retention.',
  effectiveFrom: '2020-01-01T00:00:00.000Z',
  reviewDate: '2027-01-01T00:00:00.000Z',
});

const residency = residencyPolicySchema.parse({
  policyId: 'apac-personal-data',
  description: 'Personal data stays in the region it was collected in.',
  permittedRegions: ['ap-southeast-1'],
  appliesTo: { personalData: true },
  legalBasis: 'Local data-protection law.',
});

describe('assessment', () => {
  it('reports nothing when everything is in order', () => {
    const assessment = assess({
      catalog: new DataCatalog([entry()]),
      retentionRules: [coveringRule],
      residencyPolicies: [residency],
      now: NOW,
    });

    expect(assessment.findings).toEqual([]);
    expect(assessment.healthy).toBe(true);
  });

  it('finds a table classified below what its columns contain', () => {
    // The commonest error there is: tables are classified when created and columns are added
    // later.
    const catalog = new DataCatalog([
      entry({ classification: 'INTERNAL', personalData: false, legalBasis: null }),
      entry({
        entryId: 'db.core.customer.national_id',
        kind: 'column',
        parentId: 'db.core.customer',
        technicalName: 'national_id',
        businessName: 'National identifier',
        classification: 'HIGHLY_RESTRICTED',
        personalData: false,
      }),
    ]);

    const assessment = assess({
      catalog,
      retentionRules: [coveringRule],
      residencyPolicies: [],
      now: NOW,
    });

    const finding = assessment.findings.find(
      (entry) => entry.kind === 'classification_below_content',
    );
    expect(finding?.severity).toBe('breach');
    expect(finding?.message).toContain('every downstream control is currently the wrong one');
  });

  it('finds personal data with no lawful basis', () => {
    const assessment = assess({
      catalog: new DataCatalog([entry({ legalBasis: null })]),
      retentionRules: [coveringRule],
      residencyPolicies: [residency],
      now: NOW,
    });

    expect(assessment.findings.some((finding) => finding.kind === 'personal_data_no_basis')).toBe(
      true,
    );
    expect(assessment.healthy).toBe(false);
  });

  it('finds an entry no retention rule covers', () => {
    const assessment = assess({
      catalog: new DataCatalog([entry()]),
      retentionRules: [],
      residencyPolicies: [residency],
      now: NOW,
    });

    const finding = assessment.findings.find((entry) => entry.kind === 'no_retention_rule');
    // Personal data with no rule is a breach; ordinary data is a warning.
    expect(finding?.severity).toBe('breach');
  });

  it('escalates a long-overdue review to a breach', () => {
    const assessment = assess({
      catalog: new DataCatalog([entry({ nextReviewDate: '2025-01-01T00:00:00.000Z' })]),
      retentionRules: [coveringRule],
      residencyPolicies: [residency],
      now: NOW,
    });

    expect(assessment.findings.find((entry) => entry.kind === 'review_overdue')?.severity).toBe(
      'breach',
    );
  });

  it('finds data outside its residency region', () => {
    const assessment = assess({
      catalog: new DataCatalog([entry({ residencyRegion: 'eu-west-1' })]),
      retentionRules: [coveringRule],
      residencyPolicies: [residency],
      now: NOW,
    });

    expect(assessment.findings.some((finding) => finding.kind === 'residency_violation')).toBe(
      true,
    );
  });

  it('notes when one person owns more than anybody reviews', () => {
    const entries = Array.from({ length: 60 }, (_, index) =>
      entry({ entryId: `db.core.table_${index}`, personalData: false, legalBasis: null }),
    );

    const assessment = assess({
      catalog: new DataCatalog(entries),
      retentionRules: [
        retentionRuleSchema.parse({
          ...coveringRule,
          appliesTo: { classification: 'CONFIDENTIAL' },
        }),
      ],
      residencyPolicies: [],
      now: NOW,
      ownershipConcentrationLimit: 50,
    });

    const finding = assessment.findings.find((entry) => entry.kind === 'ownership_concentration');
    expect(finding?.message).toContain('ownership is nominal');
    // A warning, not a breach: it is a staffing fact.
    expect(finding?.severity).toBe('warning');
  });

  it('counts entries by classification for the forum’s first slide', () => {
    const assessment = assess({
      catalog: new DataCatalog([entry()]),
      retentionRules: [coveringRule],
      residencyPolicies: [residency],
      now: NOW,
    });

    expect(assessment.byClassification.CONFIDENTIAL).toBe(1);
    expect(assessment.entriesAssessed).toBe(1);
  });
});

describe('residency', () => {
  it('refuses a policy permitting no region', () => {
    expect(() => residencyPolicySchema.parse({ ...residency, permittedRegions: [] })).toThrow(
      /should not be collected/,
    );
  });

  it('validates a placement rather than performing one', () => {
    // A hook: this framework does not place data and will not pretend to.
    const result = validatePlacement({
      entry: entry(),
      region: 'eu-west-1',
      policies: [residency],
    });

    expect(result.permitted).toBe(false);
    expect(result.reasons.join(' ')).toContain('Local data-protection law');
  });

  it('refuses cross-region replication for a classification that forbids it', () => {
    const result = validatePlacement({
      entry: entry({ classification: 'RESTRICTED', personalData: false }),
      region: 'eu-west-1',
      policies: [],
    });

    expect(result.permitted).toBe(false);
  });

  it('permits a placement in the entry’s own region', () => {
    expect(
      validatePlacement({ entry: entry(), region: 'ap-southeast-1', policies: [residency] })
        .permitted,
    ).toBe(true);
  });
});

describe('gating on the assessment', () => {
  it('refuses while a breach stands', () => {
    const assessment = assess({
      catalog: new DataCatalog([entry({ legalBasis: null })]),
      retentionRules: [coveringRule],
      residencyPolicies: [residency],
      now: NOW,
    });

    expect(() => assertGoverned(assessment)).toThrow(/data-governance breach/);
  });

  it('permits when only warnings stand', () => {
    const assessment = assess({
      catalog: new DataCatalog([entry({ nextReviewDate: '2026-05-01T00:00:00.000Z' })]),
      retentionRules: [coveringRule],
      residencyPolicies: [residency],
      now: NOW,
    });

    expect(assessment.findings.some((finding) => finding.severity === 'warning')).toBe(true);
    expect(() => assertGoverned(assessment)).not.toThrow();
  });
});
