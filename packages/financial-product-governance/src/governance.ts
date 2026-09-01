import { z } from 'zod';
import { productError, type ProductDefinition } from '@trustsystem/financial-product-core';

/**
 * Product governance metadata, and whether it is in good standing.
 *
 * Section 19 of the reference architecture asks that every financial product have a business
 * owner, a technical owner, a risk owner, a compliance classification, a data classification, a
 * lifecycle, an effective date and a review date. All of those live on the definition itself,
 * because governance metadata stored beside a product is governance metadata that goes missing
 * when the product is copied.
 *
 * What this file adds is the part a schema cannot express: whether the governance is *current*.
 * A product with a review date eighteen months in the past has all its fields populated and none
 * of them meaningful, and the schema is perfectly happy. `assessGovernance` is what turns that
 * into a finding somebody sees.
 */

export const GOVERNANCE_SEVERITIES = ['ok', 'due_soon', 'overdue', 'breach'] as const;
export type GovernanceSeverity = (typeof GOVERNANCE_SEVERITIES)[number];

export interface GovernanceFinding {
  severity: GovernanceSeverity;
  area: 'ownership' | 'review' | 'classification' | 'exposure' | 'retention';
  message: string;
  remediation: string;
}

export interface GovernanceAssessment {
  productId: string;
  version: string;
  findings: GovernanceFinding[];
  /** True when nothing is overdue or breached. `due_soon` is still healthy. */
  healthy: boolean;
  /** Days until the review date. Negative when it has passed. */
  daysUntilReview: number;
}

export interface AssessGovernanceOptions {
  /** How far ahead a review counts as due soon. Thirty days by default. */
  dueSoonDays?: number;
  /** The longest a product may go between reviews. Refused above this at composition time. */
  maximumReviewIntervalDays?: number;
}

export function assessGovernance(
  definition: ProductDefinition,
  now: Date,
  options: AssessGovernanceOptions = {},
): GovernanceAssessment {
  const dueSoonDays = options.dueSoonDays ?? 30;
  const maximumIntervalDays = options.maximumReviewIntervalDays ?? 365;

  const findings: GovernanceFinding[] = [];
  const reviewDate = new Date(definition.reviewDate);
  const effectiveDate = new Date(definition.effectiveDate);

  const daysUntilReview = Math.floor((reviewDate.getTime() - now.getTime()) / 86_400_000);

  if (daysUntilReview < 0) {
    findings.push({
      severity: daysUntilReview < -90 ? 'breach' : 'overdue',
      area: 'review',
      message:
        `The review date passed ${Math.abs(daysUntilReview)} days ago. Every field of this ` +
        'product’s governance is populated and none of it has been confirmed since.',
      remediation: 'Review the product and publish a new version with a fresh review date.',
    });
  } else if (daysUntilReview <= dueSoonDays) {
    findings.push({
      severity: 'due_soon',
      area: 'review',
      message: `The review is due in ${daysUntilReview} days.`,
      remediation: 'Schedule the review before the date passes.',
    });
  }

  const intervalDays = Math.floor((reviewDate.getTime() - effectiveDate.getTime()) / 86_400_000);
  if (intervalDays > maximumIntervalDays) {
    findings.push({
      severity: 'overdue',
      area: 'review',
      message:
        `The review interval is ${intervalDays} days. A product reviewed less often than once a ` +
        'year is a product whose risk assessment predates its current volume.',
      remediation: `Set a review date within ${maximumIntervalDays} days of the effective date.`,
    });
  }

  /*
   * Four distinct owners, or fewer people accountable than the form suggests.
   *
   * One person holding every role is legitimate in a small deployment and is worth *saying*
   * rather than hiding — the finding is `due_soon` rather than `overdue` because it is a
   * staffing fact, not a failure. What it prevents is the org chart that says four names while
   * one person signs everything.
   */
  const owners = new Set(Object.values(definition.ownership));
  if (owners.size < Object.keys(definition.ownership).length) {
    findings.push({
      severity: 'due_soon',
      area: 'ownership',
      message:
        `${owners.size} distinct people hold ${Object.keys(definition.ownership).length} owner ` +
        'roles on this product. The approval trail will show fewer independent parties than the ' +
        'governance model implies.',
      remediation:
        'Assign the risk and compliance owner roles to people independent of the product owner.',
    });
  }

  if (
    definition.apiExposurePolicy.exposed &&
    definition.compliancePolicy.dataClassification === 'restricted'
  ) {
    findings.push({
      severity: 'breach',
      area: 'exposure',
      message:
        'A product classified `restricted` is exposed over a public API. The classification says ' +
        'the data needs a named recipient; an API says anybody with a credential.',
      remediation:
        'Reclassify the product, or withdraw the API exposure and serve it through an internal ' +
        'channel with its own review.',
    });
  }

  if (definition.auditClassification === 'standard' && definition.productType === 'lending') {
    findings.push({
      severity: 'overdue',
      area: 'classification',
      message:
        'A lending product classified `standard` for audit records less than a credit decision ' +
        'needs. Somebody will be asked to reconstruct why an application was declined.',
      remediation: 'Set the audit classification to `sensitive` or `restricted`.',
    });
  }

  if (definition.compliancePolicy.retentionDays < 365) {
    findings.push({
      severity: 'overdue',
      area: 'retention',
      message:
        `A retention of ${definition.compliancePolicy.retentionDays} days is shorter than the ` +
        'window in which most disputes arrive.',
      remediation: 'Set retention to the longer of the regulatory minimum and the dispute window.',
    });
  }

  return {
    productId: definition.productId,
    version: definition.version,
    findings,
    healthy: !findings.some(
      (finding) => finding.severity === 'overdue' || finding.severity === 'breach',
    ),
    daysUntilReview,
  };
}

/** Refuses a product whose governance is not in good standing. Called before activation. */
export function assertGovernanceHealthy(assessment: GovernanceAssessment): void {
  const blocking = assessment.findings.filter(
    (finding) => finding.severity === 'overdue' || finding.severity === 'breach',
  );

  if (blocking.length === 0) return;

  throw productError(
    'product_approval_required',
    `Governance is not in good standing for ${assessment.productId}@${assessment.version}: ` +
      `${blocking.map((finding) => finding.message).join(' ')}`,
    { productId: assessment.productId, version: assessment.version },
  );
}

/** The catalog entry a governance review reads. Section 19, as data. */
export const governanceEntrySchema = z
  .object({
    productId: z.string().min(1).max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    businessOwner: z.string().min(1).max(80),
    technicalOwner: z.string().min(1).max(80),
    riskOwner: z.string().min(1).max(80),
    complianceOwner: z.string().min(1).max(80),
    dataClassification: z.enum(['public', 'internal', 'confidential', 'restricted']),
    auditClassification: z.enum(['standard', 'sensitive', 'restricted']),
    lifecycleStatus: z.string().min(1).max(40),
    effectiveDate: z.string().datetime(),
    reviewDate: z.string().datetime(),
    lastReviewedAt: z.string().datetime().nullable(),
  })
  .strict();

export type GovernanceEntry = z.infer<typeof governanceEntrySchema>;

export function governanceEntry(
  definition: ProductDefinition,
  lastReviewedAt: string | null,
): GovernanceEntry {
  return governanceEntrySchema.parse({
    productId: definition.productId,
    version: definition.version,
    ...definition.ownership,
    dataClassification: definition.compliancePolicy.dataClassification,
    auditClassification: definition.auditClassification,
    lifecycleStatus: definition.lifecycleStatus,
    effectiveDate: definition.effectiveDate,
    reviewDate: definition.reviewDate,
    lastReviewedAt,
  });
}
