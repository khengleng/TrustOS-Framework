import { createHash } from 'node:crypto';
import { ApiError } from '@trustsystem/errors';
import { definitionImmutable } from '@trustsystem/workflow-core';
import type { WorkflowDefinitionStatus } from '@trustsystem/workflow-core';
import { SEMVER_PATTERN, type WorkflowDefinitionDocument } from './schema';

/**
 * Version identity, immutability and comparison.
 *
 * The rule this file exists to enforce: **a published version never changes.** Not
 * its states, not its approvers, not a typo in a description. A running instance
 * holds a version id and reads its rules from that row, so editing the row would
 * retroactively change the rules a decision was made under — which makes the audit
 * trail a record of what the workflow says *now*, not what it said then.
 *
 * Everything else follows from that. A change is a new version. Rollback is
 * activating an older version, not editing a newer one. Retirement stops new
 * instances and leaves existing ones alone.
 */

// --- hashing ---------------------------------------------------------------

/**
 * A stable hash of a definition document.
 *
 * Detects tampering with a published version: the hash is stored at publication and
 * re-checked when the runtime loads the definition, so a direct `UPDATE` against the
 * table is caught rather than silently obeyed. That matters because the application
 * has write access to its own database — the guard against a modified definition
 * cannot be "the API refuses", it has to be something the runtime verifies.
 *
 * Keys are sorted recursively before serialization. Without that, two documents that
 * differ only in key order hash differently, and a round-trip through a JSON parser
 * that does not preserve order would look like tampering.
 */
export function hashDefinition(document: unknown): string {
  return createHash('sha256').update(stableStringify(document)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';

  if (Array.isArray(value)) {
    // Array order is meaningful — approver order, transition order — so it is
    // preserved. Only object keys are normalised.
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

/**
 * Verifies a stored definition against its recorded hash.
 *
 * Throws rather than returning false: a definition that does not match its hash is
 * not a validation problem, it is evidence that something wrote to the table
 * outside the application. Continuing to execute it would be executing rules nobody
 * approved.
 */
export function assertDefinitionUntampered(input: {
  definition: unknown;
  expectedHash: string;
  version: string;
}): void {
  const actual = hashDefinition(input.definition);
  if (actual === input.expectedHash) return;

  throw ApiError.internal(
    `Workflow version ${input.version} does not match its recorded hash. The stored definition ` +
      'has been modified outside the application. Refusing to execute it.',
  );
}

// --- semantic versions -----------------------------------------------------

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(version: string): ParsedVersion {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw ApiError.validation(
      [{ path: 'version', message: `"${version}" is not a semantic version.`, code: 'semver' }],
      'A workflow version must be semantic, e.g. 1.0.0.',
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Negative when `a` is older, positive when newer, zero when equal. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function latestVersion(versions: string[]): string | null {
  if (versions.length === 0) return null;
  return [...versions].sort(compareVersions).at(-1) as string;
}

/**
 * The next version after a change.
 *
 * `suggestNextVersion` rather than `nextVersion`: the increment is a judgement about
 * whether the change is breaking, and the tool proposes while the author decides.
 * The heuristic is deliberately conservative — a removed state or transition is
 * major, because an in-flight instance under the old version may be sitting in
 * exactly the state that was removed.
 */
export function suggestNextVersion(
  current: string,
  comparison: DefinitionComparison,
): { version: string; reason: string } {
  const { major, minor, patch } = parseVersion(current);

  if (comparison.breaking.length > 0) {
    return {
      version: `${major + 1}.0.0`,
      reason: `Breaking: ${comparison.breaking[0]}`,
    };
  }
  if (comparison.additive.length > 0) {
    return {
      version: `${major}.${minor + 1}.0`,
      reason: `Additive: ${comparison.additive[0]}`,
    };
  }
  return {
    version: `${major}.${minor}.${patch + 1}`,
    reason: comparison.cosmetic[0] ?? 'No structural change.',
  };
}

// --- immutability ----------------------------------------------------------

/** Statuses whose definition may still be edited. */
export const EDITABLE_STATUSES: readonly WorkflowDefinitionStatus[] = ['draft'];

/**
 * Refuses an edit to a version that is past drafting.
 *
 * `under_review` is included, and that is a real decision: a definition under
 * review is one somebody is reading, and letting the author edit it underneath the
 * reviewer means the reviewer approves something other than what they read. To
 * change it, withdraw it to draft first — which is visible, rather than silent.
 */
export function assertEditable(input: { status: WorkflowDefinitionStatus; version: string }): void {
  if (EDITABLE_STATUSES.includes(input.status)) return;

  if (input.status === 'published' || input.status === 'retired') {
    throw definitionImmutable(input.version);
  }

  throw ApiError.conflict(
    `Version ${input.version} is ${input.status}. Withdraw it to draft before editing, so a ` +
      'reviewer does not approve something other than what they read.',
    { reason: 'definition_immutable', version: input.version, status: input.status },
  );
}

/**
 * The definition status transitions.
 *
 * A small state machine of its own, and worth being explicit about: the interesting
 * edges are that `published` goes only to `retired` (never back to draft), and that
 * `retired` is terminal. Rollback is publishing an older *approved* version, not
 * un-retiring this one — because un-retiring would mean the same version id had two
 * different publication histories.
 */
const STATUS_TRANSITIONS: Record<WorkflowDefinitionStatus, WorkflowDefinitionStatus[]> = {
  draft: ['under_review'],
  under_review: ['approved', 'draft'],
  approved: ['published', 'draft'],
  published: ['retired'],
  retired: [],
};

export function canTransitionStatus(
  from: WorkflowDefinitionStatus,
  to: WorkflowDefinitionStatus,
): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export function assertStatusTransition(
  from: WorkflowDefinitionStatus,
  to: WorkflowDefinitionStatus,
): void {
  if (canTransitionStatus(from, to)) return;

  throw ApiError.conflict(
    `A workflow version cannot go from ${from} to ${to}.` +
      (from === 'published' && to === 'draft'
        ? ' A published version is immutable — create a new version instead.'
        : ` Available: ${STATUS_TRANSITIONS[from].join(', ') || 'none'}.`),
    { reason: 'definition_immutable', fromStatus: from, toStatus: to },
  );
}

// --- comparison ------------------------------------------------------------

export interface DefinitionComparison {
  /** Changes that could strand or misroute an in-flight instance. */
  breaking: string[];
  /** New capability that does not change existing paths. */
  additive: string[];
  /** Names, descriptions, labels. */
  cosmetic: string[];
  /** Changes that weaken a control. Always shown first in the portal. */
  controlWeakening: string[];
}

/**
 * Compares two definition documents.
 *
 * What an administrator sees before approving a new version, so it is organised by
 * *consequence* rather than by field. `controlWeakening` is a separate bucket from
 * `breaking` because the two need different readers: breaking changes are an
 * engineering question about in-flight instances, and a weakened control is a
 * governance question about whether the change should happen at all.
 *
 * A raw JSON diff would surface the same bytes and bury both.
 */
export function compareDefinitions(
  previous: WorkflowDefinitionDocument,
  next: WorkflowDefinitionDocument,
): DefinitionComparison {
  const comparison: DefinitionComparison = {
    breaking: [],
    additive: [],
    cosmetic: [],
    controlWeakening: [],
  };

  // --- states
  const previousStates = new Set(previous.states);
  const nextStates = new Set(next.states);

  for (const state of previousStates) {
    if (!nextStates.has(state)) {
      comparison.breaking.push(
        `State "${state}" was removed. An instance sitting in it under the previous version ` +
          'would have no step and no transitions.',
      );
    }
  }
  for (const state of nextStates) {
    if (!previousStates.has(state)) comparison.additive.push(`State "${state}" was added.`);
  }

  if (previous.initialState !== next.initialState) {
    comparison.breaking.push(
      `The initial state changed from "${previous.initialState}" to "${next.initialState}".`,
    );
  }

  const previousFinals = new Set(previous.finalStates);
  const nextFinals = new Set(next.finalStates);
  for (const state of nextFinals) {
    if (previousStates.has(state) && !previousFinals.has(state)) {
      comparison.breaking.push(`"${state}" is now a final state; it was not before.`);
    }
  }

  // --- transitions
  const key = (transition: { action: string; from: string; to: string }) =>
    `${transition.action}:${transition.from}->${transition.to}`;

  const previousTransitions = new Map(previous.transitions.map((t) => [key(t), t]));
  const nextTransitions = new Map(next.transitions.map((t) => [key(t), t]));

  for (const [id, transition] of previousTransitions) {
    if (!nextTransitions.has(id)) {
      comparison.breaking.push(
        `Transition "${transition.action}" from "${transition.from}" was removed.`,
      );
    }
  }
  for (const [id, transition] of nextTransitions) {
    if (!previousTransitions.has(id)) {
      comparison.additive.push(
        `Transition "${transition.action}" from "${transition.from}" to "${transition.to}" was added.`,
      );
      continue;
    }

    const before = previousTransitions.get(id);
    if (!before) continue;

    // A permission removed from a transition means anyone who can reach the state
    // can now take the action.
    if (before.permission && !transition.permission) {
      comparison.controlWeakening.push(
        `Transition "${transition.action}" no longer requires "${before.permission}".`,
      );
    } else if (before.permission !== transition.permission && transition.permission) {
      comparison.breaking.push(
        `Transition "${transition.action}" now requires "${transition.permission}" ` +
          `instead of "${before.permission ?? 'no permission'}".`,
      );
    }

    if (before.requiresReason && !transition.requiresReason) {
      comparison.controlWeakening.push(
        `Transition "${transition.action}" no longer requires a reason.`,
      );
    }
  }

  // --- approvals: where control weakening actually lives
  const previousSteps = new Map(previous.steps.map((step) => [step.state, step]));
  const nextSteps = new Map(next.steps.map((step) => [step.state, step]));

  for (const [state, step] of nextSteps) {
    const before = previousSteps.get(state);
    if (!before) continue;

    const beforeApproval = before.approval;
    const afterApproval = step.approval;

    if (beforeApproval && !afterApproval) {
      comparison.controlWeakening.push(`Step "${state}" no longer requires approval at all.`);
      continue;
    }
    if (!beforeApproval || !afterApproval) continue;

    if (!beforeApproval.allowSelfApproval && afterApproval.allowSelfApproval) {
      comparison.controlWeakening.push(
        `Step "${state}" now permits self-approval. The maker-checker control is removed.`,
      );
    }
    if (!beforeApproval.allowSameActorMultipleSlots && afterApproval.allowSameActorMultipleSlots) {
      comparison.controlWeakening.push(
        `Step "${state}" now lets one actor fill several approver slots.`,
      );
    }

    const beforeRequired = requiredApprovals(beforeApproval);
    const afterRequired = requiredApprovals(afterApproval);
    if (afterRequired < beforeRequired) {
      comparison.controlWeakening.push(
        `Step "${state}" now needs ${afterRequired} approval(s) instead of ${beforeRequired}.`,
      );
    } else if (afterRequired > beforeRequired) {
      comparison.additive.push(
        `Step "${state}" now needs ${afterRequired} approval(s), up from ${beforeRequired}.`,
      );
    }

    if (beforeApproval.model !== afterApproval.model) {
      comparison.breaking.push(
        `Step "${state}" changed approval model from "${beforeApproval.model}" to ` +
          `"${afterApproval.model}".`,
      );
    }

    if (before.requireAttachment && !step.requireAttachment && !step.requireAttachmentWhen) {
      comparison.controlWeakening.push(`Step "${state}" no longer requires an attachment.`);
    }
  }

  for (const [state, step] of nextSteps) {
    if (previousSteps.has(state)) continue;
    comparison.additive.push(`Step "${state}" (${step.kind}) was added.`);
  }
  for (const state of previousSteps.keys()) {
    if (nextSteps.has(state)) continue;
    comparison.breaking.push(`Step "${state}" was removed.`);
  }

  // --- policies
  if (previous.rejection.behaviour !== next.rejection.behaviour) {
    comparison.breaking.push(
      `Rejection behaviour changed from "${previous.rejection.behaviour}" to ` +
        `"${next.rejection.behaviour}".`,
    );
  }
  if (previous.rework.maxCycles !== next.rework.maxCycles) {
    const before = previous.rework.maxCycles ?? 'unlimited';
    const after = next.rework.maxCycles ?? 'unlimited';
    const message = `Rework limit changed from ${before} to ${after}.`;
    if (next.rework.maxCycles === null) comparison.controlWeakening.push(message);
    else comparison.additive.push(message);
  }

  // --- cosmetic
  if (previous.name !== next.name) comparison.cosmetic.push(`Name changed to "${next.name}".`);
  if (previous.description !== next.description) {
    comparison.cosmetic.push('Description changed.');
  }
  if (JSON.stringify(previous.labels) !== JSON.stringify(next.labels)) {
    comparison.cosmetic.push('Labels changed.');
  }

  if (previous.businessObjectType !== next.businessObjectType) {
    comparison.breaking.push(
      `Business object type changed from "${previous.businessObjectType}" to ` +
        `"${next.businessObjectType}". This is a different workflow; use a new definition key.`,
    );
  }

  return comparison;
}

/** How many distinct approvals a model requires. */
function requiredApprovals(approval: {
  model: string;
  approvers: unknown[];
  threshold?: number | undefined;
}): number {
  switch (approval.model) {
    case 'single':
      return 1;
    case 'threshold':
      return approval.threshold ?? 1;
    case 'unanimous':
    case 'sequential':
      return approval.approvers.length;
    case 'parallel':
      // Parallel means several may review concurrently; one decision settles it
      // unless the model is unanimous or threshold.
      return 1;
    case 'conditional':
      // The unconditional approvers are the floor: everything else may be skipped.
      return 1;
    default:
      return 1;
  }
}

/** Renders a comparison for a terminal or a portal, worst news first. */
export function formatComparison(comparison: DefinitionComparison): string[] {
  const lines: string[] = [];

  const section = (title: string, entries: string[]) => {
    if (entries.length === 0) return;
    lines.push(`${title}:`);
    entries.forEach((entry) => lines.push(`  - ${entry}`));
  };

  // Control weakening first, always. It is the one an approver must not scroll past.
  section('CONTROL WEAKENING — review before approving', comparison.controlWeakening);
  section('Breaking (affects in-flight instances)', comparison.breaking);
  section('Additive', comparison.additive);
  section('Cosmetic', comparison.cosmetic);

  if (lines.length === 0) lines.push('No differences.');
  return lines;
}
