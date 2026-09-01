/**
 * Workflow permissions.
 *
 * Declared here rather than in `@trustsystem/rbac` because they are workflow's
 * vocabulary, and `@trustsystem/rbac` should not have to know that a workflow engine
 * exists. `registerWorkflowPermissions` merges them into an application's catalog —
 * the same pattern a product uses for its own permissions.
 *
 * The split is the point. `workflow.instance.transition` is not
 * `workflow.instance.approve`: the first is "may you move this workflow along", the
 * second is "may you be a checker". A single `workflow.write` would collapse maker
 * and checker into one grant, which is the opposite of what maker-checker is for.
 *
 * Definition authoring is split three ways for the same reason —
 * `definition.create`, `definition.approve` and `definition.publish` are held by
 * different people, so that a workflow author cannot publish their own workflow.
 * See `docs/maker-checker.md`.
 */

export interface WorkflowPermissionDefinition {
  key: string;
  resource: string;
  action: string;
  description: string;
}

function define(key: string, description: string): WorkflowPermissionDefinition {
  const segments = key.split('.');
  const action = segments[segments.length - 1] as string;
  return { key, resource: segments.slice(0, -1).join('.'), action, description };
}

export const WORKFLOW_PERMISSIONS = {
  // --- definitions ---------------------------------------------------------
  DEFINITION_READ: define('workflow.definition.read', 'View workflow definitions and versions.'),
  DEFINITION_CREATE: define(
    'workflow.definition.create',
    'Create a draft workflow definition or a new draft version.',
  ),
  DEFINITION_UPDATE: define('workflow.definition.update', 'Edit a draft workflow definition.'),
  DEFINITION_SUBMIT: define(
    'workflow.definition.submit',
    'Submit a draft workflow definition for independent approval.',
  ),
  /** Deliberately not held by the author's role. See docs/maker-checker.md. */
  DEFINITION_APPROVE: define(
    'workflow.definition.approve',
    'Approve a workflow definition somebody else authored.',
  ),
  DEFINITION_PUBLISH: define(
    'workflow.definition.publish',
    'Publish an approved workflow definition, making it immutable and active.',
  ),
  DEFINITION_RETIRE: define(
    'workflow.definition.retire',
    'Retire a published workflow version so no new instances use it.',
  ),

  // --- instances -----------------------------------------------------------
  INSTANCE_READ: define('workflow.instance.read', 'View workflow instances and their history.'),
  INSTANCE_START: define('workflow.instance.start', 'Start a workflow instance.'),
  INSTANCE_TRANSITION: define(
    'workflow.instance.transition',
    'Execute a workflow transition the definition permits.',
  ),
  INSTANCE_CANCEL: define('workflow.instance.cancel', 'Cancel a workflow instance.'),

  // --- tasks ---------------------------------------------------------------
  TASK_READ: define('workflow.task.read', 'View workflow tasks, including the unclaimed pool.'),
  TASK_CLAIM: define('workflow.task.claim', 'Claim an eligible task from a pool.'),
  TASK_COMPLETE: define('workflow.task.complete', 'Complete a task the actor holds.'),
  TASK_REASSIGN: define('workflow.task.reassign', 'Reassign a task away from its current holder.'),
  TASK_DELEGATE: define('workflow.task.delegate', 'Delegate a held task to another eligible user.'),

  // --- approvals -----------------------------------------------------------
  /** The checker grant. Never given to a role that also submits. */
  APPROVAL_DECIDE: define(
    'workflow.approval.decide',
    'Record an approval decision: approve, reject or return for rework.',
  ),
  APPROVAL_OVERRIDE: define(
    'workflow.approval.override',
    'Override a stalled approval. Always audited, and reserved for incident handling.',
  ),

  // --- collaboration -------------------------------------------------------
  COMMENT_READ: define('workflow.comment.read', 'Read workflow comments the actor may see.'),
  COMMENT_WRITE: define('workflow.comment.write', 'Add a workflow comment.'),
  COMMENT_AMEND: define(
    'workflow.comment.amend',
    'Amend an own comment. The previous text is retained.',
  ),
  COMMENT_MODERATE: define(
    'workflow.comment.moderate',
    'Redact a comment. The original is retained and the redaction is audited.',
  ),

  ATTACHMENT_READ: define('workflow.attachment.read', 'Read workflow attachments.'),
  ATTACHMENT_WRITE: define('workflow.attachment.write', 'Attach evidence to a workflow.'),
  ATTACHMENT_REMOVE: define(
    'workflow.attachment.remove',
    'Detach evidence. The document itself is not deleted.',
  ),

  // --- SLA and escalation --------------------------------------------------
  SLA_READ: define('workflow.sla.read', 'View SLA status, warnings and breaches.'),
  SLA_PAUSE: define('workflow.sla.pause', 'Pause an SLA clock, e.g. while awaiting a third party.'),
  ESCALATION_READ: define('workflow.escalation.read', 'View escalation history.'),
  ESCALATION_TRIGGER: define('workflow.escalation.trigger', 'Trigger an escalation manually.'),

  // --- cases ---------------------------------------------------------------
  CASE_READ: define('case.read', 'View case records.'),
  CASE_CREATE: define('case.create', 'Open a case.'),
  CASE_UPDATE: define('case.update', 'Update a case: owner, team, priority, status.'),
  CASE_RESOLVE: define('case.resolve', 'Record a case resolution.'),
  CASE_CLOSE: define('case.close', 'Close a resolved case.'),
} as const satisfies Record<string, WorkflowPermissionDefinition>;

export type WorkflowPermissionKey =
  (typeof WORKFLOW_PERMISSIONS)[keyof typeof WORKFLOW_PERMISSIONS]['key'];

export const ALL_WORKFLOW_PERMISSIONS: WorkflowPermissionDefinition[] =
  Object.values(WORKFLOW_PERMISSIONS);

export const ALL_WORKFLOW_PERMISSION_KEYS: string[] = ALL_WORKFLOW_PERMISSIONS.map(
  (permission) => permission.key,
);

export function isWorkflowPermission(key: string): boolean {
  return ALL_WORKFLOW_PERMISSION_KEYS.includes(key);
}

/**
 * Role suggestions, not a role model.
 *
 * A product's roles are a product decision. What this encodes is the one part that
 * is *not* negotiable: no suggested role holds both a submitting grant and the
 * matching approving grant. `assertSeparableGrants` checks that property, and the
 * package's own test runs it over this table — so a well-meaning edit that gave the
 * author role `definition.approve` would fail a test rather than ship.
 */
export const SUGGESTED_WORKFLOW_ROLE_GRANTS: Record<string, string[]> = {
  /** Raises requests and does the rework. Cannot approve anything. */
  workflow_maker: [
    WORKFLOW_PERMISSIONS.INSTANCE_READ.key,
    WORKFLOW_PERMISSIONS.INSTANCE_START.key,
    WORKFLOW_PERMISSIONS.INSTANCE_TRANSITION.key,
    WORKFLOW_PERMISSIONS.TASK_READ.key,
    WORKFLOW_PERMISSIONS.TASK_CLAIM.key,
    WORKFLOW_PERMISSIONS.TASK_COMPLETE.key,
    WORKFLOW_PERMISSIONS.COMMENT_READ.key,
    WORKFLOW_PERMISSIONS.COMMENT_WRITE.key,
    WORKFLOW_PERMISSIONS.COMMENT_AMEND.key,
    WORKFLOW_PERMISSIONS.ATTACHMENT_READ.key,
    WORKFLOW_PERMISSIONS.ATTACHMENT_WRITE.key,
    WORKFLOW_PERMISSIONS.DEFINITION_READ.key,
  ],

  /** Decides. Cannot start the requests it decides on. */
  workflow_checker: [
    WORKFLOW_PERMISSIONS.INSTANCE_READ.key,
    WORKFLOW_PERMISSIONS.TASK_READ.key,
    WORKFLOW_PERMISSIONS.TASK_CLAIM.key,
    WORKFLOW_PERMISSIONS.TASK_COMPLETE.key,
    WORKFLOW_PERMISSIONS.APPROVAL_DECIDE.key,
    WORKFLOW_PERMISSIONS.COMMENT_READ.key,
    WORKFLOW_PERMISSIONS.COMMENT_WRITE.key,
    WORKFLOW_PERMISSIONS.ATTACHMENT_READ.key,
    WORKFLOW_PERMISSIONS.DEFINITION_READ.key,
    WORKFLOW_PERMISSIONS.SLA_READ.key,
  ],

  /** Writes definitions. Cannot approve or publish them. */
  workflow_author: [
    WORKFLOW_PERMISSIONS.DEFINITION_READ.key,
    WORKFLOW_PERMISSIONS.DEFINITION_CREATE.key,
    WORKFLOW_PERMISSIONS.DEFINITION_UPDATE.key,
    WORKFLOW_PERMISSIONS.DEFINITION_SUBMIT.key,
    WORKFLOW_PERMISSIONS.INSTANCE_READ.key,
  ],

  /** Runs the engine. Governs definitions but does not author them. */
  workflow_administrator: [
    WORKFLOW_PERMISSIONS.DEFINITION_READ.key,
    WORKFLOW_PERMISSIONS.DEFINITION_APPROVE.key,
    WORKFLOW_PERMISSIONS.DEFINITION_PUBLISH.key,
    WORKFLOW_PERMISSIONS.DEFINITION_RETIRE.key,
    WORKFLOW_PERMISSIONS.INSTANCE_READ.key,
    WORKFLOW_PERMISSIONS.INSTANCE_CANCEL.key,
    WORKFLOW_PERMISSIONS.TASK_READ.key,
    WORKFLOW_PERMISSIONS.TASK_REASSIGN.key,
    WORKFLOW_PERMISSIONS.SLA_READ.key,
    WORKFLOW_PERMISSIONS.SLA_PAUSE.key,
    WORKFLOW_PERMISSIONS.ESCALATION_READ.key,
    WORKFLOW_PERMISSIONS.ESCALATION_TRIGGER.key,
    WORKFLOW_PERMISSIONS.COMMENT_READ.key,
    WORKFLOW_PERMISSIONS.COMMENT_MODERATE.key,
    WORKFLOW_PERMISSIONS.ATTACHMENT_READ.key,
    WORKFLOW_PERMISSIONS.CASE_READ.key,
    WORKFLOW_PERMISSIONS.CASE_UPDATE.key,
  ],
};

/**
 * Grant pairs no single role may hold.
 *
 * The list is short because separation of duties is a small number of rules applied
 * consistently, not a large number of special cases.
 */
export const INCOMPATIBLE_GRANT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [WORKFLOW_PERMISSIONS.INSTANCE_START.key, WORKFLOW_PERMISSIONS.APPROVAL_DECIDE.key],
  [WORKFLOW_PERMISSIONS.DEFINITION_CREATE.key, WORKFLOW_PERMISSIONS.DEFINITION_APPROVE.key],
  [WORKFLOW_PERMISSIONS.DEFINITION_CREATE.key, WORKFLOW_PERMISSIONS.DEFINITION_PUBLISH.key],
  [WORKFLOW_PERMISSIONS.APPROVAL_DECIDE.key, WORKFLOW_PERMISSIONS.APPROVAL_OVERRIDE.key],
];

/**
 * Reports incompatible grants held by one role.
 *
 * Returns findings rather than throwing, because a deployment may hold a documented
 * exception — a two-person team where one role does both, accepted knowingly. The
 * framework's job is to make that visible, not to make it impossible; an engine
 * that refused would be one somebody worked around by inventing a third role that
 * holds both.
 *
 * `super_admin` is exempt: it holds the wildcard by design, and its power is
 * governed by who is given it rather than by which pairs it avoids.
 */
export function findIncompatibleGrants(
  grants: Record<string, string[]>,
): Array<{ role: string; permissions: [string, string] }> {
  const findings: Array<{ role: string; permissions: [string, string] }> = [];

  for (const [role, permissions] of Object.entries(grants)) {
    if (role === 'super_admin' || permissions.includes('*')) continue;

    for (const [first, second] of INCOMPATIBLE_GRANT_PAIRS) {
      if (permissions.includes(first) && permissions.includes(second)) {
        findings.push({ role, permissions: [first, second] });
      }
    }
  }

  return findings;
}
