import { compareVersions } from '@trustos/version-manager';
import { productError } from '@trustos/financial-product-core';
import type { PublishedVersion } from './version';

/**
 * Rollback.
 *
 * v2.1 is live, an incident happens, v2.0 becomes live again. Two properties make it a control
 * rather than a redeploy:
 *
 * **Nothing historical is rewritten.** Transactions that ran on v2.1 ran on v2.1, and they keep
 * saying so. A rollback that relabelled them would destroy the only record of what rules a
 * disputed transaction was actually decided under — and a dispute about a transaction during an
 * incident is the likeliest dispute there is.
 *
 * **The target must be a version that was already approved.** Rollback is not a way to publish. A
 * design that let an operator name any version would be a way to reach production with one
 * signature during the exact window when everybody is distracted, which is when a control has to
 * hold rather than bend.
 *
 * The plan is produced before anything happens, and `applyRollback` takes the plan rather than
 * the arguments. `--dry-run` is *not calling apply*, never a second code path — a tool with two
 * paths stops predicting the real run the first time they diverge.
 */

export interface RollbackPlan {
  productId: string;
  organizationId: string | null;
  /** The version being withdrawn. */
  from: string;
  /** The version being restored. */
  to: string;
  /** Why. Recorded in the audit trail and shown in the version history forever. */
  reason: string;
  /** What the target's approval trail looked like when it was published. */
  targetApprovals: Array<{ level: string; actorId: string }>;
  /** Executions currently bound to the version being withdrawn. They are not touched. */
  inFlightCount: number;
  /** Whether the restore is a downgrade in the semantic-version sense. Almost always true. */
  isDowngrade: boolean;
  /** Everything that would change, as lines for a person to read before approving. */
  effects: string[];
}

export function planRollback(input: {
  current: PublishedVersion;
  target: PublishedVersion;
  reason: string;
  inFlightCount: number;
}): RollbackPlan {
  const { current, target } = input;

  if (current.productId !== target.productId) {
    throw productError(
      'product_definition_invalid',
      `Cannot roll ${current.productId} back to a version of ${target.productId}.`,
      { productId: current.productId, expected: current.productId, actual: target.productId },
    );
  }

  if (current.organizationId !== target.organizationId) {
    // Reported as not-found rather than as a mismatch: confirming that the other tenant's
    // version exists is the enumeration primitive the boundary exists to deny.
    throw productError(
      'product_not_found',
      `No version ${target.version} of ${current.productId} for this tenant.`,
      { productId: current.productId, version: target.version },
    );
  }

  if (target.version === current.version) {
    throw productError(
      'product_definition_invalid',
      'The rollback target is the version already live.',
      { productId: current.productId, version: current.version },
    );
  }

  if (target.approvedBy.length === 0) {
    throw productError(
      'product_approval_required',
      `Version ${target.version} was published with no recorded approvals and is not a valid ` +
        'rollback target. Rollback restores something that was approved; it is not a second way ' +
        'to publish.',
      { productId: current.productId, version: target.version },
    );
  }

  if (input.reason.trim().length < 10) {
    throw productError(
      'product_definition_invalid',
      'A rollback needs a reason. "Fixed" in the version history is a rollback nobody can ' +
        'explain six months later, and somebody will be asked to.',
      { productId: current.productId, actual: input.reason },
    );
  }

  const isDowngrade = compareVersions(target.version, current.version) < 0;

  return {
    productId: current.productId,
    organizationId: current.organizationId,
    from: current.version,
    to: target.version,
    reason: input.reason,
    targetApprovals: [...target.approvedBy],
    inFlightCount: input.inFlightCount,
    isDowngrade,
    effects: [
      `New transactions will start on ${target.version} instead of ${current.version}.`,
      `${input.inFlightCount} execution(s) already bound to ${current.version} will finish on it.`,
      `Completed transactions keep recording ${current.version}. Nothing historical is rewritten.`,
      `${current.version} moves to "paused" and remains a rollback target itself.`,
      isDowngrade
        ? `${target.version} is older than ${current.version}; channels using anything added in ` +
          `${current.version} will start receiving refusals.`
        : `${target.version} is newer than ${current.version}.`,
    ],
  };
}

export interface RollbackOutcome {
  productId: string;
  pausedVersion: string;
  activatedVersion: string;
  /** Untouched. Present so a caller can assert it, and a test can prove it. */
  historicalExecutionsRewritten: 0;
  appliedAt: Date;
}

/**
 * Applies a plan.
 *
 * Takes the plan rather than the arguments, so what was reviewed is what runs. The state changes
 * themselves belong to the registry — this returns the outcome and the registry writes it, which
 * keeps the "what does rollback mean" decision in one file and the "how is it stored" decision in
 * another.
 */
export function applyRollback(plan: RollbackPlan, now: Date): RollbackOutcome {
  return {
    productId: plan.productId,
    pausedVersion: plan.from,
    activatedVersion: plan.to,
    historicalExecutionsRewritten: 0,
    appliedAt: now,
  };
}
