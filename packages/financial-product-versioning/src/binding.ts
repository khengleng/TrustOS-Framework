import {
  hashesEqual,
  productError,
  type ProductLifecycleStatus,
} from '@trustos/financial-product-core';
import { EXECUTABLE_STATUSES, SANDBOX_EXECUTABLE_STATUSES } from '@trustos/financial-product-core';
import { verifyContentHash, type PublishedVersion } from './version';

/**
 * Version binding.
 *
 * A transaction started on v2.1 runs on v2.1 until it ends, whatever happens to the product in
 * the meantime. That sentence is the whole package, and everything here exists to make it true
 * rather than aspirational.
 *
 * The failure it prevents is specific and it is not hypothetical. A payment authorized under a
 * 0.5% fee and captured an hour later, after the product moved to 0.75%, must settle at 0.5% —
 * the merchant was quoted a price. A system that re-resolved "the active version" at capture time
 * would charge the new rate, agree with every test, and disagree with the merchant statement. And
 * because the transaction completed successfully, nothing would surface it until somebody
 * reconciled by hand.
 *
 * So a binding is recorded once, at the start, and carries three things:
 *
 *   * the **version**, so the right rules are loaded;
 *   * the **content hash**, so a version edited outside the approval path is caught rather than
 *     executed;
 *   * the **lifecycle status at bind time**, so an execution that started while the product was
 *     active can finish after it was paused — which is what pausing means. Pausing stops *new*
 *     transactions; a pause that killed running ones would leave half-finished movements every
 *     time an incident was handled.
 */

export interface VersionBinding {
  productId: string;
  version: string;
  contentHash: string;
  variantId: string | null;
  variantVersion: string | null;
  /** The status when the execution started. Not re-read. */
  statusAtBind: ProductLifecycleStatus;
  boundAt: Date;
  environment: 'production' | 'sandbox';
}

/**
 * Binds an execution to a version.
 *
 * This is the one place that checks whether a product may execute at all, and it is deliberately
 * not in the runtime: a runtime that decided for itself would be a runtime with a code path that
 * could be persuaded. Here the answer comes from `EXECUTABLE_STATUSES`, which has one member.
 */
export function bindVersion(input: {
  version: PublishedVersion;
  variantId?: string | null;
  variantVersion?: string | null;
  environment: 'production' | 'sandbox';
  now: Date;
}): VersionBinding {
  const status = input.version.definition.lifecycleStatus;

  verifyContentHash(input.version);

  const permitted =
    input.environment === 'sandbox'
      ? SANDBOX_EXECUTABLE_STATUSES.has(status)
      : EXECUTABLE_STATUSES.has(status);

  if (!permitted) {
    throw productError(
      input.environment === 'sandbox' ? 'product_sandbox_only' : 'product_not_executable',
      input.environment === 'production'
        ? `Product ${input.version.productId}@${input.version.version} is "${status}". Only an ` +
            'active product executes in production — a draft that could execute would make every ' +
            'control above it optional.'
        : `Product ${input.version.productId}@${input.version.version} is "${status}" and cannot ` +
            'be exercised even in the sandbox.',
      { productId: input.version.productId, version: input.version.version, actual: status },
    );
  }

  return {
    productId: input.version.productId,
    version: input.version.version,
    contentHash: input.version.contentHash,
    variantId: input.variantId ?? null,
    variantVersion: input.variantVersion ?? null,
    statusAtBind: status,
    boundAt: input.now,
    environment: input.environment,
  };
}

/**
 * Re-checks a binding when a paused execution resumes.
 *
 * Called when an execution comes back from review, or when an asynchronous provider answers. The
 * check is **not** "is the product still active" — that would kill every in-flight transaction
 * the moment an incident was handled, which is the opposite of what pausing is for. It is "is
 * this still the same definition", which catches the case the pause was intended for: a version
 * that was edited or replaced under a running transaction.
 */
export function assertBindingIntact(binding: VersionBinding, version: PublishedVersion): void {
  if (binding.version !== version.version) {
    throw productError(
      'product_version_binding_broken',
      `This execution is bound to ${binding.productId}@${binding.version} and was resumed ` +
        `against ${version.version}. Moving it would apply rules it did not start under.`,
      { productId: binding.productId, expected: binding.version, actual: version.version },
    );
  }

  if (!hashesEqual(binding.contentHash, version.contentHash)) {
    throw productError(
      'product_version_binding_broken',
      `The definition behind ${binding.productId}@${binding.version} has changed since this ` +
        'execution started. Resuming would finish a transaction under rules that replaced the ' +
        'ones it began under.',
      {
        productId: binding.productId,
        version: binding.version,
        expected: binding.contentHash,
        actual: version.contentHash,
      },
    );
  }
}

/**
 * Whether an execution bound to one version may still be *started*.
 *
 * Distinct from resuming. A binding is created at start and never renewed, so this exists for one
 * case: an API dispatcher holding a binding from an idempotent replay, deciding whether to run
 * again or return the stored result.
 */
export function bindingIsStale(binding: VersionBinding, activeVersion: string | null): boolean {
  return activeVersion !== null && binding.version !== activeVersion;
}
