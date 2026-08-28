import { z } from 'zod';

/**
 * Compliance extension points.
 *
 * As with risk: **no regulator-specific implementation**, and for a stronger reason. A KYC rule
 * that is right in Cambodia is wrong in Singapore, the thresholds change by regulation rather than
 * by release, and a framework that encoded one jurisdiction's rules would encode them for
 * everybody. Worse, a deployment would believe it was compliant.
 *
 * What is here is the shape of the questions the platform needs answered before money moves, and
 * a place to record the answer. Everything that decides is a port.
 */

export const KYC_LEVELS = [
  /** Nothing verified. Usually read-only. */
  'none',
  /** Identity claimed and not verified. */
  'basic',
  /** Identity documents verified. The normal level for a retail customer. */
  'verified',
  /** Enhanced due diligence completed. For higher limits or higher-risk customers. */
  'enhanced',
] as const;

export type KycLevel = (typeof KYC_LEVELS)[number];

export const kycStatusSchema = z
  .object({
    subjectId: z.string().min(1).max(120),
    subjectType: z.string().max(60).default('user'),
    organizationId: z.string().nullable(),

    level: z.enum(KYC_LEVELS),

    /** Which provider verified it, and when. Both needed for an audit. */
    verifiedBy: z.string().max(120).nullable().default(null),
    verifiedAt: z.coerce.date().nullable().default(null),

    /**
     * When the verification lapses.
     *
     * Not nullable in practice for anything above `basic`: verification ages, and a platform whose
     * KYC never expires is a platform whose customer records are as accurate as the day they
     * joined.
     */
    expiresAt: z.coerce.date().nullable().default(null),

    /** For an enhanced review: why it was needed and what was found. */
    notes: z.string().max(2000).nullable().default(null),

    /** Whether the subject is a politically exposed person. Recorded, never inferred here. */
    pep: z.boolean().default(false),
    /** Whether a sanctions screen has matched. */
    sanctioned: z.boolean().default(false),

    updatedAt: z.coerce.date(),
  })
  .strict();

export type KycStatus = z.infer<typeof kycStatusSchema>;

/** Whether a KYC status is currently good, and why not when it is not. */
export function kycSatisfies(
  status: KycStatus | null,
  required: KycLevel,
  at: Date,
): { ok: true } | { ok: false; reason: string } {
  const order = KYC_LEVELS.indexOf(required);

  if (order === 0) return { ok: true };

  if (!status) {
    return { ok: false, reason: `No KYC record, and ${required} verification is required.` };
  }

  if (status.sanctioned) {
    return { ok: false, reason: 'The subject is flagged as sanctioned.' };
  }

  if (KYC_LEVELS.indexOf(status.level) < order) {
    return {
      ok: false,
      reason: `Verified to ${status.level} and ${required} is required.`,
    };
  }

  if (status.expiresAt && status.expiresAt <= at) {
    /*
     * Expired verification is not verification.
     *
     * Treating it as valid is the quiet failure: the record says "verified", the date says two
     * years ago, and nothing in the system notices until an examiner does.
     */
    return {
      ok: false,
      reason: `Verification expired at ${status.expiresAt.toISOString()}.`,
    };
  }

  return { ok: true };
}

/** The KYC provider seam. The framework ships none. */
export interface KycProvider {
  readonly name: string;
  status(input: { organizationId: string | null; subjectId: string }): Promise<KycStatus | null>;
}

/**
 * The travel rule seam.
 *
 * The originator and beneficiary information that must accompany a transfer above a threshold.
 * The threshold, the fields and which transfers it applies to are all jurisdictional, so the
 * framework asks the question and records the answer.
 */
export const travelRuleRecordSchema = z
  .object({
    transactionId: z.string().min(1).max(120),
    organizationId: z.string().nullable(),

    originatorName: z.string().max(200),
    originatorAccount: z.string().max(200),
    originatorAddress: z.string().max(500).nullable().default(null),

    beneficiaryName: z.string().max(200),
    beneficiaryAccount: z.string().max(200),
    beneficiaryAddress: z.string().max(500).nullable().default(null),

    /** Which rule required this, so a record can be explained years later. */
    ruleReference: z.string().max(200).nullable().default(null),

    recordedAt: z.coerce.date(),
  })
  .strict();

export type TravelRuleRecord = z.infer<typeof travelRuleRecordSchema>;

/**
 * A suspicious activity review.
 *
 * The record, not the detection. What was flagged, who looked, what they decided — which is what a
 * regulator asks for, and what a detection engine alone does not produce.
 */
export const SAR_STATUSES = ['open', 'investigating', 'reported', 'dismissed'] as const;
export type SarStatus = (typeof SAR_STATUSES)[number];

export const suspiciousActivitySchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),

    subjectId: z.string().max(120),
    transactionIds: z.array(z.string().max(120)).max(500).default([]),

    /** What triggered it. A rule name, a provider, or a person. */
    trigger: z.string().min(1).max(200),
    summary: z.string().min(1).max(4000),

    status: z.enum(SAR_STATUSES).default('open'),

    assignedTo: z.string().max(64).nullable().default(null),
    /** The reviewer's conclusion. Required to leave `investigating`. */
    conclusion: z.string().max(4000).nullable().default(null),
    /** Where it was reported, when it was. */
    reportedTo: z.string().max(200).nullable().default(null),
    reportedAt: z.coerce.date().nullable().default(null),

    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .strict();

export type SuspiciousActivity = z.infer<typeof suspiciousActivitySchema>;

/**
 * The regulatory export seam.
 *
 * A regulator wants a file in a format they specify, on a schedule they set. The framework
 * provides the query and the shape; the format belongs to whoever is filing.
 */
export interface RegulatoryExporter {
  readonly name: string;
  /** What this exporter produces, for an operator choosing between several. */
  readonly description: string;
  export(input: {
    organizationId: string | null;
    from: Date;
    to: Date;
  }): Promise<{ contentType: string; filename: string; body: string | Uint8Array }>;
}

/**
 * The compliance hooks the platform calls, all optional.
 *
 * An application wires the ones its jurisdiction needs. A hook that is not wired is a check that
 * did not happen, and `describeCoverage` says so rather than letting an empty configuration look
 * like a clean one.
 */
export interface ComplianceHooks {
  kyc?: KycProvider;
  travelRule?: {
    /** Whether this transfer needs originator and beneficiary information. */
    applies(input: {
      organizationId: string | null;
      amount: unknown;
      type: string;
    }): Promise<boolean>;
    record(record: TravelRuleRecord): Promise<void>;
  };
  suspiciousActivity?: {
    raise(
      input: Omit<SuspiciousActivity, 'id' | 'createdAt' | 'updatedAt'>,
    ): Promise<SuspiciousActivity>;
  };
  exporters?: RegulatoryExporter[];
}

/**
 * What is actually wired, in words.
 *
 * For `trustos financial doctor` and for a compliance officer asking what the platform checks. An
 * empty configuration reports as empty rather than as clean — the difference matters, because
 * "nothing was flagged" and "nothing was checked" look identical on a dashboard.
 */
export function describeCoverage(hooks: ComplianceHooks): string[] {
  const lines: string[] = [];

  lines.push(hooks.kyc ? `KYC: ${hooks.kyc.name}` : 'KYC: not wired — no verification is checked.');

  lines.push(
    hooks.travelRule
      ? 'Travel rule: wired.'
      : 'Travel rule: not wired — no originator or beneficiary information is collected.',
  );

  lines.push(
    hooks.suspiciousActivity
      ? 'Suspicious activity: wired.'
      : 'Suspicious activity: not wired — nothing can be raised for review.',
  );

  lines.push(
    hooks.exporters && hooks.exporters.length > 0
      ? `Regulatory export: ${hooks.exporters.map((exporter) => exporter.name).join(', ')}.`
      : 'Regulatory export: none configured.',
  );

  return lines;
}
