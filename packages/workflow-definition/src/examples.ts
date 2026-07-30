import type { WorkflowDefinitionDocument } from './schema';

/**
 * The framework's example workflow: Change Request Approval.
 *
 * Deliberately generic. It approves "a change" with an amount and a risk rating,
 * which is the shape of a merchant onboarding, a limit increase, a configuration
 * change and a payment release — without being any of them. A framework example that
 * encoded one industry's rules would be copied by everyone who does something
 * slightly different, and the copies would carry the wrong assumptions.
 *
 * It exercises every control worth demonstrating:
 *
 *   * maker-checker — the submitter cannot approve, which is the default and is not
 *     overridden anywhere here
 *   * sequential approval — manager, then compliance, in that order
 *   * conditional approval — compliance reviews only high-risk requests
 *   * conditional evidence — an attachment is required only for high-risk requests
 *   * return for rework, with a mandatory reason and a cycle limit
 *   * rejection as a terminal decision, distinct from cancellation
 *   * SLA with escalation on both warning and breach
 *
 * `riskRating` values are `low` / `medium` / `high`. Generic on purpose: a scoring
 * model belongs to a product, and the workflow's job is to route on the answer.
 */
export const CHANGE_REQUEST_APPROVAL: WorkflowDefinitionDocument = {
  id: 'change-request-approval',
  version: '1.0.0',
  name: 'Change Request Approval',
  description:
    'A generic two-stage approval: a manager reviews every request, and compliance reviews ' +
    'high-risk ones. Demonstrates maker-checker, sequential and conditional approval, ' +
    'conditional evidence, rework and escalation.',
  businessObjectType: 'ChangeRequest',

  initialState: 'draft',
  states: [
    'draft',
    'submitted',
    'manager_review',
    'compliance_review',
    'approved',
    'rejected',
    'returned_for_rework',
    'cancelled',
  ],
  finalStates: ['approved', 'rejected', 'cancelled'],

  steps: [
    {
      state: 'draft',
      kind: 'task',
      name: 'Prepare the request',
      description: 'The maker fills in the request and attaches supporting evidence.',
      assignment: { strategy: 'named_user', userId: '${initiator}' },
      sla: [],
      escalations: [],
      requiredFields: ['title', 'amount', 'riskRating'],
      requireAttachment: false,
      // The maker's editable set. It is also what a rework cycle allows to change,
      // which is why it is declared rather than implied: an approver needs to know
      // what could have moved since they last looked.
      editableFields: ['title', 'description', 'amount', 'riskRating', 'justification'],
    },

    {
      state: 'submitted',
      kind: 'automatic',
      name: 'Route the request',
      description: 'Sends the request to manager review. No human acts in this state.',
      sla: [],
      escalations: [],
      requiredFields: [],
      requireAttachment: false,
      editableFields: [],
    },

    {
      state: 'manager_review',
      kind: 'approval',
      name: 'Manager review',
      description: 'A manager reviews every request, whatever its risk.',
      assignment: { strategy: 'role', role: 'workflow_checker' },
      approval: {
        model: 'sequential',
        approvers: [
          {
            key: 'manager',
            name: 'Operations Manager',
            permission: 'workflow.approval.decide',
            order: 1,
            slaMinutes: 480,
          },
        ],
        // Left at the default. Stated by omission everywhere else in the framework;
        // here it is the whole point of the example.
        allowSelfApproval: false,
        allowSameActorMultipleSlots: false,
        rejectionReasonCodes: [
          'insufficient_justification',
          'out_of_policy',
          'incorrect_amount',
          'missing_evidence',
        ],
      },
      sla: [
        {
          kind: 'time_to_complete',
          minutes: 480,
          warningAtPercent: 75,
          severity: 'medium',
          calendar: 'elapsed',
        },
      ],
      escalations: [
        {
          key: 'warn-assignee',
          trigger: 'sla_warning',
          action: 'notify_assignee',
          templateKey: 'workflow.sla.warning',
        },
        {
          key: 'breach-supervisor',
          trigger: 'sla_breach',
          action: 'notify_supervisor',
          templateKey: 'workflow.sla.breach',
        },
        {
          key: 'breach-priority',
          trigger: 'sla_breach',
          action: 'increase_priority',
        },
      ],
      requiredFields: [],
      // Evidence is required only where it changes the decision. An unconditional
      // requirement gets satisfied with a screenshot of nothing.
      requireAttachment: false,
      requireAttachmentWhen: {
        field: 'riskRating',
        operator: 'in',
        value: ['high'],
      },
      editableFields: [],
    },

    {
      state: 'compliance_review',
      kind: 'approval',
      name: 'Compliance review',
      description: 'A second, independent review. Reached only by high-risk requests.',
      assignment: { strategy: 'role', role: 'workflow_checker' },
      approval: {
        model: 'sequential',
        approvers: [
          {
            key: 'compliance',
            name: 'Compliance Officer',
            permission: 'workflow.approval.decide',
            role: 'workflow_checker',
            order: 1,
            slaMinutes: 960,
          },
        ],
        allowSelfApproval: false,
        allowSameActorMultipleSlots: false,
        rejectionReasonCodes: ['policy_breach', 'sanctions_concern', 'documentation_inadequate'],
      },
      sla: [
        {
          kind: 'time_to_complete',
          minutes: 960,
          warningAtPercent: 80,
          severity: 'high',
          calendar: 'elapsed',
        },
      ],
      escalations: [
        {
          key: 'warn-assignee',
          trigger: 'sla_warning',
          action: 'notify_assignee',
          templateKey: 'workflow.sla.warning',
        },
        {
          key: 'breach-supervisor',
          trigger: 'sla_breach',
          action: 'notify_supervisor',
          templateKey: 'workflow.sla.breach',
        },
      ],
      requiredFields: [],
      requireAttachment: false,
      editableFields: [],
    },

    {
      state: 'returned_for_rework',
      kind: 'task',
      name: 'Rework',
      description: 'The maker addresses the reviewer’s comments and resubmits.',
      assignment: { strategy: 'named_user', userId: '${initiator}' },
      sla: [
        {
          kind: 'time_to_complete',
          minutes: 2880,
          warningAtPercent: 80,
          severity: 'low',
          calendar: 'elapsed',
        },
      ],
      escalations: [
        {
          key: 'warn-maker',
          trigger: 'sla_warning',
          action: 'notify_assignee',
          templateKey: 'workflow.rework.reminder',
        },
      ],
      requiredFields: ['title', 'amount', 'riskRating'],
      requireAttachment: false,
      editableFields: ['title', 'description', 'amount', 'riskRating', 'justification'],
    },

    {
      state: 'approved',
      kind: 'terminal',
      name: 'Approved',
      description: 'Every required approval was granted.',
      sla: [],
      escalations: [],
      requiredFields: [],
      requireAttachment: false,
      editableFields: [],
    },
    {
      state: 'rejected',
      kind: 'terminal',
      name: 'Rejected',
      description: 'A reviewer refused the request. The decision and its reason are retained.',
      sla: [],
      escalations: [],
      requiredFields: [],
      requireAttachment: false,
      editableFields: [],
    },
    {
      state: 'cancelled',
      kind: 'terminal',
      name: 'Cancelled',
      description: 'Withdrawn before a decision. Distinct from rejected.',
      sla: [],
      escalations: [],
      requiredFields: [],
      requireAttachment: false,
      editableFields: [],
    },
  ],

  transitions: [
    {
      action: 'submit',
      from: 'draft',
      to: 'submitted',
      name: 'Submit for approval',
      permission: 'workflow.instance.transition',
      automatic: false,
      requiresReason: false,
      isRework: false,
      isRejection: false,
      isCancellation: false,
    },

    // Automatic routing. Every request goes to manager review; the risk branch is
    // after it, not before, so nothing skips the first pair of eyes.
    {
      action: 'route_to_manager',
      from: 'submitted',
      to: 'manager_review',
      name: 'Route to manager review',
      automatic: true,
      requiresReason: false,
      isRework: false,
      isRejection: false,
      isCancellation: false,
    },

    // The conditional branch. High risk goes to compliance; everything else is
    // approved after the manager. The two conditions are exact complements, so
    // exactly one applies — which is what the validator's ambiguity check wants.
    {
      action: 'escalate_to_compliance',
      from: 'manager_review',
      to: 'compliance_review',
      name: 'Manager approved; high risk needs compliance',
      permission: 'workflow.approval.decide',
      condition: { field: 'riskRating', operator: 'eq', value: 'high' },
      automatic: false,
      requiresReason: false,
      isRework: false,
      isRejection: false,
      isCancellation: false,
    },
    {
      action: 'approve',
      from: 'manager_review',
      to: 'approved',
      name: 'Manager approved',
      permission: 'workflow.approval.decide',
      condition: { field: 'riskRating', operator: 'neq', value: 'high' },
      automatic: false,
      requiresReason: false,
      isRework: false,
      isRejection: false,
      isCancellation: false,
    },
    {
      action: 'approve',
      from: 'compliance_review',
      to: 'approved',
      name: 'Compliance approved',
      permission: 'workflow.approval.decide',
      automatic: false,
      requiresReason: false,
      isRework: false,
      isRejection: false,
      isCancellation: false,
    },

    // Rejection from either review. Terminal, and a reason is mandatory: a rejection
    // with no reason is unusable by the maker and worthless to an auditor.
    {
      action: 'reject',
      from: 'manager_review',
      to: 'rejected',
      name: 'Reject',
      permission: 'workflow.approval.decide',
      automatic: false,
      requiresReason: true,
      isRework: false,
      isRejection: true,
      isCancellation: false,
    },
    {
      action: 'reject',
      from: 'compliance_review',
      to: 'rejected',
      name: 'Reject',
      permission: 'workflow.approval.decide',
      automatic: false,
      requiresReason: true,
      isRework: false,
      isRejection: true,
      isCancellation: false,
    },

    // Return for rework. Also needs a reason, for the same purpose: it is the only
    // instruction the maker receives.
    {
      action: 'return_for_rework',
      from: 'manager_review',
      to: 'returned_for_rework',
      name: 'Return to the maker',
      permission: 'workflow.approval.decide',
      automatic: false,
      requiresReason: true,
      isRework: true,
      isRejection: false,
      isCancellation: false,
    },
    {
      action: 'return_for_rework',
      from: 'compliance_review',
      to: 'returned_for_rework',
      name: 'Return to the maker',
      permission: 'workflow.approval.decide',
      automatic: false,
      requiresReason: true,
      isRework: true,
      isRejection: false,
      isCancellation: false,
    },
    {
      action: 'resubmit',
      from: 'returned_for_rework',
      to: 'submitted',
      name: 'Resubmit after rework',
      permission: 'workflow.instance.transition',
      automatic: false,
      requiresReason: false,
      isRework: false,
      isRejection: false,
      isCancellation: false,
    },

    // Cancellation from any pre-decision state.
    {
      action: 'cancel',
      from: 'draft',
      to: 'cancelled',
      name: 'Cancel',
      permission: 'workflow.instance.cancel',
      automatic: false,
      requiresReason: true,
      isRework: false,
      isRejection: false,
      isCancellation: true,
    },
    {
      action: 'cancel',
      from: 'submitted',
      to: 'cancelled',
      name: 'Cancel',
      permission: 'workflow.instance.cancel',
      automatic: false,
      requiresReason: true,
      isRework: false,
      isRejection: false,
      isCancellation: true,
    },
    {
      action: 'cancel',
      from: 'manager_review',
      to: 'cancelled',
      name: 'Cancel',
      permission: 'workflow.instance.cancel',
      automatic: false,
      requiresReason: true,
      isRework: false,
      isRejection: false,
      isCancellation: true,
    },
    {
      action: 'cancel',
      from: 'returned_for_rework',
      to: 'cancelled',
      name: 'Cancel',
      permission: 'workflow.instance.cancel',
      automatic: false,
      requiresReason: true,
      isRework: false,
      isRejection: false,
      isCancellation: true,
    },
  ],

  rejection: {
    // Terminal. A rejected change request is closed, and reopening it means raising
    // a new one — which leaves the rejection standing in the trail rather than
    // buried under a later approval of the same record.
    behaviour: 'final',
    reasonCodes: [
      'insufficient_justification',
      'out_of_policy',
      'incorrect_amount',
      'missing_evidence',
      'policy_breach',
      'sanctions_concern',
      'documentation_inadequate',
    ],
  },

  cancellation: {
    allowedFromStates: ['draft', 'submitted', 'manager_review', 'returned_for_rework'],
    permission: 'workflow.instance.cancel',
    requiresReason: true,
    requiresApproval: false,
  },

  rework: {
    // Three cycles, then it stops. An unbounded rework loop is how a request stays
    // open for a year while both sides believe the other has it.
    maxCycles: 3,
    onLimitReached: 'escalate',
  },

  startPermission: 'workflow.instance.start',
  defaultPriority: 'normal',
  sla: [
    {
      kind: 'total_duration',
      minutes: 4320,
      warningAtPercent: 80,
      severity: 'medium',
      calendar: 'elapsed',
    },
  ],
  labels: {
    owner: 'platform-team',
    review: 'quarterly',
    example: 'true',
  },
};

/**
 * A second example, minimal on purpose.
 *
 * The smallest thing that is still a workflow: one submission, one approval. Used by
 * tests that need a valid definition without the change-request example's branches,
 * and by the documentation as the "start from here" template.
 */
export const SIMPLE_APPROVAL: WorkflowDefinitionDocument = {
  id: 'simple-approval',
  version: '1.0.0',
  name: 'Simple Approval',
  description: 'One submission, one independent approval. The smallest useful workflow.',
  businessObjectType: 'GenericRequest',

  initialState: 'draft',
  states: ['draft', 'pending_approval', 'approved', 'rejected'],
  finalStates: ['approved', 'rejected'],

  steps: [
    {
      state: 'draft',
      kind: 'task',
      name: 'Prepare',
      description: 'The maker prepares the request.',
      assignment: { strategy: 'named_user', userId: '${initiator}' },
      sla: [],
      escalations: [],
      requiredFields: ['title'],
      requireAttachment: false,
      editableFields: ['title', 'description'],
    },
    {
      state: 'pending_approval',
      kind: 'approval',
      name: 'Approval',
      description: 'One checker decides.',
      assignment: { strategy: 'role', role: 'workflow_checker' },
      approval: {
        model: 'single',
        approvers: [
          {
            key: 'checker',
            name: 'Checker',
            permission: 'workflow.approval.decide',
            slaMinutes: 480,
          },
        ],
        allowSelfApproval: false,
        allowSameActorMultipleSlots: false,
        rejectionReasonCodes: ['not_justified'],
      },
      sla: [
        {
          kind: 'time_to_complete',
          minutes: 480,
          warningAtPercent: 80,
          severity: 'medium',
          calendar: 'elapsed',
        },
      ],
      escalations: [
        {
          key: 'breach',
          trigger: 'sla_breach',
          action: 'notify_supervisor',
          templateKey: 'workflow.sla.breach',
        },
      ],
      requiredFields: [],
      requireAttachment: false,
      editableFields: [],
    },
    {
      state: 'approved',
      kind: 'terminal',
      name: 'Approved',
      description: 'Approved.',
      sla: [],
      escalations: [],
      requiredFields: [],
      requireAttachment: false,
      editableFields: [],
    },
    {
      state: 'rejected',
      kind: 'terminal',
      name: 'Rejected',
      description: 'Rejected.',
      sla: [],
      escalations: [],
      requiredFields: [],
      requireAttachment: false,
      editableFields: [],
    },
  ],

  transitions: [
    {
      action: 'submit',
      from: 'draft',
      to: 'pending_approval',
      permission: 'workflow.instance.transition',
      automatic: false,
      requiresReason: false,
      isRework: false,
      isRejection: false,
      isCancellation: false,
    },
    {
      action: 'approve',
      from: 'pending_approval',
      to: 'approved',
      permission: 'workflow.approval.decide',
      automatic: false,
      requiresReason: false,
      isRework: false,
      isRejection: false,
      isCancellation: false,
    },
    {
      action: 'reject',
      from: 'pending_approval',
      to: 'rejected',
      permission: 'workflow.approval.decide',
      automatic: false,
      requiresReason: true,
      isRework: false,
      isRejection: true,
      isCancellation: false,
    },
  ],

  rejection: { behaviour: 'final', reasonCodes: ['not_justified'] },
  cancellation: { allowedFromStates: [], requiresReason: true, requiresApproval: false },
  rework: { maxCycles: null, onLimitReached: 'block' },

  startPermission: 'workflow.instance.start',
  defaultPriority: 'normal',
  sla: [],
  labels: { example: 'true' },
};

export const EXAMPLE_DEFINITIONS = [CHANGE_REQUEST_APPROVAL, SIMPLE_APPROVAL];
