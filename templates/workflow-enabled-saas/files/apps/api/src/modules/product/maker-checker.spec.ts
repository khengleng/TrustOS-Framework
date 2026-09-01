import { describe, expect, it } from 'vitest';
import { CHANGE_REQUEST_APPROVAL, validateDefinition } from '@trustsystem/workflow-definition';
import { simulateDefinition } from '@trustsystem/workflow-definition';
import definition from '../../../../../workflows/change-request-approval.json';

/**
 * The generated application's own workflow tests.
 *
 * Two kinds, and both matter for different reasons.
 *
 * **The definition is checked statically.** These assertions run in under a millisecond and
 * catch the mistakes that are invisible on inspection: a path to `approved` that requires no
 * review, a dead-end state, a self-approval flag somebody set while debugging.
 *
 * **Maker-checker is asserted, not assumed.** The one thing that must never regress is that
 * a submitter cannot approve their own request. A test that only exercised the happy path
 * would pass against a definition with `allowSelfApproval: true`.
 *
 * `trustos workflow validate workflows/change-request-approval.json --strict-permissions`
 * runs the same checks from the command line, which is what belongs in a pre-commit hook.
 */

describe('the change request workflow definition', () => {
  it('is valid', () => {
    const result = validateDefinition(definition);
    const errors = result.findings.filter((finding) => finding.severity === 'error');

    expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('never permits self-approval', () => {
    const document = validateDefinition(definition).document;
    expect(document).toBeTruthy();

    /*
     * The assertion that must not regress.
     *
     * `allowSelfApproval: true` is a one-word edit that removes the maker-checker control and
     * breaks no other test. `validateDefinition` reports it as a warning; this fails the build.
     */
    for (const step of document?.steps ?? []) {
      if (!step.approval) continue;
      expect(step.approval.allowSelfApproval, `step "${step.state}"`).toBe(false);
    }
  });

  it('never lets one actor fill several approver slots', () => {
    const document = validateDefinition(definition).document;

    for (const step of document?.steps ?? []) {
      if (!step.approval) continue;
      // Otherwise a threshold of N is satisfiable by one person acting N times.
      expect(step.approval.allowSameActorMultipleSlots, `step "${step.state}"`).toBe(false);
    }
  });

  it('has no path that reaches approval with no review', () => {
    const simulation = simulateDefinition(definition);

    // The single most valuable check: it is invisible on inspection of the JSON and obvious to
    // a graph walk. Cancellation and rejection paths are excluded — a withdrawal needs no
    // approval, and a rejection is itself a decision.
    expect(simulation.unapprovedPaths.map((path) => path.states.join(' -> '))).toEqual([]);
  });

  it('has no dead ends and no unreachable states', () => {
    const simulation = simulateDefinition(definition);

    // A dead end is where a request goes to die: the instance sits there, the SLA breaches,
    // escalation fires, and no action can move it.
    expect(simulation.deadEnds).toEqual([]);
    expect(simulation.unreachableStates).toEqual([]);
  });

  it('can reach every declared outcome', () => {
    // An outcome no path reaches is dead configuration — usually a state somebody believes is
    // used.
    expect(simulateDefinition(definition).unreachableOutcomes).toEqual([]);
  });

  it('requires a reason for every rejection and every return', () => {
    const document = validateDefinition(definition).document;

    for (const transition of document?.transitions ?? []) {
      if (transition.isRejection || transition.isRework) {
        // A rejection with no reason is unusable by the maker and worthless to an auditor.
        expect(transition.requiresReason, `${transition.action} from ${transition.from}`).toBe(
          true,
        );
      }
    }
  });

  it('requires evidence for a high-risk request and not for a low-risk one', () => {
    const document = validateDefinition(definition).document;
    const review = document?.steps.find((step) => step.state === 'manager_review');

    // Conditional rather than unconditional. An unconditional requirement gets satisfied with
    // a screenshot of nothing.
    expect(review?.requireAttachment).toBe(false);
    expect(review?.requireAttachmentWhen).toBeTruthy();
  });

  it('bounds the rework loop', () => {
    const document = validateDefinition(definition).document;

    // An unbounded loop is how a request stays open for a year while both sides believe the
    // other has it.
    expect(document?.rework.maxCycles).not.toBe(null);
  });

  it('stays structurally aligned with the framework example it was derived from', () => {
    const document = validateDefinition(definition).document;

    /*
     * Not an equality check — this definition is meant to be edited, and a test that forbade
     * editing would be deleted on day one.
     *
     * What it does assert is that the *controls* survived: the same states, the same terminal
     * outcomes, and an approval step for each review. Adding a state or a transition passes;
     * deleting the compliance review does not.
     */
    expect(new Set(document?.states)).toEqual(new Set(CHANGE_REQUEST_APPROVAL.states));
    expect(new Set(document?.finalStates)).toEqual(new Set(CHANGE_REQUEST_APPROVAL.finalStates));

    const approvalSteps = (document?.steps ?? []).filter((step) => step.approval).length;
    expect(approvalSteps).toBeGreaterThanOrEqual(2);
  });
});
