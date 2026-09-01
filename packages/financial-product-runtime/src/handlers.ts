import {
  productError,
  type ProductBlock,
  type ProductExecutionContext,
} from '@trustsystem/financial-product-core';
import type { ConnectorDefinition } from '@trustsystem/connector-registry';

/**
 * The block handler contract.
 *
 * **The framework ships no handler for any block.** Not one, and that is the deliverable rather
 * than an omission. The catalog knows what a debit *means* — that it moves money, that it needs a
 * preceding limit, that it is undone by a reversal — and it deliberately does not know which
 * account it lands in. A deployment binds `wallet.debit` to `@trustsystem/wallet`, `ledger.*` to
 * `@trustsystem/ledger`, `fee.*` to `@trustsystem/fees`; the sandbox binds every one of them to a mock.
 *
 * A handler receives an already-authorized actor, an already-validated definition and an
 * already-consumed limit. It does not authorize, does not re-validate and does not decide whether
 * it should run — all three were settled before it was called, and a handler that repeated any of
 * them would be a second implementation that eventually disagrees with the first.
 *
 * The result type is a closed union of five outcomes, and the distinction between three of them
 * is the part worth reading:
 *
 *   * **`refused`** — a control said no. A limit was reached, a rule denied, KYC was
 *     insufficient. The system worked.
 *   * **`failed`** — the handler could not answer. A provider timed out, a store was unreachable.
 *     The system did not work.
 *   * **`review_required`** — a person must decide before anything further happens. Not a
 *     failure and not a success, and an execution held here has done everything up to this point
 *     and nothing after it.
 *
 * Collapsing the first two makes every dashboard report a product enforcing its limits correctly
 * as a product that is broken, and the alert that matters gets muted within a week.
 */

export type BlockOutputs = Record<string, string | number | boolean | null>;

export type BlockResult =
  | { outcome: 'success'; outputs: BlockOutputs }
  | { outcome: 'refused'; code: string; reason: string }
  | { outcome: 'failed'; code: string; reason: string; retryable: boolean }
  | { outcome: 'review_required'; level: string; reason: string }
  | { outcome: 'awaiting_provider'; providerReference: string };

export interface BlockExecutionInput {
  context: ProductExecutionContext;
  /** The node as the product declared it, with its configuration. */
  block: ProductBlock;
  /**
   * The connector bound to this block's provider interface, when it has one.
   *
   * Metadata only — the timeout, the retry policy, the operation name. The adapter that actually
   * calls the external system belongs to the deployment and is reached through
   * `@trustsystem/adapter-framework`. Nothing here carries a credential.
   */
  connector: ConnectorDefinition | null;
  /** Outputs of every block that has already run in this execution, keyed by block key. */
  priorOutputs: Readonly<Record<string, BlockOutputs>>;
  /** 1 on the first try. A handler that behaves differently on a retry needs to know. */
  attempt: number;
}

export interface BlockHandler {
  /** The catalog block this handler implements, e.g. `wallet.debit`. */
  readonly blockId: string;
  execute(input: BlockExecutionInput): Promise<BlockResult>;
}

/**
 * The handler registry.
 *
 * Refuses a missing handler at execution rather than returning a no-op, and the refusal is what
 * makes a partially wired deployment fail loudly at the first transaction instead of quietly
 * skipping a limit check.
 */
export class BlockHandlerRegistry {
  private readonly handlers = new Map<string, BlockHandler>();

  constructor(handlers: readonly BlockHandler[] = []) {
    for (const handler of handlers) this.register(handler);
  }

  register(handler: BlockHandler): this {
    if (this.handlers.has(handler.blockId)) {
      throw productError(
        'product_definition_invalid',
        `A handler for "${handler.blockId}" is already registered. Two handlers for one block ` +
          'means load order decides which one moves the money.',
        { blockKey: handler.blockId },
      );
    }

    this.handlers.set(handler.blockId, handler);
    return this;
  }

  find(blockId: string): BlockHandler | undefined {
    return this.handlers.get(blockId);
  }

  require(blockId: string): BlockHandler {
    const handler = this.handlers.get(blockId);

    if (!handler) {
      throw productError(
        'product_not_executable',
        `No handler is registered for "${blockId}". The deployment binds each approved block to ` +
          'an implementation; an unbound block cannot run, and skipping it would skip a control.',
        { blockKey: blockId },
      );
    }

    return handler;
  }

  /** Which of a product's blocks have no handler. What a deployment check reports at start-up. */
  missingFor(blockIds: readonly string[]): string[] {
    return [...new Set(blockIds)].filter((blockId) => !this.handlers.has(blockId)).sort();
  }

  size(): number {
    return this.handlers.size;
  }
}
