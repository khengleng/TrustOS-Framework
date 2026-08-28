import { describe, expect, it } from 'vitest';
import {
  CHANGE_REQUEST_APPROVAL,
  SIMPLE_APPROVAL,
  assertStatusTransition,
  canTransitionStatus,
  compareDefinitions,
  conditionFields,
  describeCondition,
  evaluateCondition,
  hashDefinition,
  parseCondition,
  simulateDefinition,
  suggestNextVersion,
  validateDefinition,
  workflowDefinitionDocumentSchema,
  type WorkflowDefinitionDocument,
} from './index';

/** A deep clone, so a test mutating a definition does not affect the next one. */
function clone(document: WorkflowDefinitionDocument): WorkflowDefinitionDocument {
  return structuredClone(document);
}

function codes(document: unknown): string[] {
  return validateDefinition(document).findings.map((finding) => finding.code);
}

function errorCodes(document: unknown): string[] {
  return validateDefinition(document)
    .findings.filter((finding) => finding.severity === 'error')
    .map((finding) => finding.code);
}

// ===========================================================================
// The condition language
// ===========================================================================

describe('the condition language', () => {
  it('evaluates comparisons on own properties', () => {
    const data = { amount: 5000, riskRating: 'high', tags: ['urgent', 'review'] };

    expect(evaluateCondition({ field: 'amount', operator: 'gte', value: 5000 }, data)).toBe(true);
    expect(evaluateCondition({ field: 'amount', operator: 'gt', value: 5000 }, data)).toBe(false);
    expect(evaluateCondition({ field: 'riskRating', operator: 'eq', value: 'high' }, data)).toBe(
      true,
    );
    expect(
      evaluateCondition({ field: 'riskRating', operator: 'in', value: ['high', 'critical'] }, data),
    ).toBe(true);
    expect(evaluateCondition({ field: 'tags', operator: 'contains', value: 'urgent' }, data)).toBe(
      true,
    );
    expect(evaluateCondition({ field: 'missing', operator: 'exists' }, data)).toBe(false);
    expect(evaluateCondition({ field: 'missing', operator: 'missing' }, data)).toBe(true);
  });

  it('composes with all, any and not', () => {
    const data = { amount: 200_000, riskRating: 'medium', region: 'apac' };

    expect(
      evaluateCondition(
        {
          all: [
            { field: 'amount', operator: 'gt', value: 100_000 },
            {
              any: [
                { field: 'riskRating', operator: 'eq', value: 'high' },
                { field: 'region', operator: 'eq', value: 'apac' },
              ],
            },
          ],
        },
        data,
      ),
    ).toBe(true);

    expect(
      evaluateCondition({ not: { field: 'riskRating', operator: 'eq', value: 'high' } }, data),
    ).toBe(true);
  });

  it('refuses a field that could reach the prototype chain', () => {
    /*
     * Two defences, and this test exists because the first one alone is not enough.
     *
     * The character set excludes `$`, brackets and hyphens. It does *not* exclude
     * `__proto__` — `_` is a legal identifier character — which an earlier version of
     * this test discovered by asserting the opposite and failing. `RESERVED_SEGMENTS`
     * covers those three names, and `readField`'s own-property access covers the rest.
     */
    for (const field of [
      '__proto__',
      'constructor',
      'prototype',
      'a.__proto__.b',
      'constructor.prototype',
      'a[0]',
      'a-b',
      '$where',
      '1abc',
    ]) {
      const result = parseConditionSafely({ field, operator: 'eq', value: 1 });
      expect(result, `field "${field}" should be refused`).toBe('refused');
    }

    expect(parseConditionSafely({ field: 'a.b_c.d2', operator: 'eq', value: 1 })).toBe('accepted');
  });

  it('reads only own properties, even for a name that passes the pattern', () => {
    // The second, independent defence. `toString` is a legal identifier by the pattern
    // and is inherited by every object, so a name-only check would return a function.
    expect(evaluateCondition({ field: 'toString', operator: 'exists' }, {})).toBe(false);
  });

  it('never coerces a string to a number in an ordering comparison', () => {
    // `"90000" > 100000` is false and so is `"90000" > 10`, which is how a silently
    // wrong approval path happens. Refusing to coerce makes the comparison fail
    // closed instead.
    expect(
      evaluateCondition({ field: 'amount', operator: 'gt', value: 10 }, { amount: '90000' }),
    ).toBe(false);
    expect(
      evaluateCondition({ field: 'amount', operator: 'lte', value: 10 }, { amount: '5' }),
    ).toBe(false);
  });

  it('refuses an ordering comparison against a non-numeric value at parse time', () => {
    expect(parseConditionSafely({ field: 'amount', operator: 'gt', value: '100' })).toBe('refused');
    expect(parseConditionSafely({ field: 'amount', operator: 'gte', value: true })).toBe('refused');
  });

  it('refuses a value where the operator takes none, and vice versa', () => {
    expect(parseConditionSafely({ field: 'a', operator: 'exists', value: 1 })).toBe('refused');
    expect(parseConditionSafely({ field: 'a', operator: 'eq' })).toBe('refused');
    expect(parseConditionSafely({ field: 'a', operator: 'in', value: 'not-an-array' })).toBe(
      'refused',
    );
    expect(parseConditionSafely({ field: 'a', operator: 'eq', value: [1, 2] })).toBe('refused');
  });

  it('refuses an unknown key, so a typo is not silently ignored', () => {
    expect(parseConditionSafely({ field: 'a', operator: 'eq', value: 1, extra: true })).toBe(
      'refused',
    );
  });

  it('bounds nesting depth, so a deep tree cannot exhaust the stack', () => {
    // An unbounded recursive schema is a denial of service reachable by anybody who can
    // submit a definition.
    let deep: unknown = { field: 'a', operator: 'exists' };
    for (let level = 0; level < 12; level += 1) deep = { not: deep };

    expect(parseConditionSafely(deep)).toBe('refused');
  });

  it('is total: nothing throws, whatever the data', () => {
    const condition = { field: 'a.b.c', operator: 'eq' as const, value: 1 };

    for (const data of [{}, { a: null }, { a: 1 }, { a: { b: null } }, { a: { b: { c: 2 } } }]) {
      expect(() => evaluateCondition(condition, data as Record<string, unknown>)).not.toThrow();
    }
  });

  it('reports the fields a condition reads, and renders it readably', () => {
    const condition = {
      all: [
        { field: 'amount', operator: 'gte' as const, value: 100_000 },
        { field: 'riskRating', operator: 'in' as const, value: ['high', 'critical'] },
      ],
    };

    expect(conditionFields(condition)).toEqual(['amount', 'riskRating']);
    expect(describeCondition(condition)).toBe(
      'amount >= 100000 AND riskRating in [high, critical]',
    );
  });
});

function parseConditionSafely(input: unknown): 'accepted' | 'refused' {
  try {
    parseCondition(input);
    return 'accepted';
  } catch {
    return 'refused';
  }
}

// ===========================================================================
// Definition validation
// ===========================================================================

describe('the example definitions', () => {
  it('are valid', () => {
    for (const document of [CHANGE_REQUEST_APPROVAL, SIMPLE_APPROVAL]) {
      const result = validateDefinition(document);
      const errors = result.findings.filter((finding) => finding.severity === 'error');
      expect(errors, `${document.id}: ${JSON.stringify(errors)}`).toEqual([]);
      expect(result.valid).toBe(true);
    }
  });

  it('parse through the schema unchanged', () => {
    // `.strict()` at every level means an example carrying a field the schema does not
    // know would fail — which is the check that the example and the schema have not
    // drifted apart.
    expect(() => workflowDefinitionDocumentSchema.parse(CHANGE_REQUEST_APPROVAL)).not.toThrow();
  });

  it('never permit self-approval', () => {
    // The framework's own examples must model the default. An example with
    // `allowSelfApproval: true` would be copied.
    for (const step of CHANGE_REQUEST_APPROVAL.steps) {
      if (!step.approval) continue;
      expect(step.approval.allowSelfApproval, step.state).toBe(false);
    }
  });
});

describe('structural validation', () => {
  it('refuses an initial state that is not declared', () => {
    const document = clone(SIMPLE_APPROVAL);
    document.initialState = 'nonexistent';
    expect(errorCodes(document)).toContain('missing_initial_state');
  });

  it('refuses an initial state that is also final', () => {
    const document = clone(SIMPLE_APPROVAL);
    document.finalStates = ['draft', 'approved'];
    // Every instance would be complete on creation.
    expect(errorCodes(document)).toContain('initial_state_is_final');
  });

  it('refuses a duplicate state', () => {
    const document = clone(SIMPLE_APPROVAL);
    document.states = [...document.states, 'draft'];
    expect(errorCodes(document)).toContain('duplicate_state');
  });

  it('refuses an unreachable state', () => {
    const document = clone(SIMPLE_APPROVAL);
    document.states = [...document.states, 'orphan'];
    // An unreachable state is usually a review step somebody believes exists.
    expect(errorCodes(document)).toContain('unreachable_state');
  });

  it('refuses a dead end: a non-final state with no way out', () => {
    const document = clone(SIMPLE_APPROVAL);
    document.states = [...document.states, 'limbo'];
    document.transitions = [
      ...document.transitions,
      {
        action: 'park',
        from: 'draft',
        to: 'limbo',
        automatic: false,
        requiresReason: false,
        isRework: false,
        isRejection: false,
        isCancellation: false,
      },
    ];

    const findings = validateDefinition(document).findings;
    expect(findings.map((finding) => finding.code)).toContain('dead_end_state');
    // The message names the state, because the value of this check is that it is
    // invisible on inspection of a large definition.
    expect(findings.find((finding) => finding.code === 'dead_end_state')?.message).toContain(
      '"limbo"',
    );
  });

  it('refuses two transitions with the same action from the same state', () => {
    const document = clone(SIMPLE_APPROVAL);
    document.transitions = [
      ...document.transitions,
      {
        action: 'submit',
        from: 'draft',
        to: 'rejected',
        automatic: false,
        requiresReason: false,
        isRework: false,
        isRejection: false,
        isCancellation: false,
      },
    ];
    // Which one applies would be arbitrary.
    expect(errorCodes(document)).toContain('duplicate_transition');
  });

  it('allows the same action from different states', () => {
    // `approve` legitimately exists from manager_review and compliance_review. Only the
    // (action, from) pair must be unique.
    expect(errorCodes(CHANGE_REQUEST_APPROVAL)).not.toContain('duplicate_transition');
  });

  it('refuses a transition out of a state declared final', () => {
    const document = clone(SIMPLE_APPROVAL);
    document.transitions = [
      ...document.transitions,
      {
        action: 'undo',
        from: 'approved',
        to: 'draft',
        automatic: false,
        requiresReason: false,
        isRework: false,
        isRejection: false,
        isCancellation: false,
      },
    ];
    expect(errorCodes(document)).toContain('transition_from_final_state');
  });

  it('refuses a cycle of automatic transitions', () => {
    const document = clone(SIMPLE_APPROVAL);
    document.states = [...document.states, 'routing', 'checking'];
    document.transitions = [
      ...document.transitions,
      {
        action: 'to_routing',
        from: 'draft',
        to: 'routing',
        automatic: false,
        requiresReason: false,
        isRework: false,
        isRejection: false,
        isCancellation: false,
      },
      {
        action: 'routing_to_checking',
        from: 'routing',
        to: 'checking',
        automatic: true,
        requiresReason: false,
        isRework: false,
        isRejection: false,
        isCancellation: false,
      },
      {
        action: 'checking_to_routing',
        from: 'checking',
        to: 'routing',
        automatic: true,
        requiresReason: false,
        isRework: false,
        isRejection: false,
        isCancellation: false,
      },
    ];

    const findings = validateDefinition(document).findings;
    const cycle = findings.find((finding) => finding.code === 'automatic_cycle');
    expect(cycle).toBeTruthy();
    // The message names the cycle. Catching this here is much better than an iteration
    // cap in the runtime, which turns an authoring mistake into a mysterious error.
    expect(cycle?.message).toContain('->');
  });

  it('refuses two unconditional automatic transitions from one state', () => {
    const document = clone(SIMPLE_APPROVAL);
    document.states = [...document.states, 'fork', 'left', 'right'];
    document.finalStates = [...document.finalStates, 'left', 'right'];
    document.transitions = [
      ...document.transitions,
      {
        action: 'to_fork',
        from: 'draft',
        to: 'fork',
        automatic: false,
        requiresReason: false,
        isRework: false,
        isRejection: false,
        isCancellation: false,
      },
      {
        action: 'go_left',
        from: 'fork',
        to: 'left',
        automatic: true,
        requiresReason: false,
        isRework: false,
        isRejection: false,
        isCancellation: false,
      },
      {
        action: 'go_right',
        from: 'fork',
        to: 'right',
        automatic: true,
        requiresReason: false,
        isRework: false,
        isRejection: false,
        isCancellation: false,
      },
    ];
    expect(errorCodes(document)).toContain('ambiguous_automatic_transition');
  });

  it('refuses an impossible approval threshold', () => {
    const document = clone(SIMPLE_APPROVAL);
    const step = document.steps.find((candidate) => candidate.state === 'pending_approval');
    step!.approval = {
      model: 'threshold',
      threshold: 4,
      approvers: [
        { key: 'a', name: 'A', permission: 'workflow.approval.decide', slaMinutes: null },
        { key: 'b', name: 'B', permission: 'workflow.approval.decide', slaMinutes: null },
      ],
      allowSelfApproval: false,
      allowSameActorMultipleSlots: false,
      rejectionReasonCodes: [],
    };

    // The schema catches this, so it is reported as a schema error — the workflow could
    // never complete.
    const findings = validateDefinition(document).findings;
    expect(findings.some((finding) => finding.message.includes('could never complete'))).toBe(true);
  });

  it('refuses a sequential model with a gap in the order', () => {
    const document = clone(SIMPLE_APPROVAL);
    const step = document.steps.find((candidate) => candidate.state === 'pending_approval');
    step!.approval = {
      model: 'sequential',
      approvers: [
        { key: 'a', name: 'A', permission: 'workflow.approval.decide', order: 1, slaMinutes: null },
        { key: 'b', name: 'B', permission: 'workflow.approval.decide', order: 3, slaMinutes: null },
      ],
      allowSelfApproval: false,
      allowSameActorMultipleSlots: false,
      rejectionReasonCodes: [],
    };

    const findings = validateDefinition(document).findings;
    // A gap means an approval step nothing can reach.
    expect(findings.some((finding) => finding.message.includes('contiguous'))).toBe(true);
  });

  it('refuses a conditional model where every approver can be skipped', () => {
    const document = clone(SIMPLE_APPROVAL);
    const step = document.steps.find((candidate) => candidate.state === 'pending_approval');
    step!.approval = {
      model: 'conditional',
      approvers: [
        {
          key: 'a',
          name: 'A',
          permission: 'workflow.approval.decide',
          condition: { field: 'risk', operator: 'eq', value: 'high' },
          slaMinutes: null,
        },
      ],
      allowSelfApproval: false,
      allowSameActorMultipleSlots: false,
      rejectionReasonCodes: [],
    };

    const findings = validateDefinition(document).findings;
    // Otherwise a request reaches "approved" with nobody having looked at it.
    expect(
      findings.some((finding) => finding.message.includes('approved with no review at all')),
    ).toBe(true);
  });

  it('refuses an unknown permission when a catalog is supplied', () => {
    const document = clone(SIMPLE_APPROVAL);
    const result = validateDefinition(document, {
      knownPermissions: ['workflow.instance.transition'],
    });

    // A misspelled approver permission is a step nobody can ever act on.
    expect(
      result.findings.filter((finding) => finding.code === 'unknown_permission').length,
    ).toBeGreaterThan(0);
    expect(result.valid).toBe(false);
  });

  it('warns rather than fails when no permission catalog is supplied', () => {
    // The CLI validating a file has no application to ask.
    const result = validateDefinition(SIMPLE_APPROVAL);
    expect(result.findings.map((finding) => finding.code)).toContain('permissions_unchecked');
    expect(result.valid).toBe(true);
  });

  it('refuses an assignment strategy with no registered resolver', () => {
    const document = clone(SIMPLE_APPROVAL);
    const step = document.steps.find((candidate) => candidate.state === 'draft');
    step!.assignment = { strategy: 'requester_manager' };

    const result = validateDefinition(document, { registeredResolvers: [] });
    expect(result.findings.map((finding) => finding.code)).toContain('unregistered_resolver');
  });

  it('refuses an unregistered calendar rather than falling back to elapsed time', () => {
    const document = clone(SIMPLE_APPROVAL);
    const step = document.steps.find((candidate) => candidate.state === 'pending_approval');
    step!.sla = [
      {
        kind: 'time_to_complete',
        minutes: 60,
        warningAtPercent: 80,
        severity: 'medium',
        calendar: 'working-hours-kh',
      },
    ];

    // A silent fallback would be an SLA that looks correct and is wrong by a factor of
    // three.
    expect(errorCodes(document)).toContain('unknown_calendar');
  });

  it('refuses an escalation callback naming an unregistered key', () => {
    const document = clone(SIMPLE_APPROVAL);
    const step = document.steps.find((candidate) => candidate.state === 'pending_approval');
    step!.escalations = [
      { key: 'cb', trigger: 'sla_breach', action: 'callback', callbackKey: 'not-registered' },
    ];

    expect(errorCodesWithCallbacks(document, ['something-else'])).toContain(
      'unregistered_callback',
    );
  });

  it('refuses a callback rule with no key at all', () => {
    const document = clone(SIMPLE_APPROVAL);
    const step = document.steps.find((candidate) => candidate.state === 'pending_approval');
    step!.escalations = [{ key: 'cb', trigger: 'sla_breach', action: 'callback' }];

    const findings = validateDefinition(document).findings;
    // The message says URLs are not accepted, because a definition that could name one
    // would be a request-forgery primitive.
    expect(findings.some((finding) => finding.message.includes('URLs are not accepted'))).toBe(
      true,
    );
  });
});

function errorCodesWithCallbacks(document: unknown, callbacks: string[]): string[] {
  return validateDefinition(document, { registeredCallbacks: callbacks })
    .findings.filter((finding) => finding.severity === 'error')
    .map((finding) => finding.code);
}

describe('warnings that must be seen but do not block', () => {
  it('reports self-approval every time it is enabled', () => {
    const document = clone(SIMPLE_APPROVAL);
    const step = document.steps.find((candidate) => candidate.state === 'pending_approval');
    step!.approval!.allowSelfApproval = true;

    const result = validateDefinition(document);
    // A warning, not an error: a two-person team may accept it, and refusing outright
    // would push them to work around the engine. But it must never pass unnoticed.
    expect(result.valid).toBe(true);
    expect(result.findings.map((finding) => finding.code)).toContain('self_approval_permitted');
  });

  it('reports one actor filling several approver slots', () => {
    const document = clone(SIMPLE_APPROVAL);
    const step = document.steps.find((candidate) => candidate.state === 'pending_approval');
    step!.approval!.allowSameActorMultipleSlots = true;

    expect(codes(document)).toContain('same_actor_multiple_slots');
  });

  it('reports an SLA with no escalation', () => {
    const document = clone(SIMPLE_APPROVAL);
    const step = document.steps.find((candidate) => candidate.state === 'pending_approval');
    step!.escalations = [];

    // The clock runs, a status turns red, and nothing happens.
    expect(codes(document)).toContain('sla_without_escalation');
  });

  it('reports a single point of approval', () => {
    expect(codes(SIMPLE_APPROVAL)).toContain('single_point_of_approval');
  });

  it('reports a condition on a field nothing declares', () => {
    const document = clone(SIMPLE_APPROVAL);
    const step = document.steps.find((candidate) => candidate.state === 'pending_approval');
    step!.requireAttachmentWhen = { field: 'riskRatng', operator: 'eq', value: 'high' };

    // Syntactically perfect and always false, which means a review that never happens.
    expect(codes(document)).toContain('condition_field_undeclared');
  });
});

// ===========================================================================
// Versioning
// ===========================================================================

describe('the definition hash', () => {
  it('is stable across key order', () => {
    // Without sorting, a round-trip through a JSON parser that does not preserve order
    // would look like tampering.
    expect(hashDefinition({ a: 1, b: { c: 2, d: 3 } })).toBe(
      hashDefinition({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it('preserves array order, because approver order is meaningful', () => {
    expect(hashDefinition({ a: [1, 2] })).not.toBe(hashDefinition({ a: [2, 1] }));
  });

  it('changes when any value changes', () => {
    const before = hashDefinition(CHANGE_REQUEST_APPROVAL);
    const after = hashDefinition({ ...CHANGE_REQUEST_APPROVAL, name: 'Changed' });
    expect(before).not.toBe(after);
  });
});

describe('the definition status machine', () => {
  it('allows the intended lifecycle', () => {
    expect(canTransitionStatus('draft', 'under_review')).toBe(true);
    expect(canTransitionStatus('under_review', 'approved')).toBe(true);
    expect(canTransitionStatus('approved', 'published')).toBe(true);
    expect(canTransitionStatus('published', 'retired')).toBe(true);
  });

  it('never lets a published version go back to draft', () => {
    expect(canTransitionStatus('published', 'draft')).toBe(false);
    expect(() => assertStatusTransition('published', 'draft')).toThrow(/immutable/);
  });

  it('makes retired terminal, so rollback is a republish rather than an un-retire', () => {
    expect(canTransitionStatus('retired', 'published')).toBe(false);
    expect(canTransitionStatus('retired', 'draft')).toBe(false);
  });

  it('allows withdrawal from review and from approved', () => {
    // So an author can edit again — visibly, rather than editing underneath a reviewer.
    expect(canTransitionStatus('under_review', 'draft')).toBe(true);
    expect(canTransitionStatus('approved', 'draft')).toBe(true);
  });
});

describe('comparing versions', () => {
  it('reports a removed state as breaking', () => {
    const next = clone(CHANGE_REQUEST_APPROVAL);
    next.states = next.states.filter((state) => state !== 'compliance_review');
    next.steps = next.steps.filter((step) => step.state !== 'compliance_review');
    next.transitions = next.transitions.filter(
      (transition) =>
        transition.from !== 'compliance_review' && transition.to !== 'compliance_review',
    );

    const comparison = compareDefinitions(CHANGE_REQUEST_APPROVAL, next);
    expect(comparison.breaking.some((entry) => entry.includes('compliance_review'))).toBe(true);
  });

  it('puts enabling self-approval in the control-weakening bucket', () => {
    const next = clone(CHANGE_REQUEST_APPROVAL);
    next.steps.find((step) => step.state === 'manager_review')!.approval!.allowSelfApproval = true;

    const comparison = compareDefinitions(CHANGE_REQUEST_APPROVAL, next);
    // A separate bucket from `breaking`, because the two need different readers: breaking
    // is an engineering question, a weakened control is a governance one.
    expect(
      comparison.controlWeakening.some((entry) => entry.includes('maker-checker control')),
    ).toBe(true);
    expect(comparison.breaking).not.toContain(expect.stringContaining('maker-checker'));
  });

  it('reports a removed transition permission as control weakening', () => {
    const next = clone(CHANGE_REQUEST_APPROVAL);
    delete next.transitions.find((transition) => transition.action === 'approve')!.permission;

    const comparison = compareDefinitions(CHANGE_REQUEST_APPROVAL, next);
    expect(comparison.controlWeakening.some((entry) => entry.includes('no longer requires'))).toBe(
      true,
    );
  });

  it('reports a removed attachment requirement as control weakening', () => {
    const previous = clone(CHANGE_REQUEST_APPROVAL);
    previous.steps.find((step) => step.state === 'manager_review')!.requireAttachment = true;
    delete previous.steps.find((step) => step.state === 'manager_review')!.requireAttachmentWhen;

    const next = clone(previous);
    next.steps.find((step) => step.state === 'manager_review')!.requireAttachment = false;

    const comparison = compareDefinitions(previous, next);
    expect(
      comparison.controlWeakening.some((entry) =>
        entry.includes('no longer requires an attachment'),
      ),
    ).toBe(true);
  });

  it('reports removing a rework limit as control weakening', () => {
    const next = clone(CHANGE_REQUEST_APPROVAL);
    next.rework.maxCycles = null;

    const comparison = compareDefinitions(CHANGE_REQUEST_APPROVAL, next);
    expect(comparison.controlWeakening.some((entry) => entry.includes('Rework limit'))).toBe(true);
  });

  it('reports a name change as cosmetic', () => {
    const next = clone(CHANGE_REQUEST_APPROVAL);
    next.name = 'Renamed';

    const comparison = compareDefinitions(CHANGE_REQUEST_APPROVAL, next);
    expect(comparison.cosmetic.some((entry) => entry.includes('Renamed'))).toBe(true);
    expect(comparison.breaking).toEqual([]);
    expect(comparison.controlWeakening).toEqual([]);
  });

  it('suggests a major version for a breaking change and a patch for a cosmetic one', () => {
    expect(
      suggestNextVersion('1.2.3', {
        breaking: ['State removed'],
        additive: [],
        cosmetic: [],
        controlWeakening: [],
      }).version,
    ).toBe('2.0.0');

    expect(
      suggestNextVersion('1.2.3', {
        breaking: [],
        additive: ['State added'],
        cosmetic: [],
        controlWeakening: [],
      }).version,
    ).toBe('1.3.0');

    expect(
      suggestNextVersion('1.2.3', {
        breaking: [],
        additive: [],
        cosmetic: ['Renamed'],
        controlWeakening: [],
      }).version,
    ).toBe('1.2.4');
  });
});

// ===========================================================================
// Simulation
// ===========================================================================

describe('simulation', () => {
  it('enumerates the paths through the example workflow', () => {
    const result = simulateDefinition(CHANGE_REQUEST_APPROVAL);

    expect(result.valid).toBe(true);
    expect(result.paths.length).toBeGreaterThan(3);
    // Every declared outcome is reachable, which is the check that no outcome is dead
    // configuration.
    expect(result.unreachableOutcomes).toEqual([]);
    expect(result.deadEnds).toEqual([]);
    expect(result.unreachableStates).toEqual([]);
  });

  it('finds no path to approval that requires no review', () => {
    // The single most important property of an approval workflow, and the one a reviewer
    // cannot verify by reading a 40-state document.
    const result = simulateDefinition(CHANGE_REQUEST_APPROVAL);
    const approvedWithoutReview = result.unapprovedPaths.filter(
      (path) => path.terminal === 'approved',
    );
    expect(approvedWithoutReview).toEqual([]);
  });

  it('reports a path that reaches a final state with no approval', () => {
    const document = clone(SIMPLE_APPROVAL);
    // A shortcut straight to approved, bypassing the approval step.
    document.transitions = [
      ...document.transitions,
      {
        action: 'fast_track',
        from: 'draft',
        to: 'approved',
        automatic: false,
        requiresReason: false,
        isRework: false,
        isRejection: false,
        isCancellation: false,
      },
    ];

    const result = simulateDefinition(document);
    expect(result.unapprovedPaths.length).toBeGreaterThan(0);
    expect(result.unapprovedPaths[0]?.terminal).toBe('approved');
  });

  it('reports the permissions the workflow requires of somebody', () => {
    const result = simulateDefinition(CHANGE_REQUEST_APPROVAL);
    expect(result.requiredPermissions).toContain('workflow.approval.decide');
    expect(result.requiredPermissions).toContain('workflow.instance.start');
  });

  it('reports SLA exposure longest first, flagging any with no escalation', () => {
    const result = simulateDefinition(CHANGE_REQUEST_APPROVAL);
    expect(result.slaRisks.length).toBeGreaterThan(0);

    const minutes = result.slaRisks.map((risk) => risk.minutes);
    expect(minutes).toEqual([...minutes].sort((a, b) => b - a));
  });

  it('reports a permission that approves at two steps as a separation concern', () => {
    // Two signatures from one population is one signature wearing a hat. The schema
    // cannot see this — it knows one step at a time.
    const result = simulateDefinition(CHANGE_REQUEST_APPROVAL);
    expect(
      result.separationOfDutyConcerns.some((concern) =>
        concern.includes('supposedly independent reviews'),
      ),
    ).toBe(true);
  });

  it('handles a rework loop without enumerating forever', () => {
    // The change-request example loops: rejected work returns to the maker and resubmits.
    // Bounding by edge rather than by state keeps the rework paths visible while still
    // terminating.
    const result = simulateDefinition(CHANGE_REQUEST_APPROVAL);
    expect(result.paths.some((path) => path.states.includes('returned_for_rework'))).toBe(true);
    expect(result.paths.length).toBeLessThanOrEqual(200);
  });

  it('reports findings for an invalid definition rather than throwing', () => {
    const result = simulateDefinition({ nonsense: true });
    expect(result.valid).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.paths).toEqual([]);
  });
});

// A small guard for a helper used above with an unusual call shape.
describe('the test helpers themselves', () => {
  it('detect an unregistered callback only when a registry is supplied', () => {
    const document = clone(SIMPLE_APPROVAL);
    const step = document.steps.find((candidate) => candidate.state === 'pending_approval');
    step!.escalations = [
      { key: 'cb', trigger: 'sla_breach', action: 'callback', callbackKey: 'known' },
    ];

    expect(errorCodesWithCallbacks(document, ['known'])).not.toContain('unregistered_callback');
    expect(errorCodesWithCallbacks(document, ['other'])).toContain('unregistered_callback');
  });
});
