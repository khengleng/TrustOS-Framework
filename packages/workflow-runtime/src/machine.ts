import {
  illegalTransition,
  type WorkflowAction,
  type WorkflowState,
} from '@trustsystem/workflow-core';
import {
  evaluateCondition,
  type WorkflowDefinitionDocument,
  type WorkflowStepSpec,
  type WorkflowTransitionSpec,
} from '@trustsystem/workflow-definition';

/**
 * The state machine.
 *
 * Pure, deterministic, and completely separate from persistence. Given a definition, a
 * current state, an action and instance data, `resolveTransition` returns the same
 * answer every time — no clock, no database, no actor lookup.
 *
 * That separation is the reason this file exists as its own module. The interesting
 * questions about a workflow engine — is this transition legal, which are available,
 * can this state be reached — are all answerable without a transaction, and answering
 * them in the same function that writes rows is how a state machine becomes untestable.
 *
 * Authorization is *not* here. Whether the actor may take a legal transition is a
 * separate question answered by `@trustsystem/workflow-policy`, and keeping the two apart
 * means "legal" and "permitted" cannot be confused: a transition can be legal and
 * refused, and a state machine that returned "not allowed" for both would make the
 * distinction invisible.
 */

/**
 * A definition, indexed for lookup.
 *
 * Built once per definition version and reusable across every instance of it. The maps
 * matter at scale: a linear scan of 200 transitions per transition attempt is fine for
 * one request and is measurable at a thousand a second, and the whole point of an
 * immutable published version is that this can be cached.
 */
export class CompiledWorkflow {
  readonly id: string;
  readonly version: string;
  readonly initialState: WorkflowState;
  readonly finalStates: ReadonlySet<WorkflowState>;
  readonly states: ReadonlySet<WorkflowState>;

  private readonly stepsByState: Map<WorkflowState, WorkflowStepSpec>;
  /** Keyed by `action::from`, matching the uniqueness the validator enforces. */
  private readonly transitionsByKey: Map<string, WorkflowTransitionSpec>;
  private readonly transitionsByFrom: Map<WorkflowState, WorkflowTransitionSpec[]>;

  constructor(readonly document: WorkflowDefinitionDocument) {
    this.id = document.id;
    this.version = document.version;
    this.initialState = document.initialState;
    this.finalStates = new Set(document.finalStates);
    this.states = new Set(document.states);

    this.stepsByState = new Map(document.steps.map((step) => [step.state, step]));
    this.transitionsByKey = new Map(
      document.transitions.map((transition) => [
        transitionKey(transition.action, transition.from),
        transition,
      ]),
    );

    this.transitionsByFrom = new Map();
    for (const transition of document.transitions) {
      const list = this.transitionsByFrom.get(transition.from) ?? [];
      list.push(transition);
      this.transitionsByFrom.set(transition.from, list);
    }
  }

  step(state: WorkflowState): WorkflowStepSpec | null {
    return this.stepsByState.get(state) ?? null;
  }

  isFinal(state: WorkflowState): boolean {
    return this.finalStates.has(state);
  }

  transition(action: WorkflowAction, from: WorkflowState): WorkflowTransitionSpec | null {
    return this.transitionsByKey.get(transitionKey(action, from)) ?? null;
  }

  transitionsFrom(state: WorkflowState): WorkflowTransitionSpec[] {
    return this.transitionsByFrom.get(state) ?? [];
  }
}

function transitionKey(action: WorkflowAction, from: WorkflowState): string {
  return `${action}::${from}`;
}

// --- resolution ------------------------------------------------------------

export interface ResolvedTransition {
  transition: WorkflowTransitionSpec;
  from: WorkflowState;
  to: WorkflowState;
  /** The step being left. Null when the state has none. */
  fromStep: WorkflowStepSpec | null;
  /** The step being entered. Null for a state with no step. */
  toStep: WorkflowStepSpec | null;
  /** True when the target is terminal. */
  completesWorkflow: boolean;
  /** Permission the definition attaches, for the policy layer to check. */
  requiredPermission: string | null;
}

/**
 * Finds the transition for an action, or explains why there is none.
 *
 * Throws `illegalTransition` with the list of *available* actions. Reporting what is
 * available is the difference between an error a developer can act on and one they have
 * to reverse-engineer — and it is safe: the definition is not a secret, and the caller
 * has already been scoped to the instance.
 *
 * A condition that does not hold makes a transition **unavailable**, not forbidden.
 * That is deliberate: from the caller's point of view "you cannot do this from here" and
 * "you cannot do this because the amount is too low" are the same class of answer, and
 * the second reveals the routing rules to somebody probing them.
 */
export function resolveTransition(input: {
  workflow: CompiledWorkflow;
  from: WorkflowState;
  action: WorkflowAction;
  data: Record<string, unknown>;
}): ResolvedTransition {
  const { workflow, from, action, data } = input;

  const transition = workflow.transition(action, from);

  if (!transition) {
    throw illegalTransition({
      from,
      action,
      available: availableActions({ workflow, from, data }),
    });
  }

  if (transition.condition && !evaluateCondition(transition.condition, data)) {
    throw illegalTransition({
      from,
      action,
      available: availableActions({ workflow, from, data }),
    });
  }

  return {
    transition,
    from,
    to: transition.to,
    fromStep: workflow.step(from),
    toStep: workflow.step(transition.to),
    completesWorkflow: workflow.isFinal(transition.to),
    requiredPermission: transition.permission ?? null,
  };
}

/**
 * Actions available from a state, given the data.
 *
 * Automatic transitions are excluded: they are the engine's, not an actor's, and
 * offering one in a UI would produce a request the runtime refuses.
 */
export function availableActions(input: {
  workflow: CompiledWorkflow;
  from: WorkflowState;
  data: Record<string, unknown>;
}): WorkflowAction[] {
  return [
    ...new Set(
      input.workflow
        .transitionsFrom(input.from)
        .filter((transition) => !transition.automatic)
        .filter(
          (transition) =>
            !transition.condition || evaluateCondition(transition.condition, input.data),
        )
        .map((transition) => transition.action),
    ),
  ];
}

/**
 * The automatic transition to follow from a state, if any.
 *
 * At most one, and the validator guarantees that: two unconditional automatic
 * transitions from one state is a validation error, because which one the engine took
 * would be arbitrary. Conditions may separate several, and the first whose condition
 * holds wins — with the definition order as the tie-break, which is why the validator
 * warns when conditions might overlap.
 */
export function nextAutomaticTransition(input: {
  workflow: CompiledWorkflow;
  from: WorkflowState;
  data: Record<string, unknown>;
}): WorkflowTransitionSpec | null {
  const candidates = input.workflow
    .transitionsFrom(input.from)
    .filter((transition) => transition.automatic);

  for (const candidate of candidates) {
    if (!candidate.condition) return candidate;
    if (evaluateCondition(candidate.condition, input.data)) return candidate;
  }

  return null;
}

/**
 * The chain of automatic transitions from a state.
 *
 * The runtime follows these after a manual transition, so `submit` landing in
 * `submitted` continues straight to `manager_review` without a second request.
 *
 * The iteration cap is a backstop, not the primary defence: `validateDefinition`
 * refuses a cycle of automatic transitions, so a published definition cannot loop. The
 * cap catches an unvalidated definition reaching the runtime — through a direct database
 * write, say — and it *throws* rather than stopping quietly, because silently halting
 * mid-chain would leave an instance in a state the definition says is transient.
 */
export const MAX_AUTOMATIC_CHAIN = 20;

export function followAutomaticChain(input: {
  workflow: CompiledWorkflow;
  from: WorkflowState;
  data: Record<string, unknown>;
}): Array<{ transition: WorkflowTransitionSpec; to: WorkflowState }> {
  const chain: Array<{ transition: WorkflowTransitionSpec; to: WorkflowState }> = [];
  let current = input.from;

  for (let step = 0; step < MAX_AUTOMATIC_CHAIN; step += 1) {
    const next = nextAutomaticTransition({
      workflow: input.workflow,
      from: current,
      data: input.data,
    });
    if (!next) return chain;

    chain.push({ transition: next, to: next.to });
    current = next.to;
  }

  throw new Error(
    `Automatic transitions from "${input.from}" did not settle within ${MAX_AUTOMATIC_CHAIN} ` +
      'steps in workflow ' +
      `${input.workflow.id} ${input.workflow.version}. A published definition cannot contain an ` +
      'automatic cycle — validateDefinition refuses one — so this definition was not validated. ' +
      'Refusing to loop.',
  );
}

// --- required data ---------------------------------------------------------

export interface MissingRequirement {
  kind: 'field' | 'attachment';
  field?: string;
  detail: string;
}

/**
 * Checks a step's requirements before leaving it.
 *
 * Fields and evidence. Both are checked on *exit* rather than on entry, which is the
 * only order that works: a step's whole purpose is for somebody to supply what it
 * requires, so requiring it on entry would make the step impossible to enter.
 *
 * Returns findings rather than throwing, so a portal can show a form with three fields
 * marked rather than one error at a time.
 */
export function checkStepRequirements(input: {
  step: WorkflowStepSpec | null;
  data: Record<string, unknown>;
  /** Whether the step has at least one live attachment. Supplied by the caller. */
  hasAttachment: boolean;
}): MissingRequirement[] {
  const { step, data } = input;
  if (!step) return [];

  const missing: MissingRequirement[] = [];

  for (const field of step.requiredFields) {
    const value = readPath(data, field);
    // Empty string counts as missing. A required justification submitted as `""` is
    // not a justification, and accepting it would make the requirement decorative.
    const absent = value === undefined || value === null || value === '';
    if (absent) {
      missing.push({
        kind: 'field',
        field,
        detail: `"${field}" is required before leaving "${step.state}".`,
      });
    }
  }

  const attachmentRequired =
    step.requireAttachment ||
    (step.requireAttachmentWhen ? evaluateCondition(step.requireAttachmentWhen, data) : false);

  if (attachmentRequired && !input.hasAttachment) {
    missing.push({
      kind: 'attachment',
      detail:
        `Step "${step.state}" requires supporting evidence` +
        (step.requireAttachmentWhen ? ' for a request of this kind' : '') +
        '.',
    });
  }

  return missing;
}

/**
 * Own-property path read.
 *
 * The same rule as the condition language: own properties only, so a required field
 * named `constructor` cannot be satisfied by an inherited value. Two independent
 * defences, because this is a boundary between caller-supplied data and a decision.
 */
function readPath(data: Record<string, unknown>, path: string): unknown {
  let current: unknown = data;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// --- editable fields -------------------------------------------------------

/**
 * Applies a data patch, keeping only what the current step permits.
 *
 * The returned `rejected` list is not decoration. A maker in `returned_for_rework` may
 * edit the amount; they may not edit `riskRating` if the definition does not say so,
 * because risk drives the approval path and letting the maker change it after a
 * rejection is a way to route around compliance.
 *
 * Silently dropping the disallowed fields would be worse than refusing: the maker would
 * believe the change was saved.
 */
export function applyEditableFields(input: {
  step: WorkflowStepSpec | null;
  current: Record<string, unknown>;
  patch: Record<string, unknown>;
}): { data: Record<string, unknown>; applied: string[]; rejected: string[] } {
  const allowed = new Set(input.step?.editableFields ?? []);
  const data = { ...input.current };
  const applied: string[] = [];
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(input.patch)) {
    // Top-level keys only. A dotted path would let `a.b` be permitted while `a`
    // was not, and the check would then depend on how the caller spelled it.
    if (allowed.has(key)) {
      data[key] = value;
      applied.push(key);
    } else {
      rejected.push(key);
    }
  }

  return { data, applied, rejected };
}

// --- inspection ------------------------------------------------------------

/**
 * A state's shape, for a portal.
 *
 * Everything a UI needs to render "what can I do here" in one call, so it does not
 * assemble the answer from four requests and get it subtly wrong.
 */
export function describeState(input: {
  workflow: CompiledWorkflow;
  state: WorkflowState;
  data: Record<string, unknown>;
}): {
  state: WorkflowState;
  isFinal: boolean;
  stepKind: string | null;
  stepName: string | null;
  availableActions: WorkflowAction[];
  requiresApproval: boolean;
  approvalModel: string | null;
  requiredFields: string[];
  editableFields: string[];
  hasAutomaticExit: boolean;
} {
  const step = input.workflow.step(input.state);

  return {
    state: input.state,
    isFinal: input.workflow.isFinal(input.state),
    stepKind: step?.kind ?? null,
    stepName: step?.name ?? null,
    availableActions: availableActions({
      workflow: input.workflow,
      from: input.state,
      data: input.data,
    }),
    requiresApproval: Boolean(step?.approval),
    approvalModel: step?.approval?.model ?? null,
    requiredFields: step?.requiredFields ?? [],
    editableFields: step?.editableFields ?? [],
    hasAutomaticExit:
      nextAutomaticTransition({
        workflow: input.workflow,
        from: input.state,
        data: input.data,
      }) !== null,
  };
}

/**
 * A cache of compiled definitions.
 *
 * Safe precisely because a published version is immutable: the compiled form of version
 * 1.0.0 can never become stale, so there is no invalidation to get wrong. That is the
 * performance payoff of the immutability rule, and it is why the cache is keyed by
 * version id rather than by definition key.
 *
 * Bounded, because an organization with many workflow versions would otherwise hold
 * every one it has ever run in memory.
 */
export class CompiledWorkflowCache {
  private readonly entries = new Map<string, CompiledWorkflow>();

  constructor(private readonly capacity = 200) {}

  get(versionId: string): CompiledWorkflow | null {
    const entry = this.entries.get(versionId);
    if (!entry) return null;

    // Re-inserted to make it the most recent, so the eviction below is least-recently
    // used rather than insertion order.
    this.entries.delete(versionId);
    this.entries.set(versionId, entry);
    return entry;
  }

  set(versionId: string, workflow: CompiledWorkflow): void {
    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(versionId, workflow);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
