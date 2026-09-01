import { z } from 'zod';
import { ApiError } from '@trustsystem/errors';
import {
  type ApiDefinition,
  type ApiOperation,
  compareSemver,
  semverSchema,
} from '@trustsystem/api-catalog';

/**
 * API versioning.
 *
 * The instruction this implements — *avoid breaking consumers silently* — has one word doing the
 * work. Breaking consumers is sometimes necessary. Doing it *silently* is the failure, and it
 * happens through a specific mechanism worth naming: a change that is obviously breaking gets a
 * major version and a migration plan, while a change that is *nearly* compatible gets shipped as
 * a patch because it seemed harmless. Removing an optional field. Tightening a validation rule.
 * Adding a required request parameter with a sensible default.
 *
 * So the analysis here is structural rather than advisory. It compares two definitions, classifies
 * every difference, and derives the minimum version bump. A change classified as breaking cannot
 * be released as a minor, and the refusal is a code path rather than a review comment.
 *
 * The second half is what a breaking change *owes*: a deprecation period long enough for consumers
 * to move, a migration document, and a named impact per consumer. A major version released without
 * those is a break with extra ceremony.
 */

export const CHANGE_KINDS = [
  'operation_removed',
  'operation_added',
  'operation_deprecated',
  'path_changed',
  'method_changed',
  'scope_added',
  'scope_removed',
  'classification_raised',
  'classification_lowered',
  'authentication_changed',
  'idempotency_changed',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export type Compatibility = 'breaking' | 'compatible' | 'additive';

/**
 * How each kind of change affects existing consumers.
 *
 * Three entries are worth explaining because the intuitive answer is wrong.
 *
 * `scope_added` is **breaking**. A new required scope means every existing credential lacks it,
 * so every existing consumer starts receiving 403s — from a change that adds nothing to the
 * response and reads like a security improvement.
 *
 * `classification_lowered` is **breaking** in the direction nobody expects: a consumer's access
 * was granted against the old classification, and lowering it changes which policy applies to data
 * that has not itself become less sensitive. It should be a deliberate reclassification, reviewed,
 * not a side effect of a version bump.
 *
 * `idempotency_changed` is breaking because callers built retry behaviour on the old answer. An
 * operation that stops being idempotent turns those retries into duplicates.
 */
export const CHANGE_COMPATIBILITY: Record<ChangeKind, Compatibility> = {
  operation_removed: 'breaking',
  operation_added: 'additive',
  operation_deprecated: 'compatible',
  path_changed: 'breaking',
  method_changed: 'breaking',
  scope_added: 'breaking',
  scope_removed: 'compatible',
  classification_raised: 'compatible',
  classification_lowered: 'breaking',
  authentication_changed: 'breaking',
  idempotency_changed: 'breaking',
};

export interface ApiChange {
  readonly kind: ChangeKind;
  readonly compatibility: Compatibility;
  readonly operationId: string | null;
  readonly detail: string;
  /** What a consumer must do. Null when nothing is required of them. */
  readonly consumerAction: string | null;
}

export interface CompatibilityAnalysis {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly changes: readonly ApiChange[];
  readonly breaking: boolean;
  /** The smallest version bump this set of changes justifies. */
  readonly requiredBump: 'major' | 'minor' | 'patch';
  /** True when the declared version is at least the required bump. */
  readonly versionSufficient: boolean;
  readonly summary: string;
}

function scopesOf(operation: ApiOperation, api: ApiDefinition): string[] {
  return operation.scopes.length > 0 ? operation.scopes : api.scopes;
}

/**
 * Compare two definitions of the same API.
 *
 * Operations are matched by `operationId` rather than by path, so a renamed path is reported as a
 * path change on the same operation rather than as one removal and one addition — the difference
 * matters, because a removal-plus-addition reads as "the old one is gone" and understates it.
 */
export function analyseCompatibility(
  from: ApiDefinition,
  to: ApiDefinition,
): CompatibilityAnalysis {
  if (from.apiId !== to.apiId) {
    throw ApiError.validation(
      [{ path: 'apiId', message: 'Compatibility is analysed between versions of one API.' }],
      'These are two different APIs, not two versions of one.',
    );
  }

  const changes: ApiChange[] = [];
  const fromOperations = new Map(
    from.operations.map((operation) => [operation.operationId, operation]),
  );
  const toOperations = new Map(
    to.operations.map((operation) => [operation.operationId, operation]),
  );

  if (from.authentication !== to.authentication) {
    changes.push({
      kind: 'authentication_changed',
      compatibility: CHANGE_COMPATIBILITY.authentication_changed,
      operationId: null,
      detail: `Authentication changed from ${from.authentication} to ${to.authentication}.`,
      consumerAction: 'Every consumer re-issues credentials in the new scheme before the switch.',
    });
  }

  for (const [operationId, before] of fromOperations) {
    const after = toOperations.get(operationId);

    if (!after) {
      changes.push({
        kind: 'operation_removed',
        compatibility: CHANGE_COMPATIBILITY.operation_removed,
        operationId,
        detail: `${before.method} ${before.path} no longer exists.`,
        consumerAction: 'Consumers calling it must stop, or move to whatever replaces it.',
      });
      continue;
    }

    if (before.path !== after.path) {
      changes.push({
        kind: 'path_changed',
        compatibility: CHANGE_COMPATIBILITY.path_changed,
        operationId,
        detail: `${operationId} moved from ${before.path} to ${after.path}.`,
        consumerAction: 'Update the request path.',
      });
    }

    if (before.method !== after.method) {
      changes.push({
        kind: 'method_changed',
        compatibility: CHANGE_COMPATIBILITY.method_changed,
        operationId,
        detail: `${operationId} changed from ${before.method} to ${after.method}.`,
        consumerAction: 'Update the request method.',
      });
    }

    const beforeScopes = new Set(scopesOf(before, from));
    const afterScopes = new Set(scopesOf(after, to));

    const added = [...afterScopes].filter((scope) => !beforeScopes.has(scope));
    const removed = [...beforeScopes].filter((scope) => !afterScopes.has(scope));

    if (added.length > 0) {
      changes.push({
        kind: 'scope_added',
        compatibility: CHANGE_COMPATIBILITY.scope_added,
        operationId,
        detail: `${operationId} now also requires ${added.join(', ')}.`,
        consumerAction:
          'Every existing credential lacks the new scope, so every existing consumer receives 403 until it is granted.',
      });
    }

    if (removed.length > 0) {
      changes.push({
        kind: 'scope_removed',
        compatibility: CHANGE_COMPATIBILITY.scope_removed,
        operationId,
        detail: `${operationId} no longer requires ${removed.join(', ')}.`,
        consumerAction: null,
      });
    }

    if (before.classification !== after.classification) {
      const raised =
        classificationOrder(after.classification) > classificationOrder(before.classification);
      changes.push({
        kind: raised ? 'classification_raised' : 'classification_lowered',
        compatibility: raised
          ? CHANGE_COMPATIBILITY.classification_raised
          : CHANGE_COMPATIBILITY.classification_lowered,
        operationId,
        detail: `${operationId} moved from ${before.classification} to ${after.classification}.`,
        consumerAction: raised
          ? 'Access may now require a higher clearance or an approved purpose.'
          : 'The data did not become less sensitive. Confirm this is a reviewed reclassification and not a side effect.',
      });
    }

    if (before.idempotent !== after.idempotent) {
      changes.push({
        kind: 'idempotency_changed',
        compatibility: CHANGE_COMPATIBILITY.idempotency_changed,
        operationId,
        detail: `${operationId} is ${after.idempotent ? 'now' : 'no longer'} idempotent.`,
        consumerAction: after.idempotent
          ? null
          : 'Callers that retry on timeout will now create duplicates. Their retry policy must change first.',
      });
    }

    if (!before.deprecated && after.deprecated) {
      changes.push({
        kind: 'operation_deprecated',
        compatibility: CHANGE_COMPATIBILITY.operation_deprecated,
        operationId,
        detail: `${operationId} is deprecated.`,
        consumerAction: 'Plan a move before the retirement date.',
      });
    }
  }

  for (const [operationId, after] of toOperations) {
    if (fromOperations.has(operationId)) continue;
    changes.push({
      kind: 'operation_added',
      compatibility: CHANGE_COMPATIBILITY.operation_added,
      operationId,
      detail: `${after.method} ${after.path} is new.`,
      consumerAction: null,
    });
  }

  const breaking = changes.some((change) => change.compatibility === 'breaking');
  const additive = changes.some((change) => change.compatibility === 'additive');

  const requiredBump: 'major' | 'minor' | 'patch' = breaking
    ? 'major'
    : additive
      ? 'minor'
      : 'patch';

  return {
    fromVersion: from.version,
    toVersion: to.version,
    changes,
    breaking,
    requiredBump,
    versionSufficient: bumpBetween(from.version, to.version) >= bumpRank(requiredBump),
    summary: describeAnalysis(changes, requiredBump, from.version, to.version),
  };
}

function classificationOrder(level: string): number {
  return ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'HIGHLY_RESTRICTED'].indexOf(level);
}

function bumpRank(bump: 'major' | 'minor' | 'patch'): number {
  return bump === 'major' ? 3 : bump === 'minor' ? 2 : 1;
}

/** What bump the two versions actually represent. 0 when the version did not move forward. */
export function bumpBetween(from: string, to: string): number {
  if (compareSemver(to, from) <= 0) return 0;

  const [fromMajor, fromMinor] = from.split('.').map(Number) as [number, number, number];
  const [toMajor, toMinor] = to.split('.').map(Number) as [number, number, number];

  if (toMajor > fromMajor) return 3;
  if (toMinor > fromMinor) return 2;
  return 1;
}

function describeAnalysis(
  changes: readonly ApiChange[],
  requiredBump: string,
  from: string,
  to: string,
): string {
  if (changes.length === 0) return `${from} → ${to}: no contract differences.`;

  const counts = changes.reduce<Record<string, number>>((totals, change) => {
    totals[change.compatibility] = (totals[change.compatibility] ?? 0) + 1;
    return totals;
  }, {});

  const parts = Object.entries(counts).map(([compatibility, count]) => `${count} ${compatibility}`);
  return `${from} → ${to}: ${parts.join(', ')}. Requires a ${requiredBump} version.`;
}

export const migrationPlanSchema = z
  .object({
    apiId: z.string().min(3).max(64),
    fromVersion: semverSchema,
    toVersion: semverSchema,
    /** How the migration is done, concretely. A plan a consumer cannot follow is an announcement. */
    migrationGuide: z.string().min(50).max(20_000),
    /**
     * How long consumers have. The framework's floor for a breaking change is 90 days; a shorter
     * period is permitted with a recorded exception, because sometimes a security fix cannot wait.
     */
    deprecationPeriodDays: z.number().int().min(0).max(1095),
    /** Set when the period is below the floor. */
    shortNoticeReason: z.string().min(20).max(1000).nullable().default(null),
    shortNoticeApprovedBy: z.string().min(1).max(64).nullable().default(null),
    /** Named per consumer. "All consumers should review" is not an impact assessment. */
    consumerImpacts: z
      .array(
        z
          .object({
            consumerId: z.string().min(1).max(64),
            /** What breaks for this consumer specifically. */
            impact: z.string().min(15).max(1000),
            /** Whether they have been told, and when. */
            notifiedAt: z.string().datetime().nullable().default(null),
            acknowledgedAt: z.string().datetime().nullable().default(null),
          })
          .strict(),
      )
      .default([]),
    authorId: z.string().min(1).max(64),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.deprecationPeriodDays < MINIMUM_DEPRECATION_DAYS) {
      if (plan.shortNoticeReason === null || plan.shortNoticeApprovedBy === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deprecationPeriodDays'],
          message:
            `A breaking change gives consumers at least ${MINIMUM_DEPRECATION_DAYS} days, or records why it cannot ` +
            'and who approved the exception.',
        });
      }
    }
  });

export type MigrationPlan = z.infer<typeof migrationPlanSchema>;

export const MINIMUM_DEPRECATION_DAYS = 90;

/**
 * The gate.
 *
 * A breaking change releases only with a sufficient version bump, a migration plan, and a named
 * impact for every consumer that will be affected. `knownConsumerIds` is passed in rather than
 * looked up, so this package needs no dependency on the consumer registry.
 */
export function assertReleasable(input: {
  analysis: CompatibilityAnalysis;
  plan: MigrationPlan | null;
  knownConsumerIds?: readonly string[];
}): void {
  const problems: string[] = [];

  if (!input.analysis.versionSufficient) {
    problems.push(
      `The changes require a ${input.analysis.requiredBump} version, but ${input.analysis.fromVersion} → ` +
        `${input.analysis.toVersion} is not one. This is how a breaking change ships as a patch.`,
    );
  }

  if (input.analysis.breaking) {
    if (!input.plan) {
      problems.push(
        'A breaking change releases with a migration plan. Without one, consumers find out by failing.',
      );
    } else {
      const covered = new Set(input.plan.consumerImpacts.map((impact) => impact.consumerId));
      const uncovered = (input.knownConsumerIds ?? []).filter(
        (consumerId) => !covered.has(consumerId),
      );

      if (uncovered.length > 0) {
        problems.push(
          `No stated impact for ${uncovered.join(', ')}. "All consumers should review" is not an impact assessment.`,
        );
      }

      const unnotified = input.plan.consumerImpacts.filter((impact) => impact.notifiedAt === null);
      if (unnotified.length > 0) {
        problems.push(
          `${unnotified.length} consumer(s) have not been notified: ${unnotified
            .map((impact) => impact.consumerId)
            .join(', ')}.`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw ApiError.conflict('This version is not releasable.', { problems });
  }
}

/**
 * Consumers who have been told and have not acknowledged, as the retirement approaches.
 *
 * The list that turns a deprecation from a date into a conversation. A consumer who was notified
 * ninety days ago and never acknowledged has almost certainly not read it.
 */
export function unacknowledgedConsumers(
  plan: MigrationPlan,
  asOf: Date,
): Array<{ consumerId: string; daysSinceNotified: number | null; impact: string }> {
  return plan.consumerImpacts
    .filter((impact) => impact.acknowledgedAt === null)
    .map((impact) => ({
      consumerId: impact.consumerId,
      daysSinceNotified:
        impact.notifiedAt === null
          ? null
          : Math.floor((asOf.getTime() - Date.parse(impact.notifiedAt)) / 86_400_000),
      impact: impact.impact,
    }))
    .sort((left, right) => (right.daysSinceNotified ?? -1) - (left.daysSinceNotified ?? -1));
}
