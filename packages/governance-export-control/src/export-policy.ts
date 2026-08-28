import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import type { DataClassification } from '@trustos/governance-tool-core';
import { MaskPolicy } from '@trustos/governance-pii-policy';

/**
 * Export governance.
 *
 * An export is the one operation in the Governance Tool that produces data **outside every
 * control that produced it**. A masked field on a screen is masked; the same field in a CSV on a
 * laptop is a file with no access control, no expiry and no audit of who opened it.
 *
 * So exports are governed as their own thing rather than as "a read that happens to be large":
 *
 *   * a **row ceiling** by classification, because the difference between a report and an
 *     extraction is quantity;
 *   * a **justification** with a floor on its length, because "reporting" is what a free-text
 *     field collects;
 *   * **masking that survives the export**, applied to the rows on the way out;
 *   * **approval** for anything above a threshold or of a restricted classification;
 *   * a **watermark** carrying who exported it and when, so a file that turns up somewhere can
 *     be traced back;
 *   * an **expiry**, because a download link that works forever is a copy that exists forever.
 *
 * The check that catches the real problem is the row ceiling. Every mass-extraction incident
 * looks like a legitimate export with the filters removed.
 */

export const exportPolicySchema = z
  .object({
    classification: z.enum([
      'public',
      'internal',
      'confidential',
      'restricted',
      'highly_restricted',
    ]),
    /** The most rows one export may contain. */
    maxRows: z.number().int().min(1).max(1_000_000),
    /** Above this, a second person approves. */
    approvalAboveRows: z.number().int().min(1).max(1_000_000),
    requiresJustification: z.boolean().default(true),
    /** Whether masked fields stay masked in the file. */
    maskFields: z.boolean().default(true),
    watermark: z.boolean().default(true),
    /** How long the produced file remains downloadable. */
    expiryHours: z.number().int().min(1).max(168),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.approvalAboveRows > policy.maxRows) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalAboveRows'],
        message:
          'The approval threshold is above the row ceiling, so no export ever needs approval. ' +
          'That is a policy that reads as a control and is not one.',
      });
    }

    if (policy.classification === 'highly_restricted' && !policy.maskFields) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maskFields'],
        message: 'A highly-restricted export that unmasks is a bulk reveal with no reveal record.',
      });
    }
  });

export type ExportPolicy = z.infer<typeof exportPolicySchema>;

/**
 * The default policies.
 *
 * The numbers descend sharply with classification, which is the point: a hundred thousand public
 * rows is a report and a hundred thousand restricted rows is an incident. `highly_restricted`
 * tops out at 100 rows and always needs approval — an export of that data is an investigation
 * artefact, not a spreadsheet.
 */
export const DEFAULT_EXPORT_POLICIES: Readonly<Record<DataClassification, ExportPolicy>> =
  Object.freeze({
    public: exportPolicySchema.parse({
      classification: 'public',
      maxRows: 1_000_000,
      approvalAboveRows: 1_000_000,
      requiresJustification: false,
      maskFields: false,
      watermark: false,
      expiryHours: 168,
    }),
    internal: exportPolicySchema.parse({
      classification: 'internal',
      maxRows: 100_000,
      approvalAboveRows: 50_000,
      expiryHours: 72,
    }),
    confidential: exportPolicySchema.parse({
      classification: 'confidential',
      maxRows: 25_000,
      approvalAboveRows: 5_000,
      expiryHours: 24,
    }),
    restricted: exportPolicySchema.parse({
      classification: 'restricted',
      maxRows: 5_000,
      approvalAboveRows: 500,
      expiryHours: 8,
    }),
    highly_restricted: exportPolicySchema.parse({
      classification: 'highly_restricted',
      maxRows: 100,
      approvalAboveRows: 1,
      expiryHours: 4,
    }),
  });

export const exportRequestSchema = z
  .object({
    requestId: z.string().min(1).max(80),
    appId: z.string().min(1).max(80),
    actorId: z.string().min(1).max(80),
    organizationId: z.string().min(1).max(80),
    resourceId: z.string().min(1).max(120),
    classification: z.enum([
      'public',
      'internal',
      'confidential',
      'restricted',
      'highly_restricted',
    ]),
    fields: z.array(z.string().min(1).max(80)).min(1).max(200),
    /** How many rows the query would return. Counted before the export runs, not after. */
    estimatedRows: z.number().int().min(0),
    /** Why. Long enough to be a sentence. */
    justification: z.string().max(1000),
    requestedAt: z.string().datetime(),
    caseRef: z.string().max(120).optional(),
  })
  .strict();

export type ExportRequest = z.infer<typeof exportRequestSchema>;

export interface ExportDecision {
  allowed: boolean;
  requiresApproval: boolean;
  /** Refusals, all of them. A requester who fixes one and resubmits to find a second stops trying. */
  refusals: string[];
  /** Rows the export may contain, after the ceiling is applied. */
  effectiveMaxRows: number;
  maskFields: boolean;
  watermark: string | null;
  expiresAt: Date;
}

export interface EvaluateExportInput {
  request: ExportRequest;
  policy: ExportPolicy;
  /** Whether the actor holds `governance.export.request`. */
  hasPermission: boolean;
  /** Whether an independent approval has been recorded. */
  approved: boolean;
  now: Date;
}

export function evaluateExport(input: EvaluateExportInput): ExportDecision {
  const { request, policy } = input;
  const refusals: string[] = [];

  if (!input.hasPermission) {
    refusals.push('The actor does not hold governance.export.request.');
  }

  if (policy.requiresJustification && request.justification.trim().length < 20) {
    /*
     * Twenty characters, and the floor is the point.
     *
     * "reporting" and "analysis" are what an unbounded justification field collects, and neither
     * answers the question it exists for. Twenty characters is roughly one clause — not a
     * guarantee of meaning, but enough that writing nothing takes effort.
     */
    refusals.push(
      'This export needs a justification of at least twenty characters. "Reporting" does not ' +
        'answer the question the field exists for.',
    );
  }

  if (request.estimatedRows > policy.maxRows) {
    refusals.push(
      `This export would contain ${request.estimatedRows} rows and the ceiling for ` +
        `${request.classification} data is ${policy.maxRows}. Every mass-extraction incident ` +
        'looks like a legitimate export with the filters removed — narrow the query.',
    );
  }

  const requiresApproval = request.estimatedRows >= policy.approvalAboveRows;

  if (requiresApproval && !input.approved) {
    refusals.push(
      `An export of ${request.estimatedRows} rows at this classification needs a second person ` +
        'to approve it.',
    );
  }

  return {
    allowed: refusals.length === 0,
    requiresApproval,
    refusals,
    effectiveMaxRows: Math.min(request.estimatedRows, policy.maxRows),
    maskFields: policy.maskFields,
    watermark: policy.watermark ? watermarkFor(request, input.now) : null,
    expiresAt: new Date(input.now.getTime() + policy.expiryHours * 60 * 60 * 1000),
  };
}

/**
 * The watermark.
 *
 * Actor, organization, request id and instant. Enough to trace a file that turns up somewhere it
 * should not be, and deliberately not a name or an email — a watermark is read by whoever found
 * the file, and that is not necessarily somebody entitled to the exporter's identity. The actor
 * id resolves through the directory, by somebody who is.
 */
export function watermarkFor(request: ExportRequest, now: Date): string {
  return [
    `TrustOS export ${request.requestId}`,
    `actor ${request.actorId}`,
    `org ${request.organizationId}`,
    `at ${now.toISOString()}`,
  ].join(' · ');
}

/**
 * Applies the decision to the rows on the way out.
 *
 * Masking survives the export, which is the property the whole package exists for: a field masked
 * on a screen and unmasked in the CSV is a control that only worked while somebody was looking at
 * it.
 */
export function applyExportPolicy(
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  decision: ExportDecision,
  masking: MaskPolicy,
): Array<Record<string, unknown>> {
  const bounded = rows.slice(0, decision.effectiveMaxRows);
  if (!decision.maskFields) return bounded.map((row) => ({ ...row }));

  return bounded.map((row) => masking.maskRow(row));
}

/** Refuses an export the policy did not allow. */
export function assertExportAllowed(decision: ExportDecision): void {
  if (decision.allowed) return;

  throw new ApiError('forbidden', {
    message: `Export refused: ${decision.refusals.join(' ')}`,
    context: { refusalCount: decision.refusals.length },
  });
}

/** The audit record an export produces. Field names and counts, never contents. */
export function exportAuditDetail(
  request: ExportRequest,
  decision: ExportDecision,
): Record<string, string | number | boolean | null> {
  return {
    requestId: request.requestId,
    appId: request.appId,
    actorId: request.actorId,
    resourceId: request.resourceId,
    classification: request.classification,
    /* Names and a count. An audit record of an export must not contain the export. */
    fields: request.fields.join(','),
    rows: decision.effectiveMaxRows,
    masked: decision.maskFields,
    justification: request.justification,
    caseRef: request.caseRef ?? null,
    expiresAt: decision.expiresAt.toISOString(),
  };
}
