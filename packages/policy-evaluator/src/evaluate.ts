import { ApiError } from '@trustsystem/errors';
import {
  conditionFields,
  describeCondition,
  evaluateCondition,
} from '@trustsystem/workflow-definition';
import type { Obligation, PolicyDocument, PolicyRule } from '@trustsystem/policy-registry';

/**
 * Policy evaluation.
 *
 * Deterministic: no clock, no I/O, no randomness. Given the same policy version and the same
 * attributes it returns the same decision on any machine in any year — which is what makes a
 * decision log worth keeping, because a logged decision can be **re-derived** rather than merely
 * believed.
 *
 * Three properties, and the third is the one that separates this from a rules engine:
 *
 * **First match wins, by priority.** Rules are ordered by priority and then by id — the id
 * tiebreak matters because two rules at the same priority would otherwise be ordered by however
 * the array arrived, and an array arrives from a database, a file or a merge.
 *
 * **The default is deny.** Not "no opinion". A policy that matched nothing has decided, and it has
 * decided no.
 *
 * **An obligation the caller does not understand is a denial.** `assertObligationsUnderstood`
 * takes the vocabulary the caller supports and refuses anything outside it. Without that rule, a
 * caller silently ignoring an unknown obligation turns every future obligation into a no-op for
 * every existing caller — and obligations are added precisely when a permission needs a
 * condition attached.
 */

export type PolicyAttributes = Record<string, string | number | boolean | null>;

export interface PolicyTraceEntry {
  ruleId: string;
  priority: number;
  matched: boolean;
  condition: string;
  effect: 'allow' | 'deny';
  /** Rules after the deciding one, which were not evaluated. */
  skipped: boolean;
}

export interface PolicyDecision {
  decision: 'ALLOW' | 'DENY';
  policyId: string;
  policyVersion: string;
  /** The rule that decided, or null when the default applied. */
  ruleId: string | null;
  /** Why. Quoted back to whoever it refused. */
  reasons: string[];
  obligations: Obligation[];
  /** Every rule considered, in evaluation order. The re-derivation an auditor performs. */
  trace: PolicyTraceEntry[];
  /** Attributes the policy read that were not supplied. A rule reading a missing attribute never fires. */
  missingAttributes: string[];
}

/**
 * Evaluates a policy.
 *
 * `missingAttributes` is worth understanding before using the result. A rule whose condition reads
 * an attribute the caller did not supply **does not match** — a missing attribute is not false and
 * not true, it is absent, and a comparison against absent is not a match. That means a caller who
 * forgets to supply `amount` gets a policy that silently stops enforcing its amount threshold.
 *
 * So the missing ones are collected and returned. A caller that ignores them is a caller whose
 * policy is quietly not running, and the field exists so that "quietly" is a choice rather than a
 * default.
 */
export function evaluatePolicy(
  policy: PolicyDocument,
  attributes: PolicyAttributes,
): PolicyDecision {
  const ordered = [...policy.rules].sort(
    (left, right) => left.priority - right.priority || left.ruleId.localeCompare(right.ruleId),
  );

  const trace: PolicyTraceEntry[] = [];
  const missing = new Set<string>();
  let decided: PolicyRule | null = null;

  for (const rule of ordered) {
    if (decided) {
      trace.push({
        ruleId: rule.ruleId,
        priority: rule.priority,
        matched: false,
        condition: describeCondition(rule.when),
        effect: rule.effect,
        skipped: true,
      });
      continue;
    }

    for (const field of conditionFields(rule.when)) {
      if (!(field in attributes)) missing.add(field);
    }

    const matched = evaluateCondition(rule.when, attributes as Record<string, unknown>);

    trace.push({
      ruleId: rule.ruleId,
      priority: rule.priority,
      matched,
      condition: describeCondition(rule.when),
      effect: rule.effect,
      skipped: false,
    });

    if (matched) decided = rule;
  }

  if (!decided) {
    return {
      decision: 'DENY',
      policyId: policy.policyId,
      policyVersion: policy.version,
      ruleId: null,
      reasons: [
        `No rule of ${policy.policyId} matched, and the default is deny. A policy that matched ` +
          'nothing has decided, and it has decided no.',
      ],
      obligations: [],
      trace,
      missingAttributes: [...missing].sort(),
    };
  }

  return {
    decision: decided.effect === 'allow' ? 'ALLOW' : 'DENY',
    policyId: policy.policyId,
    policyVersion: policy.version,
    ruleId: decided.ruleId,
    reasons: [decided.reason],
    obligations: decided.obligations,
    trace,
    missingAttributes: [...missing].sort(),
  };
}

/**
 * Refuses a decision carrying an obligation the caller cannot honour.
 *
 * The rule that makes obligations safe. A caller that ignored an unknown obligation would turn
 * every future obligation into a no-op for every existing caller — and obligations are added
 * exactly when a permission needs a condition attached, so silently dropping one converts a
 * conditional permission into an unconditional one.
 */
export function assertObligationsUnderstood(
  decision: PolicyDecision,
  supported: readonly string[],
): void {
  if (decision.decision === 'DENY') return;

  const understood = new Set(supported);
  const unknown = decision.obligations.filter((obligation) => !understood.has(obligation.kind));

  if (unknown.length === 0) return;

  throw new ApiError('forbidden', {
    message:
      `This decision carries obligations this caller cannot honour: ` +
      `${unknown.map((obligation) => obligation.kind).join(', ')}. An unhonoured obligation ` +
      'turns a conditional permission into an unconditional one, so the answer is deny.',
    context: {
      policyId: decision.policyId,
      policyVersion: decision.policyVersion,
      unknown: unknown.map((obligation) => obligation.kind).join(','),
    },
  });
}

/** The decision as lines a person reads. What an appeal or an investigation is answered with. */
export function explainDecision(decision: PolicyDecision): string[] {
  const lines = [
    `${decision.decision} — ${decision.policyId}@${decision.policyVersion}` +
      (decision.ruleId ? ` by rule "${decision.ruleId}"` : ' by the default'),
    '',
    ...decision.reasons.map((reason) => `  ${reason}`),
  ];

  if (decision.obligations.length > 0) {
    lines.push('', '  obligations:');
    for (const obligation of decision.obligations) {
      lines.push(`    ${obligation.kind} — ${obligation.description}`);
    }
  }

  lines.push('', '  evaluation:');
  for (const entry of decision.trace) {
    const outcome = entry.skipped ? 'not evaluated' : entry.matched ? 'MATCHED' : 'no match';
    lines.push(`    ${entry.ruleId} (p${entry.priority}) ${outcome} — ${entry.condition}`);
  }

  if (decision.missingAttributes.length > 0) {
    lines.push(
      '',
      `  ${decision.missingAttributes.length} attribute(s) the policy reads were not supplied: ` +
        `${decision.missingAttributes.join(', ')}. A rule reading a missing attribute never ` +
        'fires, so those rules did not run.',
    );
  }

  return lines;
}

export interface PolicyTestResult {
  name: string;
  passed: boolean;
  expected: 'allow' | 'deny';
  actual: 'ALLOW' | 'DENY';
  expectedRuleId?: string;
  actualRuleId: string | null;
}

/**
 * Runs a policy's own test cases.
 *
 * The gate a policy passes before it may be activated. A policy is configuration with
 * consequences, and configuration with consequences that nobody tested is the change that goes
 * out on a Friday.
 */
export function runPolicyTests(policy: PolicyDocument): {
  results: PolicyTestResult[];
  passed: boolean;
} {
  const results = policy.testCases.map((testCase) => {
    const decision = evaluatePolicy(policy, testCase.attributes);
    const expected = testCase.expect === 'allow' ? 'ALLOW' : 'DENY';

    return {
      name: testCase.name,
      passed:
        decision.decision === expected &&
        (testCase.expectedRuleId === undefined || decision.ruleId === testCase.expectedRuleId),
      expected: testCase.expect,
      actual: decision.decision,
      ...(testCase.expectedRuleId ? { expectedRuleId: testCase.expectedRuleId } : {}),
      actualRuleId: decision.ruleId,
    };
  });

  return { results, passed: results.every((result) => result.passed) };
}

export interface PolicyFinding {
  severity: 'error' | 'warning';
  ruleId: string;
  code: 'unreachable' | 'shadowed' | 'ambiguous_priority' | 'no_effect' | 'test_failure';
  message: string;
}

/**
 * Static analysis over a policy.
 *
 * Four findings, and each one describes a policy that parses, activates and does something other
 * than what its author meant:
 *
 *   * **unreachable** — a rule below a catch-all at a lower priority. Dead.
 *   * **shadowed** — the same, for a rule whose condition is a subset of an earlier one's.
 *   * **ambiguous_priority** — two rules at one priority with different effects. The winner is
 *     the id tiebreak: stable, and not a basis for a security decision.
 *   * **no_effect** — a policy of nothing but denials, which is identical to the default and
 *     usually means somebody inverted a condition.
 */
export function analysePolicy(policy: PolicyDocument): PolicyFinding[] {
  const findings: PolicyFinding[] = [];

  const ordered = [...policy.rules].sort(
    (left, right) => left.priority - right.priority || left.ruleId.localeCompare(right.ruleId),
  );

  const catchAllIndex = ordered.findIndex((rule) => isCatchAll(rule));

  if (catchAllIndex !== -1) {
    for (const rule of ordered.slice(catchAllIndex + 1)) {
      findings.push({
        severity: 'error',
        ruleId: rule.ruleId,
        code: 'unreachable',
        message:
          `"${rule.ruleId}" is unreachable: "${ordered[catchAllIndex]!.ruleId}" matches everything ` +
          `at priority ${ordered[catchAllIndex]!.priority}, and the first match decides.`,
      });
    }
  }

  const byPriority = new Map<number, PolicyRule[]>();
  for (const rule of ordered) {
    byPriority.set(rule.priority, [...(byPriority.get(rule.priority) ?? []), rule]);
  }

  for (const [priority, group] of byPriority) {
    if (group.length < 2) continue;
    if (new Set(group.map((rule) => rule.effect)).size < 2) continue;

    findings.push({
      severity: 'warning',
      ruleId: group[1]!.ruleId,
      code: 'ambiguous_priority',
      message:
        `${group.map((rule) => rule.ruleId).join(' and ')} are all at priority ${priority} with ` +
        'different effects. The winner is an id tiebreak — stable, and not a basis for a ' +
        'security decision.',
    });
  }

  if (policy.rules.every((rule) => rule.effect === 'deny')) {
    findings.push({
      severity: 'warning',
      ruleId: policy.rules[0]!.ruleId,
      code: 'no_effect',
      message:
        'Every rule denies, which is identical to the default. Either the policy is redundant or ' +
        'a condition is inverted — and the second is far more common.',
    });
  }

  const tests = runPolicyTests(policy);

  for (const result of tests.results) {
    if (result.passed) continue;

    findings.push({
      severity: 'error',
      ruleId: result.actualRuleId ?? '(default)',
      code: 'test_failure',
      message:
        `The test "${result.name}" expected ${result.expected.toUpperCase()} and got ` +
        `${result.actual}${result.expectedRuleId ? ` from "${result.actualRuleId}" rather than "${result.expectedRuleId}"` : ''}.`,
    });
  }

  return findings;
}

function isCatchAll(rule: PolicyRule): boolean {
  const node = rule.when as Record<string, unknown>;
  return typeof node.field === 'string' && node.operator === 'exists';
}
