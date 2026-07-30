import { describeCondition } from './conditions';
import { validateDefinition, type ValidationFinding } from './validate';
import type { WorkflowDefinitionDocument } from './schema';

/**
 * Static analysis of a definition.
 *
 * "Simulation" here means walking the graph, not running a workflow. It touches no
 * database, creates no instance, sends no notification and needs no actor — so
 * `trustos workflow simulate` is safe to run against a production definition file,
 * which is the point: the tool has to be usable at the moment somebody is deciding
 * whether to publish.
 *
 * It answers the questions a reviewer actually asks, which a JSON document does not:
 * how does a request reach "approved", who has to act, what could hold it up, and is
 * there a path that skips a control.
 */

export interface SimulatedPath {
  /** States in order. */
  states: string[];
  /** Actions taken, in order. */
  actions: string[];
  /** Where this path ends. */
  terminal: string;
  /** True when the terminal is a declared final state. */
  reachesFinalState: boolean;
  /** Approvals required along the way, in order of encounter. */
  approvals: Array<{ state: string; model: string; required: number; permissions: string[] }>;
  /** Conditions that had to hold. */
  conditions: string[];
  /** Total of every SLA on the path, in minutes. */
  slaMinutes: number;
  /** True when no approval step appears on the path. */
  unapproved: boolean;
  /**
   * How the path ended.
   *
   * `cancelled` and `rejected` are not failures of review: a cancellation is a withdrawal
   * and a rejection *is* a decision. Only a path that reaches a success terminal with no
   * approval is a missing control — see `unapprovedPaths`.
   */
  outcome: 'approved' | 'rejected' | 'cancelled' | 'incomplete';
}

export interface SimulationResult {
  definition: { id: string; version: string; name: string };
  valid: boolean;
  findings: ValidationFinding[];
  paths: SimulatedPath[];
  /** States no path reaches. */
  unreachableStates: string[];
  /** Non-final states with no way out. */
  deadEnds: string[];
  /** Final states no path reaches — an outcome that can never happen. */
  unreachableOutcomes: string[];
  /**
   * Paths that reach a *success* terminal having required no approval.
   *
   * Deliberately excludes cancellation and rejection paths. An earlier version counted
   * them, which reported three findings on the framework's own example — and a check that
   * fires on correct definitions is one people learn to ignore, taking the real findings
   * with it.
   */
  unapprovedPaths: SimulatedPath[];
  /** Separation-of-duty concerns found by walking, not by schema. */
  separationOfDutyConcerns: string[];
  /** Where the clock could run out, longest first. */
  slaRisks: Array<{ state: string; kind: string; minutes: number; hasEscalation: boolean }>;
  /** Every distinct permission the workflow requires of somebody. */
  requiredPermissions: string[];
  /** Instance-data fields the definition reads. */
  requiredData: string[];
  truncated: boolean;
}

/**
 * Paths enumerated before giving up.
 *
 * A cyclic definition — rework loops back to draft, which is normal and correct —
 * has infinitely many paths, so enumeration has to be bounded. The bound is
 * reported as `truncated` rather than hidden, because a simulation that silently
 * examined 5% of a workflow and said "looks fine" would be worse than no simulation.
 */
const MAX_PATHS = 200;
const MAX_PATH_LENGTH = 40;

export function simulateDefinition(input: unknown): SimulationResult {
  const validation = validateDefinition(input);

  if (!validation.document) {
    return {
      definition: { id: 'unknown', version: 'unknown', name: 'unknown' },
      valid: false,
      findings: validation.findings,
      paths: [],
      unreachableStates: [],
      deadEnds: [],
      unreachableOutcomes: [],
      unapprovedPaths: [],
      separationOfDutyConcerns: [],
      slaRisks: [],
      requiredPermissions: [],
      requiredData: [],
      truncated: false,
    };
  }

  const document = validation.document;
  const paths = enumeratePaths(document);
  const visited = new Set(paths.flatMap((path) => path.states));

  return {
    definition: { id: document.id, version: document.version, name: document.name },
    valid: validation.valid,
    findings: validation.findings,
    paths: paths.entries,
    unreachableStates: document.states.filter((state) => !visited.has(state)),
    deadEnds: findDeadEnds(document),
    unreachableOutcomes: document.finalStates.filter(
      (state) => !paths.entries.some((path) => path.terminal === state),
    ),
    // Only a path to a *success* terminal counts. A cancellation is a withdrawal and a
    // rejection is itself a decision; neither is a missing review.
    unapprovedPaths: paths.entries.filter(
      (path) => path.reachesFinalState && path.unapproved && path.outcome === 'approved',
    ),
    separationOfDutyConcerns: findSeparationConcerns(document),
    slaRisks: findSlaRisks(document),
    requiredPermissions: collectPermissions(document),
    requiredData: collectDataFields(document),
    truncated: paths.truncated,
  };
}

// --- path enumeration ------------------------------------------------------

function enumeratePaths(document: WorkflowDefinitionDocument): {
  entries: SimulatedPath[];
  truncated: boolean;
  flatMap: <T>(fn: (path: SimulatedPath) => T[]) => T[];
} {
  const stepsByState = new Map(document.steps.map((step) => [step.state, step]));
  const finals = new Set(document.finalStates);
  const entries: SimulatedPath[] = [];
  let truncated = false;

  const walk = (
    state: string,
    states: string[],
    actions: string[],
    conditions: string[],
    approvals: SimulatedPath['approvals'],
    slaMinutes: number,
    /*
     * Visited edges, not visited states.
     *
     * A rework loop revisits `draft` legitimately, so blocking revisited states
     * would hide every path through a rework cycle — which is most of the
     * interesting ones. Blocking a repeated *edge* still terminates, and lets a
     * path pass through a state twice.
     */
    usedEdges: Set<string>,
  ): void => {
    if (entries.length >= MAX_PATHS || states.length >= MAX_PATH_LENGTH) {
      truncated = true;
      return;
    }

    const outgoing = document.transitions.filter((transition) => transition.from === state);

    if (outgoing.length === 0 || finals.has(state)) {
      entries.push({
        states: [...states],
        actions: [...actions],
        terminal: state,
        reachesFinalState: finals.has(state),
        approvals: [...approvals],
        conditions: [...conditions],
        slaMinutes,
        unapproved: approvals.length === 0,
        outcome: outcomeFor(document, state, actions, finals),
      });
      return;
    }

    let advanced = false;

    for (const transition of outgoing) {
      const edge = `${transition.action}:${transition.from}->${transition.to}`;
      if (usedEdges.has(edge)) continue;
      advanced = true;

      const step = stepsByState.get(transition.to);
      const nextApprovals = [...approvals];

      if (step?.approval) {
        nextApprovals.push({
          state: step.state,
          model: step.approval.model,
          required:
            step.approval.model === 'threshold'
              ? (step.approval.threshold ?? 1)
              : step.approval.model === 'unanimous' || step.approval.model === 'sequential'
                ? step.approval.approvers.length
                : 1,
          permissions: [...new Set(step.approval.approvers.map((approver) => approver.permission))],
        });
      }

      const stepSla = (step?.sla ?? []).reduce((total, rule) => total + rule.minutes, 0);

      walk(
        transition.to,
        [...states, transition.to],
        [...actions, transition.action],
        transition.condition
          ? [...conditions, `${transition.action}: ${describeCondition(transition.condition)}`]
          : conditions,
        nextApprovals,
        slaMinutes + stepSla,
        new Set([...usedEdges, edge]),
      );
    }

    // Every outgoing edge was already used on this path, so this is where it ends.
    // Recorded rather than dropped: it is a real terminal for this walk, and a
    // non-final one is worth seeing.
    if (!advanced) {
      entries.push({
        states: [...states],
        actions: [...actions],
        terminal: state,
        reachesFinalState: finals.has(state),
        approvals: [...approvals],
        conditions: [...conditions],
        slaMinutes,
        unapproved: approvals.length === 0,
        outcome: outcomeFor(document, state, actions, finals),
      });
    }
  };

  const initialStep = document.steps.find((step) => step.state === document.initialState);
  walk(
    document.initialState,
    [document.initialState],
    [],
    [],
    initialStep?.approval
      ? [
          {
            state: initialStep.state,
            model: initialStep.approval.model,
            required: 1,
            permissions: [
              ...new Set(initialStep.approval.approvers.map((approver) => approver.permission)),
            ],
          },
        ]
      : [],
    (initialStep?.sla ?? []).reduce((total, rule) => total + rule.minutes, 0),
    new Set(),
  );

  return {
    entries,
    truncated,
    flatMap: <T>(fn: (path: SimulatedPath) => T[]) => entries.flatMap(fn),
  };
}

/**
 * Classifies how a path ended.
 *
 * By the *last transition's flags*, not by the state's name. A definition is free to call
 * its terminal states `withdrawn` and `declined`, and matching on names would work for the
 * framework's examples and quietly fail for everybody else.
 */
function outcomeFor(
  document: WorkflowDefinitionDocument,
  terminal: string,
  actions: string[],
  finals: Set<string>,
): SimulatedPath['outcome'] {
  if (!finals.has(terminal)) return 'incomplete';

  const lastAction = actions.at(-1);
  const transition = document.transitions.find(
    (candidate) => candidate.action === lastAction && candidate.to === terminal,
  );

  if (transition?.isCancellation) return 'cancelled';
  if (transition?.isRejection) return 'rejected';
  return 'approved';
}

// --- findings --------------------------------------------------------------

function findDeadEnds(document: WorkflowDefinitionDocument): string[] {
  const hasExit = new Set(document.transitions.map((transition) => transition.from));
  const finals = new Set(document.finalStates);
  return document.states.filter((state) => !finals.has(state) && !hasExit.has(state));
}

/**
 * Separation-of-duty concerns a schema cannot see.
 *
 * The schema knows one step at a time. These are cross-step properties: the same
 * permission approving twice in a chain is two signatures from one population, which
 * is one signature wearing a hat.
 */
function findSeparationConcerns(document: WorkflowDefinitionDocument): string[] {
  const concerns: string[] = [];

  const approvalSteps = document.steps.filter((step) => step.approval);

  // Same permission at two approval steps.
  const byPermission = new Map<string, string[]>();
  for (const step of approvalSteps) {
    for (const approver of step.approval?.approvers ?? []) {
      const states = byPermission.get(approver.permission) ?? [];
      if (!states.includes(step.state)) states.push(step.state);
      byPermission.set(approver.permission, states);
    }
  }
  for (const [permission, states] of byPermission) {
    if (states.length > 1) {
      concerns.push(
        `"${permission}" approves at ${states.length} steps (${states.join(', ')}). One person ` +
          'holding it could satisfy several supposedly independent reviews.',
      );
    }
  }

  // The start permission also approving.
  if (document.startPermission) {
    const alsoApproves = [...byPermission.keys()].includes(document.startPermission);
    if (alsoApproves) {
      concerns.push(
        `"${document.startPermission}" both starts an instance and approves one. Any holder ` +
          'is both maker and checker — self-approval is prevented per instance, but the ' +
          'population is not separated.',
      );
    }
  }

  // Self-approval explicitly enabled.
  for (const step of approvalSteps) {
    if (step.approval?.allowSelfApproval) {
      concerns.push(
        `Step "${step.state}" permits self-approval; the maker-checker control is off.`,
      );
    }
  }

  // A rework loop back to an editable state, where the maker can change the very
  // fields a later approver already looked at. Correct behaviour, and worth naming:
  // the approval that follows a rework must be a fresh one, which is why decisions
  // are recorded per rework cycle.
  const reworkTransitions = document.transitions.filter((transition) => transition.isRework);
  for (const transition of reworkTransitions) {
    const target = document.steps.find((step) => step.state === transition.to);
    if (target && target.editableFields.length > 0) {
      concerns.push(
        `Returning to "${transition.to}" lets the maker edit ` +
          `${target.editableFields.length} field(s). Approvals from before the rework must not ` +
          'count towards the new cycle — the runtime scopes them per cycle.',
      );
    }
  }

  return concerns;
}

function findSlaRisks(
  document: WorkflowDefinitionDocument,
): Array<{ state: string; kind: string; minutes: number; hasEscalation: boolean }> {
  const risks: Array<{ state: string; kind: string; minutes: number; hasEscalation: boolean }> = [];

  for (const step of document.steps) {
    for (const rule of step.sla) {
      risks.push({
        state: step.state,
        kind: rule.kind,
        minutes: rule.minutes,
        hasEscalation: step.escalations.length > 0,
      });
    }
  }

  // Longest first: the longest SLA on the critical path is the one that determines
  // how slow the workflow can be while still "meeting" its targets.
  return risks.sort((a, b) => b.minutes - a.minutes);
}

function collectPermissions(document: WorkflowDefinitionDocument): string[] {
  const permissions = new Set<string>();

  if (document.startPermission) permissions.add(document.startPermission);
  if (document.cancellation.permission) permissions.add(document.cancellation.permission);
  document.transitions.forEach((transition) => {
    if (transition.permission) permissions.add(transition.permission);
  });
  document.steps.forEach((step) => {
    step.approval?.approvers.forEach((approver) => permissions.add(approver.permission));
  });

  return [...permissions].sort();
}

function collectDataFields(document: WorkflowDefinitionDocument): string[] {
  const fields = new Set<string>();

  document.steps.forEach((step) => {
    step.requiredFields.forEach((field) => fields.add(field));
    step.editableFields.forEach((field) => fields.add(field));
  });

  return [...fields].sort();
}

// --- rendering -------------------------------------------------------------

/** Renders a simulation for a terminal. Used by `trustos workflow simulate`. */
export function formatSimulation(result: SimulationResult): string[] {
  const lines: string[] = [];

  lines.push(
    `${result.definition.name} (${result.definition.id} ${result.definition.version})`,
    result.valid ? 'Definition is valid.' : 'Definition has errors — see findings below.',
    '',
  );

  lines.push(
    `Paths: ${result.paths.length}${result.truncated ? ` (truncated at ${MAX_PATHS})` : ''}`,
  );
  for (const path of result.paths.slice(0, 25)) {
    const marker = path.reachesFinalState ? ' ' : '!';
    lines.push(`  ${marker} ${path.states.join(' -> ')}`);
    if (path.approvals.length > 0) {
      lines.push(
        `      approvals: ${path.approvals
          .map((approval) => `${approval.state}(${approval.model}, ${approval.required})`)
          .join(', ')}`,
      );
    }
    if (path.conditions.length > 0) {
      path.conditions.forEach((condition) => lines.push(`      when: ${condition}`));
    }
    if (path.slaMinutes > 0) lines.push(`      SLA total: ${path.slaMinutes} min`);
  }
  if (result.paths.length > 25) lines.push(`  ... ${result.paths.length - 25} more`);
  lines.push('');

  const section = (title: string, entries: string[]) => {
    if (entries.length === 0) return;
    lines.push(`${title}:`);
    entries.forEach((entry) => lines.push(`  - ${entry}`));
    lines.push('');
  };

  section('Unreachable states', result.unreachableStates);
  section('Dead ends (no way out, not final)', result.deadEnds);
  section('Outcomes no path reaches', result.unreachableOutcomes);
  section(
    'Paths reaching a SUCCESS outcome with NO approval',
    result.unapprovedPaths.map((path) => path.states.join(' -> ')),
  );
  section('Separation-of-duty concerns', result.separationOfDutyConcerns);
  section(
    'SLA exposure (longest first)',
    result.slaRisks.map(
      (risk) =>
        `${risk.state} ${risk.kind}: ${risk.minutes} min` +
        (risk.hasEscalation ? '' : ' — NO escalation configured'),
    ),
  );
  section('Permissions required', result.requiredPermissions);
  section('Instance data read', result.requiredData);

  const errors = result.findings.filter((finding) => finding.severity === 'error');
  const warnings = result.findings.filter((finding) => finding.severity === 'warning');
  section(
    'Errors',
    errors.map((finding) => `${finding.path}: ${finding.message}`),
  );
  section(
    'Warnings',
    warnings.map((finding) => `${finding.path}: ${finding.message}`),
  );

  return lines;
}
