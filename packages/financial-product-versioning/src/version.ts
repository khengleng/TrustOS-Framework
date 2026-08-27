import { z } from 'zod';
import { compareVersions, isBreakingChange, isNewer, versionChange } from '@trustos/version-manager';
import {
  EDITABLE_STATUSES,
  definitionContentHash,
  hashesEqual,
  productError,
  type ProductDefinition,
  type ProductLifecycleStatus,
} from '@trustos/financial-product-core';

/**
 * Published product versions.
 *
 * One rule, absolute: **a published version never changes.** Not its fees, not its limits, not a
 * typo in a description. A running transaction reads its rules from a version record, so editing
 * that record retroactively changes the rules a decision was made under — and unlike a workflow,
 * the decision here moved money.
 *
 * Three layers refuse it, and defeating any one of them defeats all three:
 *
 *   1. `PublishedVersion.definition` is `readonly` and every mutation path in this package
 *      returns a new record.
 *   2. `assertUnpublishedOrIdentical` refuses any write to a version whose status is past
 *      editable.
 *   3. The **content hash**, recorded at publication and re-checked on load. This is the layer
 *      that survives somebody editing the row directly in the database, which is the only
 *      scenario in which the first two are already gone.
 *
 * The third is the one worth keeping when somebody argues the first two are enough. They are
 * enough against mistakes; the hash is what is left against everything else.
 */

export const publishedVersionSchema = z
  .object({
    productId: z.string().min(1).max(80),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** Tenant. `string | null` rather than optional, so a caller cannot omit it. */
    organizationId: z.string().min(1).max(80).nullable(),

    /** The hash of the definition at publication. What binds an execution to its rules. */
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),

    lifecycleStatus: z.string().min(1).max(40),
    publishedAt: z.string().datetime(),
    publishedById: z.string().min(1).max(80),
    /** Who composed it. Compared against the approver — never the same person. */
    authoredById: z.string().min(1).max(80),
    /** Approval levels recorded before publication. */
    approvedBy: z.array(z.object({ level: z.string(), actorId: z.string() }).strict()).max(20),

    /** The version this one supersedes, when it is not the first. */
    supersedes: z.string().regex(/^\d+\.\d+\.\d+$/).nullable(),
    /**
     * What changed, in the author's words.
     *
     * Required, and required to be substantive. A version history of "updates" is a version
     * history nobody reads, and the moment somebody needs it is an incident.
     */
    changeSummary: z.string().min(10).max(1000),
    /** Which fields changed. Derived, and what governance turns into required approvals. */
    changedPaths: z.array(z.string().max(80)).max(50),
  })
  .strict();

export type PublishedVersionRecord = z.infer<typeof publishedVersionSchema>;

export interface PublishedVersion extends PublishedVersionRecord {
  readonly definition: ProductDefinition;
}

/**
 * Publishes a definition as an immutable version.
 *
 * The hash is computed here and nowhere else. A caller supplying its own hash would be a caller
 * able to publish a definition whose recorded hash does not describe it — which is the whole
 * check, handed to the party it exists to constrain.
 */
export function publishVersion(input: {
  definition: ProductDefinition;
  organizationId: string | null;
  publishedById: string;
  authoredById: string;
  approvedBy: Array<{ level: string; actorId: string }>;
  supersedes: string | null;
  changeSummary: string;
  changedPaths: string[];
  now: Date;
}): PublishedVersion {
  if (input.publishedById === input.authoredById && input.approvedBy.length === 0) {
    throw productError(
      'product_self_approval_refused',
      'The author cannot publish their own version with no approvals recorded. Three people is ' +
        'the default and two is the floor; one is a control that reports itself as working.',
      { productId: input.definition.productId, version: input.definition.version },
    );
  }

  if (input.supersedes && !isNewer(input.definition.version, input.supersedes)) {
    throw productError(
      'product_definition_invalid',
      `Version ${input.definition.version} does not supersede ${input.supersedes}: it is not ` +
        'newer. Publishing it would put an older set of rules in front of new transactions ' +
        'while the history says otherwise.',
      { expected: `> ${input.supersedes}`, actual: input.definition.version },
    );
  }

  const record = publishedVersionSchema.parse({
    productId: input.definition.productId,
    version: input.definition.version,
    organizationId: input.organizationId,
    contentHash: definitionContentHash(input.definition),
    lifecycleStatus: input.definition.lifecycleStatus,
    publishedAt: input.now.toISOString(),
    publishedById: input.publishedById,
    authoredById: input.authoredById,
    approvedBy: input.approvedBy,
    supersedes: input.supersedes,
    changeSummary: input.changeSummary,
    changedPaths: input.changedPaths,
  });

  return Object.freeze({ ...record, definition: Object.freeze(input.definition) });
}

/**
 * Refuses a write to a version that is no longer editable.
 *
 * Called before every update path. The `identical` escape is deliberate and narrow: re-saving a
 * byte-identical definition is a no-op, and refusing it would make an idempotent retry of a save
 * look like a conflict.
 */
export function assertUnpublishedOrIdentical(
  status: ProductLifecycleStatus,
  currentHash: string,
  proposed: ProductDefinition,
): void {
  if (EDITABLE_STATUSES.has(status)) return;

  if (hashesEqual(currentHash, definitionContentHash(proposed))) return;

  throw productError(
    'product_definition_immutable',
    `A product in "${status}" cannot be edited. A running transaction reads its rules from this ` +
      'version, so changing it would retroactively change the rules a decision was made under. ' +
      'Create a new version.',
    { productId: proposed.productId, version: proposed.version, actual: status },
  );
}

/**
 * Verifies a loaded definition against its recorded hash.
 *
 * The check that survives a direct database edit, and the runtime calls it on every load rather
 * than on the first. Caching the verdict would mean a definition edited between two executions is
 * verified once and trusted afterwards, which is the window somebody would use.
 */
export function verifyContentHash(version: PublishedVersion): void {
  const actual = definitionContentHash(version.definition);

  if (!hashesEqual(version.contentHash, actual)) {
    throw productError(
      'product_version_binding_broken',
      `Product ${version.productId}@${version.version} no longer matches the hash recorded when ` +
        'it was published. The stored definition has been changed outside the approval path, and ' +
        'executing it would apply rules nobody approved.',
      {
        productId: version.productId,
        version: version.version,
        expected: version.contentHash,
        actual,
      },
    );
  }
}

/**
 * Whether a version bump is large enough for what changed.
 *
 * Below 1.0.0 the **minor** is the breaking position — the framework-wide rule from phase 10,
 * restated here because it applies to products too and because getting it wrong is how a product
 * at 0.9 breaks every channel on a patch release and calls itself compliant.
 *
 * The check is one-directional: it refuses a bump that is too *small* for the change and permits
 * one that is larger. A team that wants to signal significance with a major bump should be able
 * to, and a tool that argued with them about it would be a tool they stopped running.
 */
export function assertSufficientBump(
  from: string,
  to: string,
  changedPaths: readonly string[],
): void {
  const BREAKING_PATHS = ['blocks', 'transitions', 'apiExposurePolicy', 'supportedCurrencies'];
  const breaking = changedPaths.some((path) => BREAKING_PATHS.includes(path));

  if (compareVersions(from, to) >= 0) {
    throw productError(
      'product_definition_invalid',
      `Version ${to} is not newer than ${from}.`,
      { expected: `> ${from}`, actual: to },
    );
  }

  if (!breaking) return;

  if (isBreakingChange(from, to)) return;

  const change = versionChange(from, to);
  const position = from.startsWith('0.') ? 'minor' : 'major';

  throw productError(
    'product_definition_invalid',
    `Changing ${changedPaths.filter((path) => BREAKING_PATHS.includes(path)).join(', ')} is a ` +
      `breaking change for every channel calling this product, and ${from} -> ${to} is a ` +
      `${change ?? 'no-op'} bump. Below 1.0.0 the minor is the breaking position, so this needs ` +
      `a ${position} bump.`,
    { expected: `${position} bump`, actual: `${from} -> ${to}` },
  );
}
