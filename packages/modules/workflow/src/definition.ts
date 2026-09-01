import { ApiError } from '@trustsystem/errors';
import { z } from 'zod';

/**
 * Workflow definitions.
 *
 * A definition is a list of approval steps, in order. There is no branching, no
 * parallel split and no expression language — see the module's out-of-scope list.
 * What is here instead is the rule that makes an approval chain worth having:
 * separation of duties.
 *
 * `allowSubmitterApproval` defaults to **false** and every guard in the service
 * enforces it. A workflow whose submitter can approve their own request is not a
 * control; it is a log entry that looks like one.
 */

export const approvalStepSchema = z
  .object({
    /** 1-based position. Steps must be contiguous from 1. */
    order: z.number().int().min(1).max(20),
    name: z.string().trim().min(1).max(120),
    /**
     * Permission an approver must hold to act on this step.
     *
     * Assignment is by permission rather than by user id: a workflow that names
     * individuals stops working the first time someone leaves, and the framework
     * already has a permission system that knows who holds what.
     */
    approverPermission: z.string().trim().min(3).max(120),
    /** Distinct approvers required before the step completes. */
    requiredApprovals: z.number().int().min(1).max(10).default(1),
    /** Minutes before the step breaches its SLA. Null uses the module default. */
    slaMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 30)
      .nullable()
      .default(null),
    /** Deliberate, audited exception to separation of duties. */
    allowSubmitterApproval: z.boolean().default(false),
  })
  .strict();

export type ApprovalStep = z.infer<typeof approvalStepSchema>;

export const workflowDefinitionSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, 'Lowercase, dot, underscore or hyphen.'),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(600).default(''),
    steps: z.array(approvalStepSchema).min(1).max(20),
  })
  .strict();

export type WorkflowDefinitionInput = z.infer<typeof workflowDefinitionSchema>;

/**
 * Checks the step list is well formed.
 *
 * Contiguity matters: the service advances by incrementing the step order, so a
 * definition with steps 1 and 3 would stall at 2 with no task and no error —
 * a workflow that silently never completes.
 */
export function assertStepsWellFormed(steps: ApprovalStep[]): void {
  const orders = steps.map((step) => step.order).sort((left, right) => left - right);
  const problems: Array<{ path: string; message: string }> = [];

  orders.forEach((order, index) => {
    if (order !== index + 1) {
      problems.push({ path: `steps.${index}.order`, message: 'Steps must be numbered 1..n.' });
    }
  });

  if (new Set(orders).size !== orders.length) {
    problems.push({ path: 'steps', message: 'Two steps share an order.' });
  }

  if (problems.length > 0) {
    throw ApiError.validation(problems, 'The workflow definition is not valid.');
  }
}

export function stepAt(steps: ApprovalStep[], order: number): ApprovalStep | undefined {
  return steps.find((step) => step.order === order);
}

/**
 * The maker-checker definition.
 *
 * Included because it is the shape almost every regulated workflow starts from:
 * one person submits, a different person with a specific permission approves, and
 * the second person cannot be the first. Provided as a function rather than a
 * constant so a product names its own permission.
 */
export function makerCheckerDefinition(options: {
  key: string;
  name: string;
  checkerPermission: string;
  slaMinutes?: number;
  description?: string;
}): WorkflowDefinitionInput {
  return workflowDefinitionSchema.parse({
    key: options.key,
    name: options.name,
    description:
      options.description ??
      'Maker-checker: the submitter cannot approve their own request. One independent approval completes it.',
    steps: [
      {
        order: 1,
        name: 'Checker approval',
        approverPermission: options.checkerPermission,
        requiredApprovals: 1,
        slaMinutes: options.slaMinutes ?? 240,
        // The point of the pattern. Never set this to true on a maker-checker
        // step: it would leave the audit trail claiming an independent review
        // that did not happen.
        allowSubmitterApproval: false,
      },
    ],
  });
}

/**
 * A two-stage variant, for amounts above a threshold.
 *
 * Shown so the shape of a multi-step definition is in the module rather than only
 * in the documentation.
 */
export function dualApprovalDefinition(options: {
  key: string;
  name: string;
  firstPermission: string;
  secondPermission: string;
}): WorkflowDefinitionInput {
  return workflowDefinitionSchema.parse({
    key: options.key,
    name: options.name,
    description: 'Two independent approvals, by holders of different permissions.',
    steps: [
      {
        order: 1,
        name: 'First approval',
        approverPermission: options.firstPermission,
        requiredApprovals: 1,
        slaMinutes: 240,
        allowSubmitterApproval: false,
      },
      {
        order: 2,
        name: 'Second approval',
        approverPermission: options.secondPermission,
        requiredApprovals: 1,
        slaMinutes: 480,
        allowSubmitterApproval: false,
      },
    ],
  });
}
