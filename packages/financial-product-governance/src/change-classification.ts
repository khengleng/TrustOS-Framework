import {
  APPROVAL_LEVELS_BY_FIELD,
  MAKER_CHECKER_FIELDS,
  canonicalJson,
  type ProductDefinition,
} from '@trustsystem/financial-product-core';

/**
 * Change classification.
 *
 * Given two versions of a definition, what changed, and who therefore has to approve it.
 *
 * The reason this is *derived* rather than declared: a product owner asked "which approvals does
 * this need" will answer with the ones they expect, and the ones they expect are the ones they
 * remembered. A diff does not forget. Section 18 of the specification names nine changes that
 * require maker-checker, and the only reliable way to enforce nine rules is to compute them from
 * the artefact rather than to ask the person submitting it.
 *
 * The comparison is over **canonical JSON**, so re-serialising a definition through a database
 * does not register as a change and neither does reordering object keys. Array order *is*
 * significant, and deliberately: the order of transitions decides which branch is evaluated
 * first, so a reordering is a change even when the set is identical.
 */

export interface ChangeClassification {
  /** Top-level fields that differ. */
  changedPaths: string[];
  /** The subset that requires maker-checker. */
  sensitivePaths: string[];
  /** Approval levels required, unioned across every sensitive change. */
  requiredApprovalLevels: string[];
  /** Whether anything at all changed. */
  hasChanges: boolean;
  /** Human-readable lines for the approval screen. */
  summary: string[];
}

/**
 * Fields whose change is never material.
 *
 * Short, and every entry is here because including it would make a no-op edit demand approvals.
 * `lifecycleStatus` moves as the product progresses; `version` moves on every new version by
 * definition. Nothing that affects a transaction is on this list, and nothing that affects one
 * ever should be.
 */
const NON_MATERIAL_FIELDS = new Set(['lifecycleStatus', 'version']);

export function classifyChange(
  before: ProductDefinition | null,
  after: ProductDefinition,
): ChangeClassification {
  if (!before) {
    /*
     * A new product is a change to everything.
     *
     * Not an empty diff. A first version that needed no approvals because "nothing changed" is
     * the exact hole somebody would use: create the product with the fee already in it, and the
     * fee never went through a fee review.
     */
    const sensitive = MAKER_CHECKER_FIELDS.filter((field) => hasContent(after, field));

    return {
      changedPaths: Object.keys(after).filter((field) => !NON_MATERIAL_FIELDS.has(field)),
      sensitivePaths: sensitive,
      requiredApprovalLevels: levelsFor(sensitive),
      hasChanges: true,
      summary: [`New product "${after.productName}" (${after.productType}).`],
    };
  }

  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changedPaths: string[] = [];

  for (const field of fields) {
    if (NON_MATERIAL_FIELDS.has(field)) continue;

    const left = canonicalJson((before as Record<string, unknown>)[field]);
    const right = canonicalJson((after as Record<string, unknown>)[field]);
    if (left !== right) changedPaths.push(field);
  }

  changedPaths.sort();
  const sensitivePaths = changedPaths.filter((field) => MAKER_CHECKER_FIELDS.includes(field));

  return {
    changedPaths,
    sensitivePaths,
    requiredApprovalLevels: levelsFor(sensitivePaths),
    hasChanges: changedPaths.length > 0,
    summary: changedPaths.map((field) => describeChange(before, after, field)),
  };
}

function hasContent(definition: ProductDefinition, field: string): boolean {
  const value = (definition as Record<string, unknown>)[field];
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * The union of levels required by every sensitive change.
 *
 * A union rather than the strictest single set. A change touching both fees and countries needs
 * finance *and* compliance — taking the maximum of two sets is not a thing, and a design that
 * picked one would drop the other silently.
 *
 * `PRODUCT_OWNER` is always included, because every change to a product is the product owner's
 * business even when the material risk sits with somebody else.
 */
function levelsFor(sensitivePaths: readonly string[]): string[] {
  const levels = new Set<string>();
  if (sensitivePaths.length > 0) levels.add('PRODUCT_OWNER');

  for (const path of sensitivePaths) {
    for (const level of APPROVAL_LEVELS_BY_FIELD[path] ?? []) levels.add(level);
  }

  return [...levels].sort();
}

/**
 * One line describing a change.
 *
 * Counts and names, never values. A summary that quoted the old and new fee would put a
 * commercial term into a notification that goes to more people than the product does — and the
 * approval screen shows the full diff to the people entitled to see it.
 */
function describeChange(
  before: ProductDefinition,
  after: ProductDefinition,
  field: string,
): string {
  const left = (before as Record<string, unknown>)[field];
  const right = (after as Record<string, unknown>)[field];

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return `${field}: ${left.length} -> ${right.length} entries.`;
    }
    return `${field}: ${right.length} entries changed.`;
  }

  if (left === undefined) return `${field}: added.`;
  if (right === undefined) return `${field}: removed.`;
  return `${field}: changed.`;
}

/**
 * Whether a change may proceed on the approvals already recorded.
 *
 * Separate from `classifyChange` so a caller can classify once and check repeatedly as decisions
 * arrive — which is what an approval screen does on every poll.
 */
export function outstandingApprovals(
  classification: ChangeClassification,
  recordedLevels: readonly string[],
): string[] {
  const recorded = new Set(recordedLevels);
  return classification.requiredApprovalLevels.filter((level) => !recorded.has(level));
}
