import { z } from 'zod';
import { isSameActor } from '@trustos/workflow-core';
import {
  PRODUCT_AUDIT_ACTIONS,
  newProductId,
  productError,
  type ProductAuditRecord,
  type ProductAuditRecorder,
} from '@trustos/financial-product-core';
import type { ChangeClassification } from './change-classification';

/**
 * Maker-checker for product changes.
 *
 * The approval *models* are `@trustos/workflow-approvals`' — six of them, all pure functions of
 * the decision trail, and this package does not restate any of them. What it adds is the part
 * specific to products: which approval **levels** a change needs, derived from what changed
 * rather than declared by whoever is submitting it.
 *
 * Progress is derived from the decisions, never tracked alongside them. That is the same choice
 * `@trustos/workflow-approvals` makes and for the same reason: a counter that increments per
 * approval is the design that produces "the record says two of three and only one decision
 * exists". Recomputing from the trail means the trail is the truth, and the trail is what an
 * auditor reads.
 *
 * Two refusals live here rather than in a policy, because they need the decision list and a
 * policy would have to be handed one it could silently be handed empty:
 *
 *   * **The maker cannot decide.** Checked against the recorded author, not a submitted field.
 *   * **Nobody decides twice.** Without this, a two-of-three requirement is satisfiable by one
 *     person clicking twice — which passes every count-based check, because the count is right.
 */

export const productDecisionSchema = z
  .object({
    decisionId: z.string().min(1).max(80),
    productId: z.string().min(1).max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    organizationId: z.string().min(1).max(80).nullable(),
    /** The approval level this decision satisfies. A reference code. */
    level: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
    actorId: z.string().min(1).max(80),
    decision: z.enum(['approved', 'rejected']),
    /** Required for a rejection. An approval may stand on its own; a refusal owes an explanation. */
    reason: z.string().max(1000).optional(),
    decidedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (decision.decision === 'rejected' && (decision.reason ?? '').trim().length < 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message:
          'A rejection needs a reason. "No" sends the product owner back to guess, and they ' +
          'guess wrong and resubmit, which is how a two-day review becomes a two-week one.',
      });
    }
  });

export type ProductDecision = z.infer<typeof productDecisionSchema>;

export interface ApprovalState {
  /** Every decision recorded against this version, in order. */
  decisions: ProductDecision[];
  /** Levels satisfied by an approval. */
  approvedLevels: string[];
  /** Levels still outstanding. */
  outstandingLevels: string[];
  /** True when every required level has an approval and nothing has been rejected. */
  complete: boolean;
  /** The rejection, when one exists. A single rejection settles it. */
  rejected: ProductDecision | null;
  /** How many distinct people have decided. Never a count of decisions. */
  distinctDeciders: number;
}

/**
 * Derives approval state from the trail.
 *
 * A rejection settles the matter regardless of how many approvals preceded it. That is the right
 * default for a financial product: "three approved and one refused" is not a product that ships,
 * and a model that let approvals outvote a refusal would make the compliance officer's veto a
 * suggestion.
 */
export function deriveApprovalState(
  classification: ChangeClassification,
  decisions: readonly ProductDecision[],
): ApprovalState {
  const ordered = [...decisions].sort((left, right) =>
    left.decidedAt.localeCompare(right.decidedAt),
  );

  const rejected = ordered.find((decision) => decision.decision === 'rejected') ?? null;

  const approvedLevels = [
    ...new Set(
      ordered
        .filter((decision) => decision.decision === 'approved')
        .map((decision) => decision.level),
    ),
  ].sort();

  const outstandingLevels = classification.requiredApprovalLevels.filter(
    (level) => !approvedLevels.includes(level),
  );

  return {
    decisions: ordered,
    approvedLevels,
    outstandingLevels,
    complete: rejected === null && outstandingLevels.length === 0,
    rejected,
    distinctDeciders: new Set(ordered.map((decision) => decision.actorId)).size,
  };
}

export interface RecordDecisionInput {
  classification: ChangeClassification;
  existing: readonly ProductDecision[];
  productId: string;
  version: string;
  organizationId: string | null;
  /** Who composed this version. Loaded server-side. */
  authoredById: string;
  actorId: string;
  level: string;
  decision: 'approved' | 'rejected';
  reason?: string;
  now: Date;
}

/**
 * Records a decision, refusing the two ways maker-checker is defeated.
 *
 * Returns the decision and the new state rather than mutating anything: persistence belongs to
 * the registry, and a function that both decided and wrote would be a function the registry could
 * not call inside its own transaction.
 */
export function recordDecision(input: RecordDecisionInput): {
  decision: ProductDecision;
  state: ApprovalState;
} {
  if (isSameActor(input.actorId, input.authoredById)) {
    throw productError(
      'product_self_approval_refused',
      'The actor composed this version and may not decide it. A maker who can approve their own ' +
        'product is not a control; it is a log entry that looks like one.',
      { productId: input.productId, version: input.version },
    );
  }

  if (input.existing.some((decision) => isSameActor(decision.actorId, input.actorId))) {
    throw productError(
      'product_approval_required',
      'The actor has already recorded a decision on this version. Two decisions from one person ' +
        'satisfies a two-of-three requirement with one person.',
      { productId: input.productId, version: input.version },
    );
  }

  if (!input.classification.requiredApprovalLevels.includes(input.level)) {
    throw productError(
      'product_approval_required',
      `This change does not require approval at level "${input.level}". Required: ` +
        `${input.classification.requiredApprovalLevels.join(', ') || 'none'}. Recording an ` +
        'unrequired approval would look like progress and satisfy nothing.',
      {
        productId: input.productId,
        version: input.version,
        expected: input.classification.requiredApprovalLevels.join(', '),
        actual: input.level,
      },
    );
  }

  const decision = productDecisionSchema.parse({
    decisionId: newProductId('approval'),
    productId: input.productId,
    version: input.version,
    organizationId: input.organizationId,
    level: input.level,
    actorId: input.actorId,
    decision: input.decision,
    ...(input.reason ? { reason: input.reason } : {}),
    decidedAt: input.now.toISOString(),
  });

  return {
    decision,
    state: deriveApprovalState(input.classification, [...input.existing, decision]),
  };
}

/** Refuses a publication that the recorded decisions do not support. */
export function assertApprovalComplete(
  state: ApprovalState,
  productId: string,
  version: string,
): void {
  if (state.rejected) {
    throw productError(
      'product_approval_required',
      `Version ${version} was rejected by ${state.rejected.level}: ${state.rejected.reason ?? 'no reason recorded'}`,
      { productId, version },
    );
  }

  if (!state.complete) {
    throw productError(
      'product_approval_required',
      `Version ${version} is missing approval from: ${state.outstandingLevels.join(', ')}.`,
      { productId, version, expected: state.outstandingLevels.join(', ') },
    );
  }
}

/**
 * Writes the audit record for a governance action.
 *
 * One function rather than a call at every site, because a caller who records the state change
 * and forgets the audit produces a complete history and an audit trail with a hole in it —
 * discovered during an audit rather than in a test. The registry calls this in the same step it
 * writes the state.
 */
export async function auditGovernanceAction(
  recorder: ProductAuditRecorder,
  entry: {
    action: (typeof PRODUCT_AUDIT_ACTIONS)[keyof typeof PRODUCT_AUDIT_ACTIONS];
    productId: string;
    version: string | null;
    organizationId: string | null;
    actorId: string;
    outcome: ProductAuditRecord['outcome'];
    detail?: Record<string, string | number | boolean | null>;
    now: Date;
  },
): Promise<void> {
  await recorder.record({
    action: entry.action,
    occurredAt: entry.now,
    organizationId: entry.organizationId,
    actorId: entry.actorId,
    productId: entry.productId,
    productVersion: entry.version,
    entityId: entry.version ? `${entry.productId}@${entry.version}` : entry.productId,
    entityType: 'FinancialProduct',
    outcome: entry.outcome,
    detail: entry.detail ?? {},
  });
}
