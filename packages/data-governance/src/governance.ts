import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import {
  classificationRank,
  obligationsFor,
  type DataClassificationLevel,
} from '@trustsystem/data-classification';
import type { DataCatalog, CatalogEntry } from '@trustsystem/data-catalog';
import type { RetentionRule } from '@trustsystem/data-retention';

/**
 * Data governance: ownership, residency, and whether any of it is in good standing.
 *
 * The other six packages in this part each do one thing well. This one asks the question a
 * governance forum actually opens with — **what is wrong right now** — and it asks it by
 * computing rather than by collecting reports.
 *
 * That distinction is the package's reason to exist. Every data-governance programme starts with
 * a spreadsheet of owners and classifications, maintained by hand, which is accurate on the day
 * it is written. `assess` derives its findings from the catalog, the retention rules and the
 * residency policy, so a finding appears the moment the thing it describes becomes true.
 *
 * Six findings, and the third is the one that surprises people:
 *
 *   1. An entry with no retention rule covering it.
 *   2. An entry whose review has passed.
 *   3. **An entry whose declared classification is below what it contains** — a table classified
 *      `INTERNAL` whose columns include a national identifier. Tables are classified when created
 *      and columns are added later, which is why this is the commonest error there is.
 *   4. Personal data with no lawful basis recorded.
 *   5. Data outside its permitted residency region.
 *   6. An owner or steward who owns more than a person can meaningfully own.
 */

export const residencyPolicySchema = z
  .object({
    policyId: z.string().regex(/^[a-z][a-z0-9-]{2,79}$/),
    description: z.string().min(10).max(400),
    /** Which regions data of this shape may live in. Empty means none, never all. */
    permittedRegions: z.array(z.string().min(2).max(40)).max(40),
    appliesTo: z
      .object({
        classification: z.string().max(40).optional(),
        country: z.string().max(40).optional(),
        organizationId: z.string().max(80).optional(),
        productId: z.string().max(80).optional(),
        personalData: z.boolean().optional(),
      })
      .strict(),
    legalBasis: z.string().min(5).max(200),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.permittedRegions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permittedRegions'],
        message:
          'A residency policy permitting no region forbids storing the data anywhere. If that is ' +
          'the intent, the data should not be collected.',
      });
    }
  });

export type ResidencyPolicy = z.infer<typeof residencyPolicySchema>;

/**
 * Validates a placement.
 *
 * A **hook**, deliberately, rather than an enforcement point: this framework does not place data
 * and will not pretend to. What it does is refuse a placement a deployment's tooling proposes,
 * which is where the decision is actually made — a Terraform plan, a replication configuration, a
 * new region.
 */
export function validatePlacement(input: {
  entry: CatalogEntry;
  region: string;
  policies: readonly ResidencyPolicy[];
}): { permitted: boolean; reasons: string[] } {
  const reasons: string[] = [];

  const applicable = input.policies.filter((policy) => {
    const selector = policy.appliesTo;

    if (selector.classification && selector.classification !== input.entry.classification)
      return false;
    if (selector.organizationId && selector.organizationId !== undefined) {
      /* An entry is schema-level; an organization-scoped policy does not narrow it. */
    }
    if (selector.personalData !== undefined && selector.personalData !== input.entry.personalData) {
      return false;
    }

    return true;
  });

  for (const policy of applicable) {
    if (policy.permittedRegions.includes(input.region)) continue;

    reasons.push(
      `"${policy.policyId}" permits ${policy.permittedRegions.join(', ')} and this placement is ` +
        `${input.region}. Basis: ${policy.legalBasis}.`,
    );
  }

  if (
    !obligationsFor(input.entry.classification).crossRegionPermitted &&
    input.region !== input.entry.residencyRegion
  ) {
    reasons.push(
      `${input.entry.classification} data may not be replicated outside ${input.entry.residencyRegion}.`,
    );
  }

  return { permitted: reasons.length === 0, reasons };
}

export const GOVERNANCE_FINDING_KINDS = [
  'no_retention_rule',
  'review_overdue',
  'classification_below_content',
  'personal_data_no_basis',
  'residency_violation',
  'ownership_concentration',
] as const;

export type GovernanceFindingKind = (typeof GOVERNANCE_FINDING_KINDS)[number];

export interface GovernanceFinding {
  kind: GovernanceFindingKind;
  severity: 'info' | 'warning' | 'breach';
  entryId: string;
  message: string;
  remediation: string;
}

export interface GovernanceAssessment {
  findings: GovernanceFinding[];
  /** True when nothing is a breach. Warnings are normal and do not block. */
  healthy: boolean;
  /** Counts by classification, for the forum's first slide. */
  byClassification: Record<string, number>;
  entriesAssessed: number;
}

export interface AssessInput {
  catalog: DataCatalog;
  retentionRules: readonly RetentionRule[];
  residencyPolicies: readonly ResidencyPolicy[];
  now: Date;
  /** Above this many entries owned by one person, ownership is nominal. */
  ownershipConcentrationLimit?: number;
}

export function assess(input: AssessInput): GovernanceAssessment {
  const findings: GovernanceFinding[] = [];
  const entries = input.catalog.all();
  const byClassification: Record<string, number> = {};
  const ownedBy = new Map<string, number>();

  for (const entry of entries) {
    byClassification[entry.classification] = (byClassification[entry.classification] ?? 0) + 1;
    ownedBy.set(entry.owner, (ownedBy.get(entry.owner) ?? 0) + 1);

    const actual = input.catalog.inheritedClassification(entry.entryId);

    if (classificationRank(actual) > classificationRank(entry.classification)) {
      findings.push({
        kind: 'classification_below_content',
        severity: 'breach',
        entryId: entry.entryId,
        message:
          `Declared ${entry.classification}; contains ${actual}. Tables are classified when they ` +
          'are created and columns are added later, which is why this is the commonest error ' +
          'there is — and every downstream control is currently the wrong one.',
        remediation: `Reclassify to ${actual}, or move the offending column out.`,
      });
    }

    if (new Date(entry.nextReviewDate) < input.now) {
      const overdueDays = Math.floor(
        (input.now.getTime() - new Date(entry.nextReviewDate).getTime()) / 86_400_000,
      );

      findings.push({
        kind: 'review_overdue',
        severity: overdueDays > 180 ? 'breach' : 'warning',
        entryId: entry.entryId,
        message: `The review passed ${overdueDays} days ago.`,
        remediation: 'Confirm the classification, the owner and the purpose are still right.',
      });
    }

    if (entry.personalData && entry.legalBasis === null) {
      findings.push({
        kind: 'personal_data_no_basis',
        severity: 'breach',
        entryId: entry.entryId,
        message:
          'Personal data with no lawful basis recorded. "Why are we allowed to hold this" is the ' +
          'first question of every data-protection conversation.',
        remediation: 'Record the basis, or stop collecting it.',
      });
    }

    const covered = input.retentionRules.some((rule) => coversEntry(rule, entry));

    if (!covered) {
      findings.push({
        kind: 'no_retention_rule',
        severity: entry.personalData ? 'breach' : 'warning',
        entryId: entry.entryId,
        message:
          'No retention rule covers this entry, so it defaults to the classification’s period ' +
          'and nobody chose that.',
        remediation: 'Write a rule naming the obligation and the period it implements.',
      });
    }

    const placement = validatePlacement({
      entry,
      region: entry.residencyRegion,
      policies: input.residencyPolicies,
    });

    if (!placement.permitted) {
      findings.push({
        kind: 'residency_violation',
        severity: 'breach',
        entryId: entry.entryId,
        message: placement.reasons.join(' '),
        remediation: 'Move the data, or change the policy through the process that owns it.',
      });
    }
  }

  const limit = input.ownershipConcentrationLimit ?? 50;

  for (const [owner, count] of ownedBy) {
    if (count <= limit) continue;

    findings.push({
      kind: 'ownership_concentration',
      severity: 'warning',
      entryId: `owner:${owner}`,
      message:
        `${owner} owns ${count} catalog entries. Above roughly ${limit}, ownership is nominal — ` +
        'nobody reviews that many, and the name in the field stops meaning anybody is looking.',
      remediation: 'Distribute ownership by business domain.',
    });
  }

  return {
    findings,
    healthy: !findings.some((finding) => finding.severity === 'breach'),
    byClassification,
    entriesAssessed: entries.length,
  };
}

function coversEntry(rule: RetentionRule, entry: CatalogEntry): boolean {
  const selector = rule.appliesTo;

  if (selector.classification && selector.classification !== entry.classification) return false;
  if (selector.personalData !== undefined && selector.personalData !== entry.personalData)
    return false;

  return true;
}

/** Refuses an operation while a breach stands. Called before a promotion or a release. */
export function assertGoverned(assessment: GovernanceAssessment): void {
  const breaches = assessment.findings.filter((finding) => finding.severity === 'breach');

  if (breaches.length === 0) return;

  throw new ApiError('forbidden', {
    message:
      `${breaches.length} data-governance breach(es): ` +
      breaches
        .slice(0, 5)
        .map((finding) => `${finding.entryId} — ${finding.kind}`)
        .join('; '),
    context: { breachCount: breaches.length },
  });
}

export type { DataClassificationLevel };
