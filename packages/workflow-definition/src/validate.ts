import { ApiError } from '@trustos/errors';
import { conditionFields, describeCondition } from './conditions';
import {
  BUILT_IN_ASSIGNMENT_STRATEGIES,
  workflowDefinitionDocumentSchema,
  type WorkflowDefinitionDocument,
} from './schema';

/**
 * Definition validation.
 *
 * The schema in `schema.ts` checks shapes; this checks the *graph*. They are
 * separate because they fail differently: a bad shape is a typo the author fixes in
 * seconds, and a bad graph is a workflow that publishes cleanly and then strands a
 * request in a state nothing can leave.
 *
 * Findings are `error` or `warning`, and the distinction is load-bearing:
 *
 *   * **error** — the definition cannot work, or works in a way that removes a
 *     control. Publication is refused.
 *   * **warning** — the definition works and something about it deserves a human's
 *     attention. `allowSelfApproval: true` is the archetype: legitimate in a
 *     two-person team, and never something that should pass review unnoticed.
 *
 * Warnings do not block publication, deliberately. A validator that refused
 * everything questionable would be one whose output people learn to bypass, and the
 * bypass would take the errors with it.
 */

export type FindingSeverity = 'error' | 'warning';

export interface ValidationFinding {
  severity: FindingSeverity;
  /** Stable code, so a test asserts on this rather than on wording. */
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  findings: ValidationFinding[];
  /** Present when the document parsed. Absent when the shape itself was wrong. */
  document?: WorkflowDefinitionDocument;
}

export interface ValidateOptions {
  /**
   * Permission keys the application recognises.
   *
   * When supplied, a definition referencing an unknown permission is an **error**.
   * A workflow whose approver permission is misspelled is one nobody can ever
   * approve, and the misspelling is invisible until the first request stalls.
   *
   * Omitted, the check is skipped with a warning — the CLI validating a file has no
   * application to ask.
   */
  knownPermissions?: string[];
  /** Assignment resolver keys the application has registered. */
  registeredResolvers?: string[];
  /** Escalation callback keys the application has registered. */
  registeredCallbacks?: string[];
  /** Calendar ids the application has registered. `elapsed` is always available. */
  registeredCalendars?: string[];
}

export function validateDefinition(
  input: unknown,
  options: ValidateOptions = {},
): ValidationResult {
  const parsed = workflowDefinitionDocumentSchema.safeParse(input);

  if (!parsed.success) {
    return {
      valid: false,
      findings: parsed.error.issues.map((issue) => ({
        severity: 'error' as const,
        code: 'schema',
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    };
  }

  const document = parsed.data;
  const findings: ValidationFinding[] = [
    ...checkStates(document),
    ...checkTransitions(document),
    ...checkReachability(document),
    ...checkDeadEnds(document),
    ...checkAutomaticCycles(document),
    ...checkSteps(document),
    ...checkApprovals(document),
    ...checkReferences(document, options),
    ...checkConditions(document),
    ...checkSlaAndEscalation(document, options),
  ];

  return {
    valid: !findings.some((finding) => finding.severity === 'error'),
    findings,
    document,
  };
}

// --- 1. states -------------------------------------------------------------

function checkStates(document: WorkflowDefinitionDocument): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const states = new Set(document.states);

  if (states.size !== document.states.length) {
    const seen = new Set<string>();
    const duplicates = document.states.filter((state) => !seen.add(state) && true);
    findings.push({
      severity: 'error',
      code: 'duplicate_state',
      path: 'states',
      message: `Duplicate state(s): ${[...new Set(duplicates)].join(', ')}.`,
    });
  }

  if (!states.has(document.initialState)) {
    findings.push({
      severity: 'error',
      code: 'missing_initial_state',
      path: 'initialState',
      message: `The initial state "${document.initialState}" is not in "states".`,
    });
  }

  for (const final of document.finalStates) {
    if (!states.has(final)) {
      findings.push({
        severity: 'error',
        code: 'unknown_final_state',
        path: 'finalStates',
        message: `The final state "${final}" is not in "states".`,
      });
    }
  }

  // An initial state that is also final is a workflow that is complete the moment
  // it starts. Almost certainly a copy-paste, and harmless to refuse.
  if (document.finalStates.includes(document.initialState)) {
    findings.push({
      severity: 'error',
      code: 'initial_state_is_final',
      path: 'initialState',
      message:
        `"${document.initialState}" is both the initial and a final state, so every instance ` +
        'would be complete on creation.',
    });
  }

  return findings;
}

// --- 2. transitions --------------------------------------------------------

function checkTransitions(document: WorkflowDefinitionDocument): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const states = new Set(document.states);

  // Uniqueness is per (action, from), not per action: `approve` legitimately exists
  // from `manager_review` and from `compliance_review`. What must be unique is the
  // pair, because two transitions with the same action from the same state make the
  // engine's choice arbitrary.
  const pairs = new Map<string, number>();

  document.transitions.forEach((transition, index) => {
    const path = `transitions[${index}]`;

    if (!states.has(transition.from)) {
      findings.push({
        severity: 'error',
        code: 'unknown_transition_state',
        path: `${path}.from`,
        message: `"${transition.from}" is not a declared state.`,
      });
    }
    if (!states.has(transition.to)) {
      findings.push({
        severity: 'error',
        code: 'unknown_transition_state',
        path: `${path}.to`,
        message: `"${transition.to}" is not a declared state.`,
      });
    }

    const key = `${transition.action}::${transition.from}`;
    const previous = pairs.get(key);
    if (previous !== undefined) {
      findings.push({
        severity: 'error',
        code: 'duplicate_transition',
        path: `${path}.action`,
        message:
          `The action "${transition.action}" is already defined from "${transition.from}" ` +
          `at transitions[${previous}]. Which one applies would be arbitrary.`,
      });
    } else {
      pairs.set(key, index);
    }

    // A transition out of a final state contradicts the state being final. One of
    // the two is wrong and the engine cannot tell which.
    if (document.finalStates.includes(transition.from)) {
      findings.push({
        severity: 'error',
        code: 'transition_from_final_state',
        path: `${path}.from`,
        message:
          `"${transition.from}" is declared final but has the outgoing action ` +
          `"${transition.action}". Remove one of the two.`,
      });
    }
  });

  return findings;
}

// --- 3. reachability -------------------------------------------------------

/**
 * Every state must be reachable from the initial state.
 *
 * An unreachable state is dead configuration, and dead configuration in an approval
 * workflow is worse than in most places: it usually means a review step somebody
 * believes exists. Breadth-first from the initial state, ignoring conditions —
 * a conditional transition still makes its target reachable.
 */
function checkReachability(document: WorkflowDefinitionDocument): ValidationFinding[] {
  const outgoing = new Map<string, string[]>();
  for (const transition of document.transitions) {
    const targets = outgoing.get(transition.from) ?? [];
    targets.push(transition.to);
    outgoing.set(transition.from, targets);
  }

  const reached = new Set<string>([document.initialState]);
  const queue = [document.initialState];

  while (queue.length > 0) {
    const state = queue.shift() as string;
    for (const next of outgoing.get(state) ?? []) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }

  const unreachable = document.states.filter((state) => !reached.has(state));

  return unreachable.length === 0
    ? []
    : [
        {
          severity: 'error',
          code: 'unreachable_state',
          path: 'states',
          message:
            `Unreachable from "${document.initialState}": ${unreachable.join(', ')}. ` +
            'An unreachable state is usually a review step somebody thinks exists.',
        },
      ];
}

// --- 4. dead ends ----------------------------------------------------------

/**
 * A non-final state with no way out is where a request goes to die.
 *
 * The instance sits there, the SLA breaches, escalation fires, and nobody can move
 * it — because there is no action that would. This is the single most valuable check
 * in the file: it is invisible on inspection of a 40-state definition and obvious to
 * a graph walk.
 */
function checkDeadEnds(document: WorkflowDefinitionDocument): ValidationFinding[] {
  const hasExit = new Set(document.transitions.map((transition) => transition.from));
  const finals = new Set(document.finalStates);

  const deadEnds = document.states.filter((state) => !finals.has(state) && !hasExit.has(state));

  if (deadEnds.length === 0) return [];

  return [
    {
      severity: 'error',
      code: 'dead_end_state',
      path: 'states',
      message:
        `No transition leaves ${deadEnds.map((state) => `"${state}"`).join(', ')}, and ` +
        'neither is a final state. An instance reaching one could never move again.',
    },
  ];
}

// --- 5. automatic cycles ---------------------------------------------------

/**
 * A cycle of automatic transitions is an infinite loop in the runtime.
 *
 * The runtime follows automatic transitions until it reaches a state with none.
 * Given `a -auto-> b -auto-> a`, it never stops. Catching it here is much better
 * than defending in the runtime with an iteration cap: a cap turns an authoring
 * mistake into a mysterious runtime error, and this turns it into a validation
 * message naming the cycle.
 *
 * Depth-first with a colouring, which is the standard cycle detection: grey means
 * "on the current path", so an edge back to a grey node is a cycle.
 */
function checkAutomaticCycles(document: WorkflowDefinitionDocument): ValidationFinding[] {
  const automatic = new Map<string, string[]>();
  for (const transition of document.transitions) {
    if (!transition.automatic) continue;
    const targets = automatic.get(transition.from) ?? [];
    targets.push(transition.to);
    automatic.set(transition.from, targets);
  }

  if (automatic.size === 0) return [];

  const findings: ValidationFinding[] = [];
  const state = new Map<string, 'grey' | 'black'>();
  const path: string[] = [];

  const visit = (node: string): void => {
    state.set(node, 'grey');
    path.push(node);

    for (const next of automatic.get(node) ?? []) {
      const colour = state.get(next);
      if (colour === 'grey') {
        const start = path.indexOf(next);
        findings.push({
          severity: 'error',
          code: 'automatic_cycle',
          path: 'transitions',
          message:
            'Automatic transitions form a cycle: ' +
            `${[...path.slice(start), next].join(' -> ')}. The runtime would never stop.`,
        });
        continue;
      }
      if (colour === undefined) visit(next);
    }

    path.pop();
    state.set(node, 'black');
  };

  for (const node of automatic.keys()) {
    if (!state.has(node)) visit(node);
  }

  // Two automatic transitions out of one state make the engine's choice arbitrary
  // unless conditions separate them — and if the conditions overlap, it is arbitrary
  // anyway. A warning rather than an error: mutually exclusive conditions are a
  // legitimate branch, and the validator cannot prove exclusivity.
  for (const [from, targets] of automatic) {
    if (targets.length <= 1) continue;
    const unconditional = document.transitions.filter(
      (transition) => transition.automatic && transition.from === from && !transition.condition,
    );
    if (unconditional.length > 1) {
      findings.push({
        severity: 'error',
        code: 'ambiguous_automatic_transition',
        path: 'transitions',
        message:
          `"${from}" has ${unconditional.length} unconditional automatic transitions. ` +
          'Which one the engine takes would be arbitrary; add conditions.',
      });
    } else {
      findings.push({
        severity: 'warning',
        code: 'conditional_automatic_branch',
        path: 'transitions',
        message:
          `"${from}" has several automatic transitions separated by conditions. Verify the ` +
          'conditions are mutually exclusive — overlapping ones make the choice arbitrary.',
      });
    }
  }

  return findings;
}

// --- 6. steps --------------------------------------------------------------

function checkSteps(document: WorkflowDefinitionDocument): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const states = new Set(document.states);
  const byState = new Map<string, number>();

  document.steps.forEach((step, index) => {
    const path = `steps[${index}]`;

    if (!states.has(step.state)) {
      findings.push({
        severity: 'error',
        code: 'unknown_step_state',
        path: `${path}.state`,
        message: `"${step.state}" is not a declared state.`,
      });
    }

    const previous = byState.get(step.state);
    if (previous !== undefined) {
      findings.push({
        severity: 'error',
        code: 'duplicate_step',
        path: `${path}.state`,
        message: `"${step.state}" already has a step at steps[${previous}]. One step per state.`,
      });
    } else {
      byState.set(step.state, index);
    }

    // An actionable step with no assignment produces a task nobody is eligible for,
    // which appears in no queue and is completed by nobody.
    if ((step.kind === 'task' || step.kind === 'approval') && !step.assignment) {
      const hasApprovers = step.kind === 'approval' && step.approval;
      if (!hasApprovers) {
        findings.push({
          severity: 'error',
          code: 'step_without_assignment',
          path: `${path}.assignment`,
          message:
            `Step "${step.state}" is actionable but has neither an assignment nor approvers, ` +
            'so its task would appear in nobody’s queue.',
        });
      }
    }

    if (step.kind === 'terminal' && !document.finalStates.includes(step.state)) {
      findings.push({
        severity: 'error',
        code: 'terminal_step_not_final',
        path: `${path}.kind`,
        message: `Step "${step.state}" is terminal but "${step.state}" is not in "finalStates".`,
      });
    }

    if (step.kind === 'automatic') {
      const hasAutomatic = document.transitions.some(
        (transition) => transition.from === step.state && transition.automatic,
      );
      if (!hasAutomatic) {
        findings.push({
          severity: 'error',
          code: 'automatic_step_without_transition',
          path: `${path}.kind`,
          message:
            `Step "${step.state}" is automatic but no automatic transition leaves it, so the ` +
            'engine would stop there waiting for an actor that never comes.',
        });
      }
    }
  });

  // A state with no step is a state the engine has no instructions for. Warning
  // rather than error: a pass-through state reachable only by a transition that
  // continues straight through it is unusual but not broken.
  for (const state of document.states) {
    if (byState.has(state)) continue;
    if (document.finalStates.includes(state)) continue;
    findings.push({
      severity: 'warning',
      code: 'state_without_step',
      path: 'steps',
      message:
        `"${state}" has no step, so no task is created and no SLA applies while an instance ` +
        'is in it.',
    });
  }

  return findings;
}

// --- 7. approvals ----------------------------------------------------------

function checkApprovals(document: WorkflowDefinitionDocument): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  document.steps.forEach((step, index) => {
    if (!step.approval) return;
    const path = `steps[${index}].approval`;
    const approval = step.approval;

    const keys = new Set<string>();
    approval.approvers.forEach((approver, approverIndex) => {
      if (keys.has(approver.key)) {
        findings.push({
          severity: 'error',
          code: 'duplicate_approver_key',
          path: `${path}.approvers[${approverIndex}].key`,
          message: `Approver key "${approver.key}" is used twice in step "${step.state}".`,
        });
      }
      keys.add(approver.key);
    });

    /*
     * The framework's central default, surfaced for review.
     *
     * A warning and not an error: a two-person team may legitimately accept it, and
     * refusing outright would push them to work around the engine. But it must
     * never pass unnoticed, so it is reported every time and the portal shows it.
     */
    if (approval.allowSelfApproval) {
      findings.push({
        severity: 'warning',
        code: 'self_approval_permitted',
        path: `${path}.allowSelfApproval`,
        message:
          `Step "${step.state}" permits the submitter to approve their own request. This ` +
          'removes the maker-checker control. Confirm it is intended and recorded.',
      });
    }

    if (approval.allowSameActorMultipleSlots) {
      findings.push({
        severity: 'warning',
        code: 'same_actor_multiple_slots',
        path: `${path}.allowSameActorMultipleSlots`,
        message:
          `Step "${step.state}" lets one actor fill several approver slots, so a threshold of ` +
          'N can be met by one person acting N times.',
      });
    }

    // A threshold equal to the approver count is a unanimous model spelled the long
    // way. Not wrong, but the explicit model is clearer to an auditor.
    if (approval.model === 'threshold' && approval.threshold === approval.approvers.length) {
      findings.push({
        severity: 'warning',
        code: 'threshold_equals_unanimous',
        path: `${path}.threshold`,
        message:
          `Step "${step.state}" requires all ${approval.threshold} approvers. Use the ` +
          '"unanimous" model to say so directly.',
      });
    }

    /*
     * An approval step with one approver and one permission means a single person
     * is the whole control. Worth a human's attention on anything consequential,
     * and cheap to say.
     */
    if (approval.model === 'single' || approval.approvers.length === 1) {
      findings.push({
        severity: 'warning',
        code: 'single_point_of_approval',
        path: `${path}.approvers`,
        message:
          `Step "${step.state}" is approved by one person holding ` +
          `"${approval.approvers[0]?.permission}". For a consequential decision, consider a ` +
          'threshold or a second approver.',
      });
    }
  });

  return findings;
}

// --- 8. references ---------------------------------------------------------

function checkReferences(
  document: WorkflowDefinitionDocument,
  options: ValidateOptions,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const known = options.knownPermissions;

  const checkPermission = (permission: string | undefined, path: string): void => {
    if (!permission) return;
    if (!known) return;
    if (!known.includes(permission)) {
      findings.push({
        severity: 'error',
        code: 'unknown_permission',
        path,
        message:
          `"${permission}" is not a permission this application defines. A misspelled approver ` +
          'permission is a step nobody can ever act on.',
      });
    }
  };

  if (!known) {
    findings.push({
      severity: 'warning',
      code: 'permissions_unchecked',
      path: '(root)',
      message:
        'Permission references were not checked because no permission catalog was supplied. ' +
        'Validate against the application before publishing.',
    });
  }

  checkPermission(document.startPermission, 'startPermission');
  checkPermission(document.cancellation.permission, 'cancellation.permission');

  document.transitions.forEach((transition, index) => {
    checkPermission(transition.permission, `transitions[${index}].permission`);
  });

  document.steps.forEach((step, index) => {
    step.approval?.approvers.forEach((approver, approverIndex) => {
      checkPermission(
        approver.permission,
        `steps[${index}].approval.approvers[${approverIndex}].permission`,
      );
    });

    // A declared-only assignment strategy without a registered resolver is a step
    // whose assignee cannot be computed. Better to fail at publication than at the
    // first instance.
    const strategy = step.assignment?.strategy;
    if (strategy && !BUILT_IN_ASSIGNMENT_STRATEGIES.includes(strategy)) {
      const resolvers = options.registeredResolvers;
      const key = step.assignment?.resolverKey ?? strategy;
      if (resolvers && !resolvers.includes(key)) {
        findings.push({
          severity: 'error',
          code: 'unregistered_resolver',
          path: `steps[${index}].assignment.strategy`,
          message:
            `The "${strategy}" strategy needs an assignee resolver registered under "${key}". ` +
            'The framework implements named_user, role, group and round_robin only.',
        });
      } else if (!resolvers) {
        findings.push({
          severity: 'warning',
          code: 'resolver_unchecked',
          path: `steps[${index}].assignment.strategy`,
          message:
            `The "${strategy}" strategy requires an application-supplied resolver. Confirm one ` +
            `is registered under "${key}".`,
        });
      }
    }
  });

  // The rejection policy's route target has to exist, or a rejection strands the
  // instance.
  if (document.rejection.behaviour === 'route_to_step' && document.rejection.routeToState) {
    if (!document.states.includes(document.rejection.routeToState)) {
      findings.push({
        severity: 'error',
        code: 'unknown_rejection_route',
        path: 'rejection.routeToState',
        message: `"${document.rejection.routeToState}" is not a declared state.`,
      });
    }
  }

  for (const state of document.cancellation.allowedFromStates) {
    if (!document.states.includes(state)) {
      findings.push({
        severity: 'error',
        code: 'unknown_cancellation_state',
        path: 'cancellation.allowedFromStates',
        message: `"${state}" is not a declared state.`,
      });
    }
  }

  return findings;
}

// --- 9. conditions ---------------------------------------------------------

/**
 * Conditions are already shape-validated by the schema, so what is left is whether
 * they read fields anything sets.
 *
 * A condition on `riskRatng` (sic) is syntactically perfect and always false, which
 * means a compliance review that never happens. The check is a warning rather than
 * an error because instance data is caller-supplied and a definition cannot know
 * every field a product will pass — but a field that no step declares and no other
 * condition mentions is almost always a typo.
 */
function checkConditions(document: WorkflowDefinitionDocument): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  const declared = new Set<string>();
  for (const step of document.steps) {
    step.requiredFields.forEach((field) => declared.add(field));
    step.editableFields.forEach((field) => declared.add(field));
  }

  const referenced = new Map<string, string[]>();
  const record = (field: string, path: string): void => {
    const paths = referenced.get(field) ?? [];
    paths.push(path);
    referenced.set(field, paths);
  };

  document.transitions.forEach((transition, index) => {
    if (!transition.condition) return;
    conditionFields(transition.condition).forEach((field) =>
      record(field, `transitions[${index}].condition`),
    );
  });

  document.steps.forEach((step, index) => {
    if (step.requireAttachmentWhen) {
      conditionFields(step.requireAttachmentWhen).forEach((field) =>
        record(field, `steps[${index}].requireAttachmentWhen`),
      );
    }
    step.approval?.approvers.forEach((approver, approverIndex) => {
      if (!approver.condition) return;
      conditionFields(approver.condition).forEach((field) =>
        record(field, `steps[${index}].approval.approvers[${approverIndex}].condition`),
      );
    });
    step.escalations.forEach((escalation, escalationIndex) => {
      if (!escalation.condition) return;
      conditionFields(escalation.condition).forEach((field) =>
        record(field, `steps[${index}].escalations[${escalationIndex}].condition`),
      );
    });
  });

  for (const [field, paths] of referenced) {
    if (declared.has(field)) continue;
    // Only report a field referenced exactly once. A field used by several
    // conditions is evidently a real part of the product's data model even if no
    // step declares it; one used once is where a typo lives.
    if (paths.length > 1) continue;
    findings.push({
      severity: 'warning',
      code: 'condition_field_undeclared',
      path: paths[0] as string,
      message:
        `The condition reads "${field}", which no step declares in requiredFields or ` +
        'editableFields and no other condition uses. If it is a typo, this branch is never ' +
        'taken.',
    });
  }

  return findings;
}

// --- 10. SLA and escalation ------------------------------------------------

function checkSlaAndEscalation(
  document: WorkflowDefinitionDocument,
  options: ValidateOptions,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const calendars = new Set(['elapsed', ...(options.registeredCalendars ?? [])]);
  const callbacks = options.registeredCallbacks;

  const checkCalendar = (calendar: string, path: string): void => {
    if (!calendars.has(calendar)) {
      findings.push({
        severity: 'error',
        code: 'unknown_calendar',
        path,
        message:
          `"${calendar}" is not a registered calendar. The framework ships "elapsed"; anything ` +
          'else must be registered by the application.',
      });
    }
  };

  document.sla.forEach((rule, index) => checkCalendar(rule.calendar, `sla[${index}].calendar`));

  document.steps.forEach((step, index) => {
    step.sla.forEach((rule, ruleIndex) =>
      checkCalendar(rule.calendar, `steps[${index}].sla[${ruleIndex}].calendar`),
    );

    // An SLA with no escalation is a deadline nobody is told about. The clock runs,
    // the status turns red on a dashboard, and nothing happens.
    if (step.sla.length > 0 && step.escalations.length === 0) {
      findings.push({
        severity: 'warning',
        code: 'sla_without_escalation',
        path: `steps[${index}].escalations`,
        message:
          `Step "${step.state}" has an SLA but no escalation, so a breach changes a status and ` +
          'notifies nobody.',
      });
    }

    step.escalations.forEach((escalation, escalationIndex) => {
      const path = `steps[${index}].escalations[${escalationIndex}]`;

      if (escalation.action === 'callback' && escalation.callbackKey) {
        if (callbacks && !callbacks.includes(escalation.callbackKey)) {
          findings.push({
            severity: 'error',
            code: 'unregistered_callback',
            path: `${path}.callbackKey`,
            message: `No escalation callback is registered under "${escalation.callbackKey}".`,
          });
        }
      }

      // Two rules with the same trigger and action on one step fire twice for one
      // breach. Idempotency keys collapse them, so the second is silently skipped —
      // which means the author's intent is unclear rather than wrong.
      const twin = step.escalations.findIndex(
        (other, otherIndex) =>
          otherIndex < escalationIndex &&
          other.trigger === escalation.trigger &&
          other.action === escalation.action &&
          !other.condition &&
          !escalation.condition,
      );
      if (twin >= 0) {
        findings.push({
          severity: 'warning',
          code: 'duplicate_escalation',
          path: `${path}.action`,
          message:
            `This repeats escalations[${twin}] on step "${step.state}". Idempotency will skip ` +
            'the second one; remove it or give the two different conditions.',
        });
      }
    });
  });

  return findings;
}

// --- helpers ---------------------------------------------------------------

/**
 * Validates, or throws.
 *
 * For the publication path, where a definition must not proceed. Warnings are
 * dropped from the thrown error and reported separately by the caller — an error
 * listing eleven warnings alongside one error buries the thing that has to be fixed.
 */
export function assertValidDefinition(
  input: unknown,
  options: ValidateOptions = {},
): WorkflowDefinitionDocument {
  const result = validateDefinition(input, options);

  if (!result.valid) {
    throw ApiError.validation(
      result.findings
        .filter((finding) => finding.severity === 'error')
        .map((finding) => ({
          path: finding.path,
          message: finding.message,
          code: finding.code,
        })),
      'This workflow definition is not valid.',
    );
  }

  return result.document as WorkflowDefinitionDocument;
}

/** Renders findings for a terminal. Used by `trustos workflow validate`. */
export function formatFindings(findings: ValidationFinding[]): string[] {
  return findings.map(
    (finding) =>
      `${finding.severity === 'error' ? 'error' : 'warn '}  ${finding.path}  ${finding.message}` +
      `  [${finding.code}]`,
  );
}

/** Human-readable summary of the conditions in a definition, for the portal. */
export function describeDefinitionConditions(
  document: WorkflowDefinitionDocument,
): Array<{ path: string; condition: string }> {
  const described: Array<{ path: string; condition: string }> = [];

  document.transitions.forEach((transition, index) => {
    if (transition.condition) {
      described.push({
        path: `${transition.action} (${transition.from} -> ${transition.to})`,
        condition: describeCondition(transition.condition),
      });
    }
    void index;
  });

  document.steps.forEach((step) => {
    step.approval?.approvers.forEach((approver) => {
      if (approver.condition) {
        described.push({
          path: `${step.state} / approver ${approver.key}`,
          condition: describeCondition(approver.condition),
        });
      }
    });
    if (step.requireAttachmentWhen) {
      described.push({
        path: `${step.state} / attachment required`,
        condition: describeCondition(step.requireAttachmentWhen),
      });
    }
  });

  return described;
}
