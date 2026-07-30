import { z } from 'zod';
import { conditionSchema } from './conditions';

/**
 * The workflow definition document.
 *
 * A typed JSON (or YAML) document that an administrator writes and the runtime
 * executes. It is the whole contract between "what somebody configured" and "what
 * the engine does", so it is `.strict()` at every level: an unrecognised key is a
 * typo, and a typo that is silently ignored is a control the author believes exists.
 *
 * `slaMinutes` in a definition and `escalateAfterMinutes` are minutes rather than
 * seconds because the audience is people writing configuration by hand. Everything
 * internal is seconds; the conversion happens once, here at the boundary.
 */

const identifierSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(
    /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/,
    'Lowercase letters, digits, dot, underscore or hyphen; must start with a letter.',
  );

/**
 * A state name.
 *
 * Same character set as an identifier, so a state is safe in a URL, a metric label
 * and a database index without escaping. Uppercase and spaces are excluded because
 * `Pending Approval`, `pending_approval` and `PendingApproval` would otherwise be
 * three states that look like one.
 */
const stateSchema = identifierSchema;

export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// --- assignment ------------------------------------------------------------

export const ASSIGNMENT_STRATEGIES = [
  'named_user',
  'role',
  'group',
  'round_robin',
  /* Declared, resolved through `AssigneeResolver`; the framework ships no implementation. */
  'organizational_unit',
  'least_loaded',
  'requester_manager',
  'resource_owner',
  'external_resolver',
] as const;

export type AssignmentStrategy = (typeof ASSIGNMENT_STRATEGIES)[number];

/**
 * Strategies the framework resolves itself.
 *
 * The rest are declarable and need an application-supplied `AssigneeResolver`. A
 * definition that names one without a resolver registered fails validation, so the
 * failure is at publish time rather than at the first instance.
 */
export const BUILT_IN_ASSIGNMENT_STRATEGIES: readonly AssignmentStrategy[] = [
  'named_user',
  'role',
  'group',
  'round_robin',
];

const assignmentSchema = z
  .object({
    strategy: z.enum(ASSIGNMENT_STRATEGIES),
    /** Required for `named_user`. A user id, never an email. */
    userId: z.string().trim().min(1).max(64).optional(),
    /** Required for `role` and `round_robin`: the eligible population. */
    role: z.string().trim().min(1).max(120).optional(),
    /** Required for `group`. */
    groupId: z.string().trim().min(1).max(64).optional(),
    /** Passed to an application resolver for the declared-only strategies. */
    resolverKey: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((assignment, ctx) => {
    const require = (field: 'userId' | 'role' | 'groupId' | 'resolverKey') => {
      if (!assignment[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `The "${assignment.strategy}" strategy requires "${field}".`,
        });
      }
    };

    switch (assignment.strategy) {
      case 'named_user':
        require('userId');
        break;
      case 'role':
      case 'round_robin':
        require('role');
        break;
      case 'group':
        require('groupId');
        break;
      case 'external_resolver':
        require('resolverKey');
        break;
      default:
        // The declared-only strategies take no field here; the resolver reads the
        // instance. Nothing to require.
        break;
    }
  });

export type WorkflowAssignmentSpec = z.infer<typeof assignmentSchema>;

// --- approval --------------------------------------------------------------

export const APPROVAL_MODELS = [
  'single',
  'sequential',
  'parallel',
  'unanimous',
  'threshold',
  'conditional',
] as const;

export type ApprovalModel = (typeof APPROVAL_MODELS)[number];

const approverSchema = z
  .object({
    key: identifierSchema,
    name: z.string().trim().min(1).max(160),
    /**
     * What an approver must hold. A permission, not a user id: a workflow that
     * names individuals stops working the first time somebody leaves.
     */
    permission: z.string().trim().min(3).max(120),
    /** Narrows the population further when a permission is held by several roles. */
    role: z.string().trim().min(1).max(120).optional(),
    /** Position for `sequential`. 1-based, contiguous. */
    order: z.number().int().min(1).max(20).optional(),
    /**
     * Skips this approver when the condition is false.
     *
     * The mechanism behind "compliance review only for high-risk requests". A
     * conditional approver that is skipped is recorded as skipped in the history,
     * not omitted — an auditor needs to see that the branch was evaluated.
     */
    condition: conditionSchema.optional(),
    /** Minutes before this approver's SLA warns. Null uses the step default. */
    slaMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 90)
      .nullable()
      .default(null),
  })
  .strict();

export type WorkflowApproverSpec = z.infer<typeof approverSchema>;

const approvalSchema = z
  .object({
    model: z.enum(APPROVAL_MODELS),
    approvers: z.array(approverSchema).min(1).max(20),
    /**
     * Required approvals for `threshold`. "2 of 3" is `threshold: 2` over three
     * approvers. Validated against the approver count: a threshold of 4 over 3
     * approvers is a workflow that can never complete, and it should fail at
     * publication rather than stall in production.
     */
    threshold: z.number().int().min(1).max(20).optional(),
    /**
     * Whether the submitter may approve.
     *
     * **False, and it is the framework's central default.** A workflow whose
     * submitter can approve their own request is not a control; it is a log entry
     * that looks like one. Setting it true is a deliberate, audited exception —
     * `validateDefinition` reports it as a warning so it appears in review.
     */
    allowSelfApproval: z.boolean().default(false),
    /**
     * Whether one actor may satisfy two approver slots.
     *
     * False by default. With it true, "2 of 3" can be satisfied by one person
     * clicking twice, which is not two approvals.
     */
    allowSameActorMultipleSlots: z.boolean().default(false),
    /** Reason codes a rejection must choose from. Empty means free text. */
    rejectionReasonCodes: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  })
  .strict()
  .superRefine((approval, ctx) => {
    if (approval.model === 'threshold') {
      if (approval.threshold === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['threshold'],
          message: 'A threshold approval requires "threshold".',
        });
      } else if (approval.threshold > approval.approvers.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['threshold'],
          message:
            `A threshold of ${approval.threshold} cannot be met by ` +
            `${approval.approvers.length} approver(s). This workflow could never complete.`,
        });
      }
    }

    if (approval.model === 'sequential') {
      const orders = approval.approvers.map((approver) => approver.order);
      if (orders.some((order) => order === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['approvers'],
          message: 'Every approver in a sequential model needs an "order".',
        });
      } else {
        const sorted = [...(orders as number[])].sort((a, b) => a - b);
        const contiguous = sorted.every((order, index) => order === index + 1);
        if (!contiguous) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['approvers'],
            message:
              `Sequential approver orders must be contiguous from 1. Got ${sorted.join(', ')} — ` +
              'a gap means an approval step nothing can reach.',
          });
        }
      }
    }

    if (approval.model === 'single' && approval.approvers.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvers'],
        message:
          'A single-approval model takes one approver. Use "parallel" or "threshold" for ' +
          'several eligible approvers.',
      });
    }

    if (approval.model === 'conditional') {
      const conditioned = approval.approvers.filter((approver) => approver.condition);
      if (conditioned.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['approvers'],
          message:
            'A conditional model needs at least one approver with a condition, otherwise it ' +
            'is a unanimous model with extra words.',
        });
      }
      // Every approver conditional means every approver can be skipped, and a
      // request can reach "approved" with nobody having looked at it.
      if (conditioned.length === approval.approvers.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['approvers'],
          message:
            'At least one approver must be unconditional, otherwise every approver can be ' +
            'skipped and the request could be approved with no review at all.',
        });
      }
    }
  });

export type WorkflowApprovalSpec = z.infer<typeof approvalSchema>;

// --- SLA and escalation ----------------------------------------------------

const slaRuleSchema = z
  .object({
    kind: z.enum(['time_to_acknowledge', 'time_to_claim', 'time_to_complete', 'total_duration']),
    minutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 365),
    /**
     * Percentage of the duration at which the SLA warns. 80 means warn at 80%.
     *
     * A percentage rather than an absolute time, so changing the duration does not
     * silently move the warning past the deadline.
     */
    warningAtPercent: z.number().int().min(1).max(99).default(80),
    severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
    /** Registered calendar. `elapsed` is the default and the only one shipped. */
    calendar: z.string().trim().min(1).max(60).default('elapsed'),
  })
  .strict();

export type WorkflowSlaRuleSpec = z.infer<typeof slaRuleSchema>;

const escalationRuleSchema = z
  .object({
    key: identifierSchema,
    trigger: z.enum(['sla_warning', 'sla_breach', 'manual', 'rework_limit']),
    action: z.enum([
      'notify_assignee',
      'notify_supervisor',
      'reassign_task',
      'add_approver',
      'increase_priority',
      'create_incident',
      'callback',
    ]),
    /** Notification template key, for the notify actions. */
    templateKey: z.string().trim().min(1).max(120).optional(),
    /** Target for `reassign_task` and `add_approver`. */
    assignment: assignmentSchema.optional(),
    /** Application callback key for `callback`. Resolved from a registry, never a URL. */
    callbackKey: z.string().trim().min(1).max(120).optional(),
    /** Fires only when this holds. Lets one rule cover the high-risk case alone. */
    condition: conditionSchema.optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.action === 'reassign_task' || rule.action === 'add_approver') {
      if (!rule.assignment) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assignment'],
          message: `The "${rule.action}" action requires an "assignment".`,
        });
      }
    }
    if (rule.action === 'callback' && !rule.callbackKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['callbackKey'],
        // A key into a registry the application populates, not a URL: a definition
        // that could name a URL would be a server-side request forgery primitive
        // writable by anyone who can author a workflow.
        message:
          'The "callback" action requires a "callbackKey" naming a registered handler. ' +
          'URLs are not accepted.',
      });
    }
  });

export type WorkflowEscalationRuleSpec = z.infer<typeof escalationRuleSchema>;

// --- steps and transitions -------------------------------------------------

export const STEP_KINDS = [
  /** A person acts. Produces tasks. */
  'task',
  /** Approvers decide. Produces tasks and evaluates an approval model. */
  'approval',
  /** The engine moves on with no human action. Must have an automatic transition. */
  'automatic',
  /** Terminal. No transitions out. */
  'terminal',
] as const;

export type StepKind = (typeof STEP_KINDS)[number];

const stepSchema = z
  .object({
    /** The state this step governs. One step per state. */
    state: stateSchema,
    kind: z.enum(STEP_KINDS),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(600).default(''),
    assignment: assignmentSchema.optional(),
    approval: approvalSchema.optional(),
    sla: z.array(slaRuleSchema).max(4).default([]),
    escalations: z.array(escalationRuleSchema).max(10).default([]),
    /** Instance-data fields that must be present before leaving this state. */
    requiredFields: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    /**
     * Requires evidence before a decision.
     *
     * Conditional, so "attachments required for high-risk requests" is expressible
     * without a separate step.
     */
    requireAttachment: z.boolean().default(false),
    requireAttachmentWhen: conditionSchema.optional(),
    /** Instance-data fields the maker may edit while in this state. */
    editableFields: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  })
  .strict()
  .superRefine((step, ctx) => {
    if (step.kind === 'approval' && !step.approval) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval'],
        message: 'An approval step requires an "approval" block.',
      });
    }
    if (step.kind === 'terminal') {
      if (step.approval || step.assignment) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['kind'],
          message: 'A terminal step has no assignment and no approval: nothing happens in it.',
        });
      }
    }
    if (step.requireAttachmentWhen && step.requireAttachment) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requireAttachmentWhen'],
        message:
          'Set either "requireAttachment" (always) or "requireAttachmentWhen" (conditionally), ' +
          'not both — two rules for one thing is one rule somebody will miss.',
      });
    }
  });

export type WorkflowStepSpec = z.infer<typeof stepSchema>;

const transitionSchema = z
  .object({
    /** The verb an actor asks for. Unique within the definition. */
    action: identifierSchema,
    from: stateSchema,
    to: stateSchema,
    name: z.string().trim().min(1).max(160).optional(),
    /** Permission the actor must hold. Additional to the step's approval rules. */
    permission: z.string().trim().min(3).max(120).optional(),
    /** Guard on instance data. A false condition makes the transition unavailable. */
    condition: conditionSchema.optional(),
    /**
     * Taken by the engine with no actor.
     *
     * Validation refuses a cycle of these: two automatic transitions pointing at
     * each other is an infinite loop in the runtime, and the runtime should not
     * have to defend against a definition that was accepted.
     */
    automatic: z.boolean().default(false),
    /** A reason is mandatory. True for rejection and return-for-rework. */
    requiresReason: z.boolean().default(false),
    /** Counts as a rework cycle, incrementing the instance's counter. */
    isRework: z.boolean().default(false),
    /** Recorded as a rejection decision. */
    isRejection: z.boolean().default(false),
    /** Marks the instance cancelled rather than completed on arrival. */
    isCancellation: z.boolean().default(false),
  })
  .strict()
  .superRefine((transition, ctx) => {
    if (transition.from === transition.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message:
          'A transition to its own state changes nothing and would loop if automatic. ' +
          'Use an action on the step instead.',
      });
    }
    if (transition.automatic && transition.requiresReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiresReason'],
        message: 'An automatic transition has no actor to supply a reason.',
      });
    }
    if (transition.automatic && transition.permission) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permission'],
        message:
          'An automatic transition has no actor, so a permission cannot be checked. ' +
          'Remove it, or make the transition manual.',
      });
    }
  });

export type WorkflowTransitionSpec = z.infer<typeof transitionSchema>;

// --- rejection and cancellation --------------------------------------------

export const REJECTION_BEHAVIOURS = [
  'final',
  'return_to_maker',
  'route_to_step',
  'open_exception_case',
] as const;

export type RejectionBehaviour = (typeof REJECTION_BEHAVIOURS)[number];

const rejectionPolicySchema = z
  .object({
    behaviour: z.enum(REJECTION_BEHAVIOURS).default('final'),
    /** Required for `route_to_step`. */
    routeToState: stateSchema.optional(),
    /** Case type for `open_exception_case`. */
    caseType: z.string().trim().min(1).max(80).optional(),
    reasonCodes: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.behaviour === 'route_to_step' && !policy.routeToState) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routeToState'],
        message: 'Routing a rejection requires "routeToState".',
      });
    }
    if (policy.behaviour === 'open_exception_case' && !policy.caseType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['caseType'],
        message: 'Opening an exception case requires "caseType".',
      });
    }
  });

const cancellationPolicySchema = z
  .object({
    /** States a cancellation is legal from. Empty means any non-terminal state. */
    allowedFromStates: z.array(stateSchema).max(40).default([]),
    /** Permission a canceller must hold. */
    permission: z.string().trim().min(3).max(120).optional(),
    requiresReason: z.boolean().default(true),
    /** Cancellation itself needs approval. For workflows with external commitments. */
    requiresApproval: z.boolean().default(false),
    /** Registered compensation handler. A key, never a URL. */
    compensationKey: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const reworkPolicySchema = z
  .object({
    /** Null means unlimited. A number caps the ping-pong. */
    maxCycles: z.number().int().min(1).max(50).nullable().default(null),
    /** What happens when the cap is reached. */
    onLimitReached: z.enum(['block', 'escalate', 'reject']).default('block'),
  })
  .strict();

// --- the document ----------------------------------------------------------

export const workflowDefinitionDocumentSchema = z
  .object({
    id: identifierSchema,
    version: z.string().trim().regex(SEMVER_PATTERN, 'Use semantic versioning, e.g. 1.0.0.'),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000).default(''),
    /** What this governs. Matched against the instance's `businessObjectType`. */
    businessObjectType: z.string().trim().min(1).max(120),

    initialState: stateSchema,
    /** Every state. The validator checks steps and transitions against this list. */
    states: z.array(stateSchema).min(2).max(60),
    /** Terminal states. At least one, or the workflow never ends. */
    finalStates: z.array(stateSchema).min(1).max(30),

    steps: z.array(stepSchema).min(1).max(60),
    transitions: z.array(transitionSchema).min(1).max(200),

    rejection: rejectionPolicySchema.default({}),
    cancellation: cancellationPolicySchema.default({}),
    rework: reworkPolicySchema.default({}),

    /** Permission needed to start an instance. */
    startPermission: z.string().trim().min(3).max(120).optional(),
    /** Default priority for new instances. */
    defaultPriority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    /** Workflow-level SLA, distinct from a step's. */
    sla: z.array(slaRuleSchema).max(4).default([]),

    /**
     * Free-form labels for the portal: owning team, review cadence, ticket.
     *
     * Values are strings only. A nested object here would be a place for somebody
     * to put configuration the engine does not validate.
     */
    labels: z.record(z.string().max(200)).default({}),
  })
  .strict();

export type WorkflowDefinitionDocument = z.infer<typeof workflowDefinitionDocumentSchema>;
