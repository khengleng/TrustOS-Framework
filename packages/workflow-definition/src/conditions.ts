import { ApiError } from '@trustsystem/errors';
import { z } from 'zod';

/**
 * The condition language.
 *
 * Conditions decide approval paths: "route to compliance when the amount exceeds
 * 100000", "require an attachment when the risk is high". They are written by
 * administrators in a definition document and evaluated against instance data.
 *
 * They are therefore **untrusted input that influences an authorization outcome**,
 * which rules out every convenient option:
 *
 *   * `eval` and `new Function` execute arbitrary code with the process's
 *     privileges. A definition author becomes a remote code executor.
 *   * A general expression library is a large parser reachable from user input, and
 *     most of them offer property access, function calls or prototype traversal.
 *     `constructor.constructor('return process')()` is the classic escape.
 *   * A template language is the same problem wearing a different syntax.
 *
 * So this is a **structured predicate tree**, not an expression string. There is no
 * parser and no evaluator loop that could be tricked into calling something: the
 * shape is a zod schema, evaluation is a `switch` over eleven operators, and every
 * operator does one comparison. The language cannot call a function because it has
 * no syntax for one.
 *
 * The cost is that conditions are verbose in JSON. That is the right trade: a
 * condition is written once by an administrator and read by an auditor, and
 * "unambiguous" beats "terse" for both.
 */

export const CONDITION_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'contains',
  'exists',
  'missing',
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/**
 * A field reference.
 *
 * Dotted path into the instance data, with a deliberately narrow character set:
 * letters, digits and underscores between dots. That excludes `$`, brackets and
 * everything else that could construct an unexpected property access.
 *
 * It does **not** exclude `__proto__`, and that is worth stating plainly rather than
 * assuming: `_` is a legal identifier character, so `__proto__`, `constructor` and
 * `prototype` all match the pattern. A test asserting they were refused by the
 * character set alone failed, which is how this comment came to be accurate.
 *
 * So there are two defences, and both are needed:
 *
 *   1. `RESERVED_SEGMENTS` below refuses those three names outright.
 *   2. `readField` accesses own properties only, so even a name that somehow got
 *      through would not return an inherited value.
 *
 * Array indices are not supported. A condition that depends on the third element of
 * a list is a condition that breaks when the list is reordered, and an approval path
 * that changes when a list is reordered is not a control.
 */
const FIELD_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;

/**
 * Path segments that are never a data field.
 *
 * Short and closed, because these are the three names that reach the prototype chain
 * in JavaScript. A longer list would be guesswork; these are the ones that matter, and
 * `readField`'s own-property check is what covers anything else.
 */
const RESERVED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafeFieldPath(path: string): boolean {
  if (!FIELD_PATTERN.test(path)) return false;
  return path.split('.').every((segment) => !RESERVED_SEGMENTS.has(segment));
}

/** Values a condition may compare against. No objects, no functions. */
const literalSchema = z.union([z.string().max(400), z.number(), z.boolean(), z.null()]);

export type ConditionLiteral = z.infer<typeof literalSchema>;

const comparisonSchema = z
  .object({
    field: z
      .string()
      .min(1)
      .max(200)
      .refine(isSafeFieldPath, {
        message:
          'A field must be a dotted path of letters, digits and underscores, and no segment ' +
          'may be __proto__, constructor or prototype.',
      }),
    operator: z.enum(CONDITION_OPERATORS),
    /** Absent for `exists` and `missing`; an array for `in` and `nin`. */
    value: z.union([literalSchema, z.array(literalSchema).max(100)]).optional(),
  })
  .strict()
  .superRefine((condition, ctx) => {
    const needsArray = condition.operator === 'in' || condition.operator === 'nin';
    const needsNothing = condition.operator === 'exists' || condition.operator === 'missing';

    if (needsNothing) {
      if (condition.value !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: `The "${condition.operator}" operator takes no value.`,
        });
      }
      return;
    }

    if (condition.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `The "${condition.operator}" operator requires a value.`,
      });
      return;
    }

    if (needsArray && !Array.isArray(condition.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `The "${condition.operator}" operator requires an array of values.`,
      });
    }

    if (!needsArray && Array.isArray(condition.value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `The "${condition.operator}" operator takes a single value, not an array.`,
      });
    }

    // A numeric comparison against a string is the mistake that produces a silently
    // wrong approval path: `"90000" > 100000` is false, and so is `"90000" > 10`.
    // Refusing it at validation time is the only place it is cheap to catch.
    const ordering = ['gt', 'gte', 'lt', 'lte'];
    if (ordering.includes(condition.operator) && typeof condition.value !== 'number') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `The "${condition.operator}" operator compares numbers. Use a numeric value.`,
      });
    }
  });

export type ComparisonCondition = z.infer<typeof comparisonSchema>;

/**
 * The condition tree.
 *
 * `all` / `any` / `not` for composition, with a **bounded depth**. The bound is not
 * decoration: an unbounded recursive schema is a stack-overflow denial of service
 * reachable by anyone who can submit a definition, and 5 levels is already more
 * nesting than a readable condition has.
 */
export type WorkflowCondition =
  | ComparisonCondition
  | { all: WorkflowCondition[] }
  | { any: WorkflowCondition[] }
  | { not: WorkflowCondition };

export const MAX_CONDITION_DEPTH = 5;

function buildConditionSchema(depth: number): z.ZodType<WorkflowCondition> {
  if (depth <= 0) {
    // At the floor only a comparison is legal, which is what terminates the
    // recursion. A definition nested deeper fails validation with a clear message
    // rather than exhausting the stack.
    return comparisonSchema as unknown as z.ZodType<WorkflowCondition>;
  }

  const inner = buildConditionSchema(depth - 1);

  return z.union([
    comparisonSchema as unknown as z.ZodType<WorkflowCondition>,
    z.object({ all: z.array(inner).min(1).max(20) }).strict() as z.ZodType<WorkflowCondition>,
    z.object({ any: z.array(inner).min(1).max(20) }).strict() as z.ZodType<WorkflowCondition>,
    z.object({ not: inner }).strict() as z.ZodType<WorkflowCondition>,
  ]) as z.ZodType<WorkflowCondition>;
}

export const conditionSchema: z.ZodType<WorkflowCondition> =
  buildConditionSchema(MAX_CONDITION_DEPTH);

// --- evaluation ------------------------------------------------------------

/**
 * Reads a dotted path out of instance data.
 *
 * Own-property access only, via `Object.prototype.hasOwnProperty.call`. That is the
 * second line of defence after the field pattern: even if a path somehow named an
 * inherited property, this would not return it. Two independent checks, because this
 * function is the boundary between a definition document and the process.
 *
 * A missing segment yields `undefined`, which is how `exists` and `missing` work
 * without a separate lookup.
 */
export function readField(data: Record<string, unknown>, path: string): unknown {
  let current: unknown = data;

  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function compare(operator: ConditionOperator, actual: unknown, expected: unknown): boolean {
  switch (operator) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'missing':
      return actual === undefined || actual === null;

    // Strict equality, deliberately. Loose equality would make `0 == false` and
    // `"" == 0` true, which in an approval path means a missing amount matching a
    // zero threshold.
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;

    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      // Numbers only. A string that looks numeric is not coerced: `"1e9"` and
      // `" 5 "` both coerce, and neither is a number an administrator meant to
      // write. An absent or non-numeric value fails the comparison rather than
      // being treated as zero.
      if (typeof actual !== 'number' || typeof expected !== 'number') return false;
      if (Number.isNaN(actual) || Number.isNaN(expected)) return false;
      if (operator === 'gt') return actual > expected;
      if (operator === 'gte') return actual >= expected;
      if (operator === 'lt') return actual < expected;
      return actual <= expected;
    }

    case 'in':
      return Array.isArray(expected) && expected.includes(actual as ConditionLiteral);
    case 'nin':
      return Array.isArray(expected) && !expected.includes(actual as ConditionLiteral);

    case 'contains': {
      // Substring for a string, membership for an array. Case-sensitive: a
      // case-insensitive default would surprise anyone matching a product code.
      if (typeof actual === 'string' && typeof expected === 'string') {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) return actual.includes(expected as ConditionLiteral);
      return false;
    }
  }
}

/**
 * Evaluates a condition against instance data.
 *
 * Total: every input produces `true` or `false` and nothing throws. That is a
 * property worth having, because this runs inside a transition and an exception here
 * would leave an instance half-transitioned. A malformed condition cannot reach this
 * function anyway — it fails schema validation at publish time — but "cannot happen"
 * and "would be harmless if it did" are different guarantees.
 *
 * `all` on an empty array is `true` and `any` on an empty array is `false`, which is
 * the mathematical convention. The schema requires at least one member, so neither
 * case is reachable from a valid definition; they are defined here so the recursion
 * has no undefined corner.
 */
export function evaluateCondition(
  condition: WorkflowCondition,
  data: Record<string, unknown>,
): boolean {
  if ('all' in condition) {
    return condition.all.every((child) => evaluateCondition(child, data));
  }
  if ('any' in condition) {
    return condition.any.some((child) => evaluateCondition(child, data));
  }
  if ('not' in condition) {
    return !evaluateCondition(condition.not, data);
  }

  return compare(condition.operator, readField(data, condition.field), condition.value);
}

/**
 * Every field a condition reads.
 *
 * Used by the simulator to report which data an approval path depends on, and by the
 * validator to warn about a condition that reads a field the definition never
 * declares — a condition on a field nobody sets is a branch that never taken, which
 * usually means a typo rather than an intention.
 */
export function conditionFields(condition: WorkflowCondition): string[] {
  const fields = new Set<string>();

  const walk = (node: WorkflowCondition): void => {
    if ('all' in node) return node.all.forEach(walk);
    if ('any' in node) return node.any.forEach(walk);
    if ('not' in node) return walk(node.not);
    fields.add(node.field);
  };

  walk(condition);
  return [...fields].sort();
}

/**
 * Renders a condition as readable text.
 *
 * For the administration portal and the simulator's output. An auditor reading
 * "amount >= 100000 AND riskRating in [high, critical]" understands the control; the
 * same thing as nested JSON they have to parse in their head does not get read.
 */
export function describeCondition(condition: WorkflowCondition): string {
  if ('all' in condition) {
    return condition.all.map((child) => wrap(child)).join(' AND ');
  }
  if ('any' in condition) {
    return condition.any.map((child) => wrap(child)).join(' OR ');
  }
  if ('not' in condition) {
    return `NOT ${wrap(condition.not)}`;
  }

  const symbols: Record<ConditionOperator, string> = {
    eq: '=',
    neq: '!=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    in: 'in',
    nin: 'not in',
    contains: 'contains',
    exists: 'is set',
    missing: 'is not set',
  };

  const symbol = symbols[condition.operator];
  if (condition.operator === 'exists' || condition.operator === 'missing') {
    return `${condition.field} ${symbol}`;
  }

  const value = Array.isArray(condition.value)
    ? `[${condition.value.map((entry) => String(entry)).join(', ')}]`
    : JSON.stringify(condition.value);

  return `${condition.field} ${symbol} ${value}`;
}

function wrap(condition: WorkflowCondition): string {
  const rendered = describeCondition(condition);
  const isComposite = 'all' in condition || 'any' in condition;
  return isComposite ? `(${rendered})` : rendered;
}

/**
 * Parses a condition, throwing a client-safe error.
 *
 * Used where a condition arrives at runtime rather than from a validated definition
 * — the simulator, for instance. Definitions are validated as a whole before
 * publication, so the runtime never parses one.
 */
export function parseCondition(input: unknown): WorkflowCondition {
  const parsed = conditionSchema.safeParse(input);

  if (!parsed.success) {
    throw ApiError.validation(
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'condition',
        message: issue.message,
        code: 'condition_invalid',
      })),
      'This condition is not valid.',
    );
  }

  return parsed.data;
}
