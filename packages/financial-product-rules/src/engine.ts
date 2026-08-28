import { evaluateCondition, describeCondition } from '@trustos/workflow-definition';
import type { ProductRule, RuleOutcome } from '@trustos/financial-product-core';
import type { RuleFacts } from './facts';

/**
 * The rules engine.
 *
 * Deterministic, and every word of that is load-bearing: no clock, no I/O, no randomness, no
 * ordering that depends on anything but the declared priority. Given the same rules and the same
 * facts it produces the same decision and the same explanation, on any machine, in any year. That
 * is what makes "why was this transaction charged 2.47" answerable six months later, and it is
 * why the fact map is built before evaluation rather than read during it.
 *
 * **Conflict resolution is first-wins by priority, per slot.** A slot is a thing a rule can
 * decide: a fee code, a limit code, a provider interface, the risk level. Two rules writing the
 * same slot is normal — a base rate and a gold-tier rate — and the lower priority number wins.
 * The loser is not dropped: it is recorded in the trace as superseded, because "the gold rate did
 * not apply" is a question somebody asks, and an engine that silently discards has no answer.
 *
 * Reviews and tags **accumulate** rather than compete. Two rules both demanding compliance review
 * is one review; two rules demanding different levels is two reviews. Collapsing them to
 * first-wins would let a lower-priority rule's mandatory review vanish behind a higher-priority
 * one's, which is a control removed by an ordering decision nobody made deliberately.
 *
 * A `deny` **stops evaluation**. Everything after it is irrelevant to a transaction that is not
 * happening, and continuing would produce a decision listing a fee for a refused payment — which
 * gets read as "we charged them anyway".
 */

export interface RuleTraceEntry {
  ruleId: string;
  priority: number;
  matched: boolean;
  /** Readable rendering of the condition. What an auditor reads instead of nested JSON. */
  condition: string;
  /** Outcomes this rule produced, and whether each one took effect. */
  outcomes: Array<{ outcome: RuleOutcome; applied: boolean; supersededBy?: string }>;
  skippedReason?: 'disabled' | 'after_deny';
}

export interface RuleDecision {
  /** Fee overrides, keyed by fee code. */
  fees: Record<string, Extract<RuleOutcome, { kind: 'set_fee' }>>;
  /** Limit overrides, keyed by limit code. */
  limits: Record<string, Extract<RuleOutcome, { kind: 'set_limit' }>>;
  /** Chosen connector per provider interface. */
  providers: Record<string, string>;
  /** Reviews demanded, accumulated and de-duplicated by level. */
  reviews: Array<{ level: string; reason: string; ruleId: string }>;
  /** Tags, sorted and unique. */
  tags: string[];
  /** The risk level a rule set, if one did. */
  riskLevel: string | null;
  /** A block the execution should route to, if a rule said so. */
  routeTo: string | null;
  /** The refusal, when a rule denied. Everything else is still reported for the record. */
  denied: { code: string; reason: string; ruleId: string } | null;
  trace: RuleTraceEntry[];
}

export function emptyDecision(): RuleDecision {
  return {
    fees: {},
    limits: {},
    providers: {},
    reviews: [],
    tags: [],
    riskLevel: null,
    routeTo: null,
    denied: null,
    trace: [],
  };
}

/**
 * Evaluates a rule set against a fact map.
 *
 * Rules are sorted by priority and then by id. The tiebreak on id is not decoration: two rules at
 * the same priority would otherwise be ordered by however the array arrived, and the array
 * arrives from a database, a JSON file or a variant merge — three orders that agree until one of
 * them does not, at which point the fee changes with no change to any rule.
 */
export function evaluateRules(rules: readonly ProductRule[], facts: RuleFacts): RuleDecision {
  const decision = emptyDecision();
  const data = facts as Record<string, unknown>;

  const ordered = [...rules].sort(
    (left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
  );

  const seenReviewLevels = new Set<string>();
  const tags = new Set<string>();

  for (const rule of ordered) {
    if (!rule.enabled) {
      decision.trace.push({
        ruleId: rule.id,
        priority: rule.priority,
        matched: false,
        condition: describeCondition(rule.when),
        outcomes: [],
        skippedReason: 'disabled',
      });
      continue;
    }

    if (decision.denied) {
      decision.trace.push({
        ruleId: rule.id,
        priority: rule.priority,
        matched: false,
        condition: describeCondition(rule.when),
        outcomes: [],
        skippedReason: 'after_deny',
      });
      continue;
    }

    const matched = evaluateCondition(rule.when, data);
    const entry: RuleTraceEntry = {
      ruleId: rule.id,
      priority: rule.priority,
      matched,
      condition: describeCondition(rule.when),
      outcomes: [],
    };

    if (!matched) {
      decision.trace.push(entry);
      continue;
    }

    for (const outcome of rule.then) {
      const applied = apply(decision, outcome, rule.id, seenReviewLevels, tags);
      entry.outcomes.push(applied);
      if (decision.denied) break;
    }

    decision.trace.push(entry);
  }

  decision.tags = [...tags].sort();
  return decision;
}

function apply(
  decision: RuleDecision,
  outcome: RuleOutcome,
  ruleId: string,
  seenReviewLevels: Set<string>,
  tags: Set<string>,
): { outcome: RuleOutcome; applied: boolean; supersededBy?: string } {
  switch (outcome.kind) {
    case 'set_fee': {
      const existing = decision.fees[outcome.feeCode];
      if (existing) return { outcome, applied: false, supersededBy: existing.feeCode };
      decision.fees[outcome.feeCode] = outcome;
      return { outcome, applied: true };
    }

    case 'set_limit': {
      const existing = decision.limits[outcome.limitCode];
      if (existing) return { outcome, applied: false, supersededBy: existing.limitCode };
      decision.limits[outcome.limitCode] = outcome;
      return { outcome, applied: true };
    }

    case 'select_provider': {
      const existing = decision.providers[outcome.providerInterface];
      if (existing) return { outcome, applied: false, supersededBy: existing };
      decision.providers[outcome.providerInterface] = outcome.connectorId;
      return { outcome, applied: true };
    }

    case 'require_review': {
      // Accumulates. A lower-priority rule's mandatory review must not vanish behind a
      // higher-priority one's.
      if (seenReviewLevels.has(outcome.level)) return { outcome, applied: false };
      seenReviewLevels.add(outcome.level);
      decision.reviews.push({ level: outcome.level, reason: outcome.reason, ruleId });
      return { outcome, applied: true };
    }

    case 'tag': {
      const already = tags.has(outcome.tag);
      tags.add(outcome.tag);
      return { outcome, applied: !already };
    }

    case 'set_risk_level': {
      if (decision.riskLevel) return { outcome, applied: false, supersededBy: decision.riskLevel };
      decision.riskLevel = outcome.level;
      return { outcome, applied: true };
    }

    case 'route': {
      if (decision.routeTo) return { outcome, applied: false, supersededBy: decision.routeTo };
      decision.routeTo = outcome.toBlock;
      return { outcome, applied: true };
    }

    case 'deny': {
      decision.denied = { code: outcome.code, reason: outcome.reason, ruleId };
      return { outcome, applied: true };
    }
  }
}

/**
 * The decision as lines a person reads.
 *
 * The explanation is not a debugging aid — it is the answer to a customer complaint and a
 * regulator's question, and it is generated from the same structure the runtime acted on rather
 * than reconstructed afterwards. A trace assembled separately from the decision is a trace that
 * eventually describes a different decision.
 */
export function explainDecision(decision: RuleDecision): string[] {
  const lines: string[] = [];

  for (const entry of decision.trace) {
    if (entry.skippedReason === 'disabled') {
      lines.push(`${entry.ruleId} (p${entry.priority}): skipped — disabled.`);
      continue;
    }
    if (entry.skippedReason === 'after_deny') {
      lines.push(`${entry.ruleId} (p${entry.priority}): not evaluated — an earlier rule denied.`);
      continue;
    }
    if (!entry.matched) {
      lines.push(`${entry.ruleId} (p${entry.priority}): no match — ${entry.condition}.`);
      continue;
    }

    for (const applied of entry.outcomes) {
      const verb = applied.applied ? 'applied' : 'superseded';
      lines.push(
        `${entry.ruleId} (p${entry.priority}): ${verb} ${describeOutcome(applied.outcome)}.`,
      );
    }
  }

  if (decision.denied) {
    lines.push(
      `Refused by ${decision.denied.ruleId}: ${decision.denied.reason} [${decision.denied.code}].`,
    );
  }

  return lines;
}

function describeOutcome(outcome: RuleOutcome): string {
  switch (outcome.kind) {
    case 'set_fee':
      return outcome.basis === 'flat'
        ? `fee ${outcome.feeCode} = ${outcome.flat?.minorUnits} ${outcome.flat?.currency}`
        : `fee ${outcome.feeCode} = ${formatRate(outcome.rate?.hundredthsOfBasisPoint)}`;
    case 'set_limit':
      return `limit ${outcome.limitCode} = ${outcome.amount.minorUnits} ${outcome.amount.currency}`;
    case 'select_provider':
      return `${outcome.providerInterface} -> ${outcome.connectorId}`;
    case 'require_review':
      return `review by ${outcome.level} (${outcome.reason})`;
    case 'tag':
      return `tag ${outcome.tag}`;
    case 'set_risk_level':
      return `risk level ${outcome.level}`;
    case 'route':
      return `route to ${outcome.toBlock}`;
    case 'deny':
      return `deny (${outcome.code})`;
  }
}

/**
 * A rate as a percentage, for display only.
 *
 * One basis point is 0.01%, so a hundredth of a basis point is 0.0001% and there are 10,000 of
 * them in one percent. 5000 units is therefore 0.5%.
 *
 * Integer arithmetic throughout — `BigInt` division for the whole part and string padding for the
 * fraction, never a division that produces a double. That is deliberate in a function whose only
 * job is to produce a string, because this is exactly the function somebody later copies into a
 * fee calculation, and the copy inherits whichever choice was made here.
 */
export function formatRate(hundredthsOfBasisPoint: string | undefined): string {
  if (!hundredthsOfBasisPoint) return 'unspecified';

  const HUNDREDTHS_OF_A_BASIS_POINT_PER_PERCENT = 10_000n;

  const units = BigInt(hundredthsOfBasisPoint);
  const whole = units / HUNDREDTHS_OF_A_BASIS_POINT_PER_PERCENT;
  const fraction = (units % HUNDREDTHS_OF_A_BASIS_POINT_PER_PERCENT)
    .toString()
    .padStart(4, '0')
    .replace(/0+$/, '');

  return fraction.length > 0 ? `${whole}.${fraction}%` : `${whole}%`;
}
