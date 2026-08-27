import { conditionFields, describeCondition } from '@trustos/workflow-definition';
import {
  NON_ORDERABLE_FACTS,
  RULE_FACTS,
  isRuleFact,
  productRuleSchema,
  type ProductRule,
} from '@trustos/financial-product-core';

/**
 * Rule-set validation.
 *
 * The schema in `@trustos/financial-product-core` checks that a rule is *well-formed*. This
 * checks that a rule set is *sane*, which is a different and harder question — every problem
 * below produces a rule set that parses, validates, deploys and silently does the wrong thing.
 *
 * Six checks, and each one exists because the failure is invisible:
 *
 *   1. **An unknown fact.** `merchantTeir` never matches anything. The rule does not error; it
 *      simply never fires, and the gold-tier discount nobody is receiving is reported as working.
 *   2. **An ordering comparison on a string fact.** `amount gt 1000` compares a decimal string
 *      against a number, which is never true. The enhanced-review threshold is off.
 *   3. **A rule shadowed by a broader one at a lower priority.** The second rule is dead. This is
 *      the one that produces "we changed the rate and nothing happened".
 *   4. **Two rules at the same priority writing the same slot.** The winner depends on the id
 *      tiebreak, which is stable but arbitrary — and arbitrary is not something a fee should be.
 *   5. **A `route` to a block the product does not contain.** The runtime would refuse at
 *      execution time, on a live transaction, rather than at composition time on a draft.
 *   6. **A rule that can never match**, because its condition contradicts itself.
 *
 * Findings are graded. An `error` refuses the product; a `warning` is recorded and shown to the
 * reviewer. The split matters: a shadowed rule is usually a mistake and occasionally a
 * deliberate override left in place for documentation, and refusing the second case outright
 * would make the validator something people work around.
 */

export interface RuleFinding {
  severity: 'error' | 'warning';
  ruleId: string;
  code:
    | 'unknown_fact'
    | 'ordering_on_string_fact'
    | 'shadowed_rule'
    | 'ambiguous_priority'
    | 'unknown_route_target'
    | 'contradictory_condition'
    | 'unreachable_after_deny';
  message: string;
  remediation: string;
}

export interface RuleValidationResult {
  valid: boolean;
  findings: RuleFinding[];
}

export interface ValidateRulesOptions {
  /** Block keys the product declares. A `route` outcome must name one of them. */
  blockKeys?: readonly string[];
  /** Fee codes the product declares, so a `set_fee` for an unknown code is caught. */
  feeCodes?: readonly string[];
  /** Limit codes the product declares. */
  limitCodes?: readonly string[];
}

export function validateRules(
  input: readonly unknown[],
  options: ValidateRulesOptions = {},
): RuleValidationResult {
  const rules = input.map((rule) => productRuleSchema.parse(rule));
  const findings: RuleFinding[] = [];

  const blockKeys = new Set(options.blockKeys ?? []);
  const feeCodes = new Set(options.feeCodes ?? []);
  const limitCodes = new Set(options.limitCodes ?? []);

  for (const rule of rules) {
    findings.push(...factFindings(rule));
    findings.push(...outcomeFindings(rule, blockKeys, feeCodes, limitCodes));
    findings.push(...contradictionFindings(rule));
  }

  findings.push(...shadowFindings(rules));
  findings.push(...priorityFindings(rules));
  findings.push(...denyFindings(rules));

  return { valid: !findings.some((finding) => finding.severity === 'error'), findings };
}

function factFindings(rule: ProductRule): RuleFinding[] {
  const findings: RuleFinding[] = [];

  for (const field of conditionFields(rule.when)) {
    if (!isRuleFact(field)) {
      findings.push({
        severity: 'error',
        ruleId: rule.id,
        code: 'unknown_fact',
        message:
          `Rule "${rule.id}" reads "${field}", which is not a fact the runtime supplies. The ` +
          'rule would never fire, and a rule that never fires is a control that is not running.',
        remediation: `Use one of: ${RULE_FACTS.join(', ')}.`,
      });
    }
  }

  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const record = node as Record<string, unknown>;

    if (Array.isArray(record.all)) return record.all.forEach(walk);
    if (Array.isArray(record.any)) return record.any.forEach(walk);
    if (record.not) return walk(record.not);

    const field = record.field;
    const operator = record.operator;
    if (typeof field !== 'string' || typeof operator !== 'string') return;

    if (['gt', 'gte', 'lt', 'lte'].includes(operator) && NON_ORDERABLE_FACTS.has(field)) {
      findings.push({
        severity: 'error',
        ruleId: rule.id,
        code: 'ordering_on_string_fact',
        message:
          `Rule "${rule.id}" compares "${field}" with "${operator}". That fact is a string, so ` +
          'the comparison is never true — and "never true" looks exactly like "the condition ' +
          'was not met".',
        remediation:
          field === 'amount'
            ? 'Compare against `amountMinorUnits`, which is the integer form.'
            : 'Use `eq`, `neq`, `in` or `nin` for a string fact.',
      });
    }
  };

  walk(rule.when);
  return findings;
}

function outcomeFindings(
  rule: ProductRule,
  blockKeys: Set<string>,
  feeCodes: Set<string>,
  limitCodes: Set<string>,
): RuleFinding[] {
  const findings: RuleFinding[] = [];

  for (const outcome of rule.then) {
    if (outcome.kind === 'route' && blockKeys.size > 0 && !blockKeys.has(outcome.toBlock)) {
      findings.push({
        severity: 'error',
        ruleId: rule.id,
        code: 'unknown_route_target',
        message:
          `Rule "${rule.id}" routes to "${outcome.toBlock}", which this product does not ` +
          'contain. The runtime would refuse at execution time, on a live transaction, rather ' +
          'than here on a draft.',
        remediation: `Route to one of: ${[...blockKeys].join(', ')}.`,
      });
    }

    if (outcome.kind === 'set_fee' && feeCodes.size > 0 && !feeCodes.has(outcome.feeCode)) {
      findings.push({
        severity: 'warning',
        ruleId: rule.id,
        code: 'unknown_route_target',
        message:
          `Rule "${rule.id}" sets fee "${outcome.feeCode}", which the product does not declare. ` +
          'The override applies to nothing.',
        remediation: `Declare the fee, or set one of: ${[...feeCodes].join(', ')}.`,
      });
    }

    if (outcome.kind === 'set_limit' && limitCodes.size > 0 && !limitCodes.has(outcome.limitCode)) {
      findings.push({
        severity: 'warning',
        ruleId: rule.id,
        code: 'unknown_route_target',
        message:
          `Rule "${rule.id}" sets limit "${outcome.limitCode}", which the product does not ` +
          'declare. The override applies to nothing.',
        remediation: `Declare the limit, or set one of: ${[...limitCodes].join(', ')}.`,
      });
    }
  }

  return findings;
}

/**
 * A condition that contradicts itself.
 *
 * Only the shallow case is detected: two comparisons on the same field inside one `all` whose
 * ranges cannot overlap. Deeper contradictions need a solver, and a validator that occasionally
 * proves unsatisfiability and usually does not is worse than one whose limits are stated — a
 * reviewer stops checking the thing the tool claims to check.
 */
function contradictionFindings(rule: ProductRule): RuleFinding[] {
  const node = rule.when as Record<string, unknown>;
  if (!Array.isArray(node.all)) return [];

  const comparisons = node.all.filter(
    (child): child is { field: string; operator: string; value: unknown } =>
      typeof child === 'object' &&
      child !== null &&
      typeof (child as Record<string, unknown>).field === 'string',
  );

  for (const left of comparisons) {
    for (const right of comparisons) {
      if (left === right || left.field !== right.field) continue;

      const impossible =
        (left.operator === 'eq' && right.operator === 'eq' && left.value !== right.value) ||
        (left.operator === 'eq' && right.operator === 'neq' && left.value === right.value) ||
        (left.operator === 'gt' &&
          right.operator === 'lt' &&
          typeof left.value === 'number' &&
          typeof right.value === 'number' &&
          left.value >= right.value);

      if (impossible) {
        return [
          {
            severity: 'error',
            ruleId: rule.id,
            code: 'contradictory_condition',
            message:
              `Rule "${rule.id}" cannot match: ${describeCondition(rule.when)}. It parses and ` +
              'deploys and does nothing.',
            remediation: 'Split it into two rules, or use `any` instead of `all`.',
          },
        ];
      }
    }
  }

  return [];
}

/**
 * A rule made dead by a broader one at a lower priority.
 *
 * Detected structurally rather than semantically: a rule whose condition is a strict superset of
 * a later rule's, writing the same slot. The common shape is a base rate declared at priority 0
 * with `exists` and a tier rate at priority 10 — the tier never applies, and the symptom is "we
 * changed the rate and nothing happened".
 */
function shadowFindings(rules: readonly ProductRule[]): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const ordered = [...rules]
    .filter((rule) => rule.enabled)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));

  for (let index = 0; index < ordered.length; index += 1) {
    const earlier = ordered[index]!;
    if (!isCatchAll(earlier)) continue;

    for (const later of ordered.slice(index + 1)) {
      const shared = sharedSlots(earlier, later);
      if (shared.length === 0) continue;

      findings.push({
        severity: 'warning',
        ruleId: later.id,
        code: 'shadowed_rule',
        message:
          `Rule "${later.id}" is shadowed by "${earlier.id}" (priority ${earlier.priority}), ` +
          `which matches everything and already sets ${shared.join(', ')}. The later rule is ` +
          'dead, and the symptom is that changing it has no effect.',
        remediation:
          `Give "${later.id}" a lower priority number than "${earlier.id}", or narrow ` +
          `"${earlier.id}" so it is a fallback rather than a catch-all.`,
      });
    }
  }

  return findings;
}

/** Whether a rule's condition matches essentially everything. */
function isCatchAll(rule: ProductRule): boolean {
  const node = rule.when as Record<string, unknown>;
  return typeof node.field === 'string' && node.operator === 'exists';
}

/** The slots two rules both write. */
function sharedSlots(left: ProductRule, right: ProductRule): string[] {
  const slots = (rule: ProductRule): string[] =>
    rule.then.map((outcome) => {
      switch (outcome.kind) {
        case 'set_fee':
          return `fee:${outcome.feeCode}`;
        case 'set_limit':
          return `limit:${outcome.limitCode}`;
        case 'select_provider':
          return `provider:${outcome.providerInterface}`;
        case 'set_risk_level':
          return 'riskLevel';
        case 'route':
          return 'route';
        default:
          return `accumulating:${outcome.kind}`;
      }
    });

  const earlier = new Set(slots(left).filter((slot) => !slot.startsWith('accumulating:')));
  return slots(right).filter((slot) => earlier.has(slot));
}

/** Two rules at the same priority writing the same slot. The winner is stable but arbitrary. */
function priorityFindings(rules: readonly ProductRule[]): RuleFinding[] {
  const findings: RuleFinding[] = [];
  const byPriority = new Map<number, ProductRule[]>();

  for (const rule of rules) {
    if (!rule.enabled) continue;
    byPriority.set(rule.priority, [...(byPriority.get(rule.priority) ?? []), rule]);
  }

  for (const [priority, group] of byPriority) {
    for (let index = 0; index < group.length; index += 1) {
      for (const other of group.slice(index + 1)) {
        const shared = sharedSlots(group[index]!, other);
        if (shared.length === 0) continue;

        findings.push({
          severity: 'warning',
          ruleId: other.id,
          code: 'ambiguous_priority',
          message:
            `Rules "${group[index]!.id}" and "${other.id}" are both at priority ${priority} and ` +
            `both set ${shared.join(', ')}. The winner is decided by an id tiebreak — stable, ` +
            'but not a basis for a fee.',
          remediation: 'Give them distinct priorities so the intended one is visible.',
        });
      }
    }
  }

  return findings;
}

/** Rules that can never run because a catch-all deny sits at a lower priority. */
function denyFindings(rules: readonly ProductRule[]): RuleFinding[] {
  const ordered = [...rules]
    .filter((rule) => rule.enabled)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));

  const denyIndex = ordered.findIndex(
    (rule) => isCatchAll(rule) && rule.then.some((outcome) => outcome.kind === 'deny'),
  );

  if (denyIndex === -1) return [];

  return ordered.slice(denyIndex + 1).map((rule) => ({
    severity: 'error' as const,
    ruleId: rule.id,
    code: 'unreachable_after_deny' as const,
    message:
      `Rule "${rule.id}" is unreachable: "${ordered[denyIndex]!.id}" denies every transaction at ` +
      `priority ${ordered[denyIndex]!.priority}, and evaluation stops at a denial.`,
    remediation: `Narrow "${ordered[denyIndex]!.id}", or raise its priority number above this rule's.`,
  }));
}
