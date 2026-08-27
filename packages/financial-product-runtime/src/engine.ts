import { withRetry } from '@trustos/retry';
import type { Logger } from '@trustos/logging';
import {
  PRODUCT_AUDIT_ACTIONS,
  PRODUCT_EVENTS,
  START_NODE,
  newProductId,
  noopMetricSink,
  productError,
  systemClock,
  type ProductAuditRecorder,
  type ProductBlock,
  type ProductClock,
  type ProductDefinition,
  type ProductEventPublisher,
  type ProductExecutionContext,
  type ProductMetricSink,
  type ProductTransition,
  type ExecutionInput,
  type UsageSnapshot,
  type RiskSnapshot,
  type ProductActor,
} from '@trustos/financial-product-core';
import { evaluateCondition } from '@trustos/workflow-definition';
import { APPROVED_BLOCKS, type BlockRegistry } from '@trustos/financial-block-registry';
import { ConnectorRegistry, type ConnectorDefinition } from '@trustos/connector-registry';
import { buildFacts, evaluateRules, type RuleDecision } from '@trustos/financial-product-rules';
import {
  EXECUTION_MACHINE,
  executionOutcome,
  type ExecutionState,
} from '@trustos/financial-product-state-machine';
import {
  bindVersion,
  type PublishedVersion,
  type VersionBinding,
} from '@trustos/financial-product-versioning';
import { BlockHandlerRegistry, type BlockOutputs, type BlockResult } from './handlers';
import {
  InMemoryIdempotencyStore,
  classifyClaim,
  idempotencyConflict,
  requestHash,
  type IdempotencyStore,
} from './idempotency';

/**
 * The product runtime.
 *
 * Deterministic execution of an approved product definition. Every run follows the same thirteen
 * steps, in the same order, and the order is the design rather than an implementation detail —
 * section 24 of the specification lists them and this is where they live.
 *
 *    1. Load the approved definition. 2. Verify the version and its content hash. 3. Refuse
 *    anything that is not active in production. 4. Claim the idempotency key. 5. Create the
 *    execution context. 6. Evaluate the product rules. 7. Refuse if a rule denied. 8. Walk the
 *    graph, block by block. 9. Call handlers through the retry policy the product declared.
 *    10. Record every state transition. 11. Emit events. 12. Write audit records. 13. Store the
 *    result against the idempotency key.
 *
 * Three properties are worth stating before the code, because each one is a decision that could
 * plausibly have gone the other way and would be wrong:
 *
 * **The runtime never re-resolves the active version.** It binds once, at step 2, and every
 * subsequent decision reads the bound definition. A payment authorized under a 0.5% fee and
 * captured after the product moved to 0.75% settles at 0.5%, because the merchant was quoted a
 * price. See `@trustos/financial-product-versioning`.
 *
 * **The runtime never authorizes.** It receives an actor whose permissions were resolved
 * server-side, and the policy engine has already run. A runtime that authorized would be a second
 * implementation of the authorization decision, and the two disagree within a month.
 *
 * **A refusal is not a failure.** A limit reached, a rule denied, a review demanded — those are
 * the system working, and they end in `refused`, not `failed`. A metric that counts them together
 * reports a product enforcing its limits correctly as a product that is broken.
 */

export interface ExecutionStep {
  stepId: string;
  blockKey: string;
  blockId: string;
  attempt: number;
  outcome: BlockResult['outcome'];
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  /** Present on a refusal or a failure. A stable code, never a message the caller parses. */
  code?: string;
  reason?: string;
  outputs?: BlockOutputs;
  /** True when the block's declared SLA was exceeded. Reported, never acted on. */
  slaBreached: boolean;
}

export interface ExecutionRecord {
  executionId: string;
  productId: string;
  productVersion: string;
  variantId: string | null;
  organizationId: string | null;
  state: ExecutionState;
  outcome: 'success' | 'refusal' | 'failure' | 'open';
  steps: ExecutionStep[];
  /** The rule decision, with its full trace. What answers "why was this charged 2.47". */
  ruleDecision: RuleDecision;
  /** Set when a control refused. */
  refusal: { code: string; reason: string } | null;
  /** Set when the execution is waiting on a person. */
  pendingReview: { level: string; reason: string; blockKey: string } | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number;
  correlationId: string;
  /** The hash the execution bound to. Recorded so a dispute can prove which rules applied. */
  definitionHash: string;
}

export interface ProductRuntimeOptions {
  handlers: BlockHandlerRegistry;
  events: ProductEventPublisher;
  audit: ProductAuditRecorder;
  blocks?: BlockRegistry;
  connectors?: ConnectorRegistry;
  idempotency?: IdempotencyStore;
  metrics?: ProductMetricSink;
  clock?: ProductClock;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Hard ceiling on blocks executed in one run. A backstop, not a business rule. */
  maxSteps?: number;
}

export interface ExecuteInput {
  version: PublishedVersion;
  /** The variant's effective definition, when the caller is executing a variant. */
  definition?: ProductDefinition;
  variantId?: string | null;
  actor: ProductActor;
  input: ExecutionInput;
  usage: UsageSnapshot;
  risk?: RiskSnapshot;
  /** Which API operation started this. Scopes the idempotency key. */
  operation: string;
  idempotencyKey?: string | null;
  environment: 'production' | 'sandbox';
  /** Where to start, when the operation declares an entry block. Defaults to the graph's start. */
  entryBlock?: string | null;
  correlationId?: string;
}

/**
 * A bounded number of blocks per execution.
 *
 * The graph is acyclic — the validator refuses a cycle — so this can only fire on a definition
 * that reached production without validation, or on a bug here. It exists because "cannot happen"
 * and "does not happen" differ by one deployment, and an unbounded loop in a financial runtime is
 * an unbounded number of postings.
 */
const DEFAULT_MAX_STEPS = 200;

export class ProductRuntime {
  private readonly handlers: BlockHandlerRegistry;
  private readonly events: ProductEventPublisher;
  private readonly audit: ProductAuditRecorder;
  private readonly blocks: BlockRegistry;
  private readonly connectors: ConnectorRegistry;
  private readonly idempotency: IdempotencyStore;
  private readonly metrics: ProductMetricSink;
  private readonly clock: ProductClock;
  private readonly maxSteps: number;

  constructor(options: ProductRuntimeOptions) {
    this.handlers = options.handlers;
    this.events = options.events;
    this.audit = options.audit;
    this.blocks = options.blocks ?? APPROVED_BLOCKS;
    this.connectors = options.connectors ?? new ConnectorRegistry();
    this.idempotency = options.idempotency ?? new InMemoryIdempotencyStore();
    this.metrics = options.metrics ?? noopMetricSink;
    this.clock = options.clock ?? systemClock;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  }

  async execute(input: ExecuteInput): Promise<ExecutionRecord> {
    const startedAt = this.clock.now();

    // --- 1-3: bind the version -------------------------------------------
    const binding = bindVersion({
      version: input.version,
      variantId: input.variantId ?? null,
      variantVersion: null,
      environment: input.environment,
      now: startedAt,
    });

    const definition = input.definition ?? input.version.definition;

    // --- 4: claim the idempotency key --------------------------------------
    const hash = requestHash({ ...input.input.attributes, ...input.input.references, ...describeAmount(input.input) });
    const executionId = newProductId('execution');

    if (input.idempotencyKey) {
      const existing = await this.idempotency.claim({
        organizationId: input.actor.organizationId,
        productId: definition.productId,
        operation: input.operation,
        key: input.idempotencyKey,
        requestHash: hash,
        status: 'in_progress',
        executionId,
        result: null,
        createdAt: startedAt,
        expiresAt: new Date(startedAt.getTime() + 24 * 60 * 60 * 1000),
      });

      const claim = classifyClaim(existing, hash, startedAt);

      if (claim.kind === 'replay') {
        this.metrics.increment('financial_product.idempotent_replay', {
          product: definition.productId,
        });
        return claim.record.result as unknown as ExecutionRecord;
      }

      if (claim.kind === 'conflict') {
        await this.audit.record({
          action: PRODUCT_AUDIT_ACTIONS.IDEMPOTENCY_CONFLICT,
          occurredAt: startedAt,
          organizationId: input.actor.organizationId,
          actorId: input.actor.actorId,
          productId: definition.productId,
          productVersion: binding.version,
          entityId: claim.record.executionId,
          entityType: 'FinancialProductExecution',
          outcome: 'refused',
          detail: { operation: input.operation, sameRequest: claim.record.requestHash === hash },
        });

        throw idempotencyConflict(claim.record, claim.record.requestHash === hash);
      }
    }

    // --- 5: the execution context ------------------------------------------
    const context: ProductExecutionContext = {
      executionId,
      productId: definition.productId,
      productVersion: binding.version,
      definitionHash: binding.contentHash,
      variantId: input.variantId ?? null,
      actor: input.actor,
      organizationId: input.actor.organizationId,
      idempotencyKey: input.idempotencyKey ?? null,
      input: input.input,
      usage: input.usage,
      risk: input.risk ?? {},
      environment: input.environment,
      startedAt,
      correlationId: input.correlationId ?? executionId,
    };

    const record: ExecutionRecord = {
      executionId,
      productId: definition.productId,
      productVersion: binding.version,
      variantId: input.variantId ?? null,
      organizationId: input.actor.organizationId,
      state: 'initiated',
      outcome: 'open',
      steps: [],
      ruleDecision: evaluateRules(definition.rules, buildFacts(context)),
      refusal: null,
      pendingReview: null,
      startedAt,
      finishedAt: null,
      durationMs: 0,
      correlationId: context.correlationId,
      definitionHash: binding.contentHash,
    };

    await this.emit(context, PRODUCT_EVENTS.EXECUTION_STARTED, { operation: input.operation });
    await this.auditExecution(context, PRODUCT_AUDIT_ACTIONS.EXECUTION_STARTED, 'allowed', {
      operation: input.operation,
    });

    // --- 6-7: a rule may refuse before anything runs -----------------------
    if (record.ruleDecision.denied) {
      return this.finishRefused(
        context,
        record,
        record.ruleDecision.denied.code,
        record.ruleDecision.denied.reason,
        input,
      );
    }

    // --- 8-12: walk the graph ----------------------------------------------
    record.state = EXECUTION_MACHINE.assert('initiated', 'start').to;

    try {
      await this.walk(context, definition, record, input);
    } catch (error) {
      record.state = 'failed';
      record.outcome = 'failure';
      record.refusal = {
        code: 'runtime_error',
        reason: error instanceof Error ? error.message : 'Unknown runtime failure.',
      };
    }

    return this.finish(context, record, input);
  }

  // --- the walk ------------------------------------------------------------

  private async walk(
    context: ProductExecutionContext,
    definition: ProductDefinition,
    record: ExecutionRecord,
    input: ExecuteInput,
  ): Promise<void> {
    const priorOutputs: Record<string, BlockOutputs> = {};
    let current = this.firstNode(definition, input.entryBlock ?? null);
    let steps = 0;

    while (current && current !== 'completed' && current !== 'failed') {
      if (steps >= this.maxSteps) {
        throw productError(
          'product_not_executable',
          `Execution exceeded ${this.maxSteps} blocks. The graph should be acyclic; this is a ` +
            'definition that reached production without validation, or a runtime bug.',
          { productId: definition.productId, blockKey: current },
        );
      }
      steps += 1;

      const block = definition.blocks.find((candidate) => candidate.key === current);

      if (!block) {
        throw productError(
          'product_definition_invalid',
          `The graph transitions to "${current}", which the definition does not contain.`,
          { productId: definition.productId, blockKey: current },
        );
      }

      const result = await this.runBlock(context, definition, record, block, priorOutputs);

      if (result.outcome === 'success') {
        priorOutputs[block.key] = result.outputs;
        current = this.nextNode(definition, block.key, 'on_success', {
          ...facts(context, priorOutputs),
        });
        continue;
      }

      if (result.outcome === 'refused') {
        record.state = EXECUTION_MACHINE.assert(record.state, 'refuse').to;
        record.outcome = 'refusal';
        record.refusal = { code: result.code, reason: result.reason };
        return;
      }

      if (result.outcome === 'review_required') {
        record.state = EXECUTION_MACHINE.assert(record.state, 'hold_for_review').to;
        record.outcome = 'open';
        record.pendingReview = {
          level: result.level,
          reason: result.reason,
          blockKey: block.key,
        };

        await this.emit(context, PRODUCT_EVENTS.REVIEW_REQUIRED, {
          block: block.key,
          level: result.level,
        });
        await this.auditExecution(context, PRODUCT_AUDIT_ACTIONS.REVIEW_REQUIRED, 'allowed', {
          block: block.key,
          level: result.level,
        });
        return;
      }

      if (result.outcome === 'awaiting_provider') {
        record.state = EXECUTION_MACHINE.assert(record.state, 'await_provider').to;
        record.outcome = 'open';
        return;
      }

      // --- failure ---------------------------------------------------------
      await this.handleFailure(context, definition, record, block, result, priorOutputs);
      return;
    }

    if (current === 'failed') {
      record.state = EXECUTION_MACHINE.assert(record.state, 'fail').to;
      record.outcome = 'failure';
      return;
    }

    record.state = EXECUTION_MACHINE.assert(record.state, 'complete').to;
    record.outcome = 'success';
  }

  /**
   * Runs one block, through its declared retry policy.
   *
   * Retry goes through `withRetry` rather than a loop here, and that is not a style preference:
   * `withRetry` applies jitter, and without jitter every client that failed together retries
   * together — which is how a partial outage becomes a total one.
   *
   * A block is retried only when the **catalog** says it is idempotent, whatever the product
   * configured. A product that asked to retry a non-idempotent block is refused at validation;
   * this is the second line, for a definition that got past it.
   */
  private async runBlock(
    context: ProductExecutionContext,
    definition: ProductDefinition,
    record: ExecutionRecord,
    block: ProductBlock,
    priorOutputs: Record<string, BlockOutputs>,
  ): Promise<BlockResult> {
    const catalog = this.blocks.require(block.blockId, block.blockVersion);
    const handler = this.handlers.require(block.blockId);
    const connector = this.resolveConnector(context, definition, block, catalog.providerInterface);

    const startedAt = this.clock.now();
    let attempts = 1;
    let result: BlockResult;

    const invoke = async (attempt: number): Promise<BlockResult> => {
      attempts = attempt;
      const outcome = await handler.execute({
        context,
        block,
        connector,
        priorOutputs,
        attempt,
      });

      /*
       * A retryable failure is thrown so `withRetry` can see it.
       *
       * Returning it would make every failure terminal, and a provider timeout that the product
       * configured three retries for would get one attempt. The throw is caught immediately
       * below; it never escapes this method.
       */
      if (outcome.outcome === 'failed' && outcome.retryable) {
        throw Object.assign(new Error(outcome.reason), { blockResult: outcome, retryable: true });
      }

      return outcome;
    };

    const canRetry = block.retry !== undefined && catalog.idempotent;

    try {
      if (canRetry) {
        const outcome = await withRetry(invoke, {
          operation: `${definition.productId}:${block.key}`,
          policy: {
            maxAttempts: (block.retry?.maxAttempts ?? 1) - 1,
            strategy: block.retry?.backoff ?? 'exponential',
            initialDelayMs: block.retry?.initialDelayMs ?? 200,
            maxDelayMs: block.retry?.maxDelayMs ?? 5000,
            multiplier: 2,
            jitter: 'full',
            totalTimeoutMs: block.timeoutMs ?? 60_000,
            retryOn: [],
          } as never,
          isRetryable: (error) => Boolean((error as { retryable?: boolean }).retryable),
        });
        result = outcome.value;
        attempts = outcome.attempts;
      } else {
        result = await invoke(1);
      }
    } catch (error) {
      const carried = (error as { blockResult?: BlockResult }).blockResult;
      result =
        carried ??
        ({
          outcome: 'failed',
          code: 'handler_error',
          reason: error instanceof Error ? error.message : 'The handler threw.',
          retryable: false,
        } as BlockResult);
    }

    const finishedAt = this.clock.now();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    const step: ExecutionStep = {
      stepId: newProductId('step'),
      blockKey: block.key,
      blockId: block.blockId,
      attempt: attempts,
      outcome: result.outcome,
      startedAt,
      finishedAt,
      durationMs,
      slaBreached: block.slaMs !== undefined && durationMs > block.slaMs,
      ...(result.outcome === 'success' ? { outputs: result.outputs } : {}),
      ...('code' in result ? { code: result.code } : {}),
      ...('reason' in result ? { reason: result.reason } : {}),
    };

    record.steps.push(step);

    this.metrics.observe('financial_product.block_latency_ms', {
      product: definition.productId,
      block: block.blockId,
      outcome: result.outcome,
    }, durationMs);

    if (result.outcome === 'success') {
      await this.emit(context, PRODUCT_EVENTS.EXECUTION_STEP_COMPLETED, {
        block: block.key,
        attempt: attempts,
      });
    }

    if (result.outcome === 'refused') {
      await this.auditExecution(context, PRODUCT_AUDIT_ACTIONS.LIMIT_REFUSED, 'refused', {
        block: block.key,
        code: result.code,
      });
    }

    return result;
  }

  /**
   * What happens when a block fails.
   *
   * Three modes, declared per block. `compensate` is a **state**, not a `finally` clause —
   * compensation can itself fail, and an execution whose compensation failed is materially
   * different from one that never started compensating: the first has a half-unwound transaction
   * that a person must finish.
   */
  private async handleFailure(
    context: ProductExecutionContext,
    definition: ProductDefinition,
    record: ExecutionRecord,
    block: ProductBlock,
    result: Extract<BlockResult, { outcome: 'failed' }>,
    priorOutputs: Record<string, BlockOutputs>,
  ): Promise<void> {
    record.refusal = { code: result.code, reason: result.reason };

    if (block.onFailure === 'route') {
      const next = this.nextNode(definition, block.key, 'on_failure', facts(context, priorOutputs));

      if (next && next !== 'failed') {
        record.state = 'running';
        return;
      }

      record.state = EXECUTION_MACHINE.assert(record.state, 'fail').to;
      record.outcome = 'failure';
      return;
    }

    if (block.onFailure === 'compensate' && block.compensateWith.length > 0) {
      record.state = EXECUTION_MACHINE.assert(record.state, 'compensate').to;

      const compensated = await this.compensate(context, definition, record, block, priorOutputs);

      record.state = EXECUTION_MACHINE.assert(
        record.state,
        compensated ? 'compensated' : 'compensation_failed',
      ).to;
      record.outcome = 'failure';

      await this.emit(context, PRODUCT_EVENTS.EXECUTION_COMPENSATED, {
        block: block.key,
        complete: compensated,
      });
      return;
    }

    record.state = EXECUTION_MACHINE.assert(record.state, 'fail').to;
    record.outcome = 'failure';
  }

  /** Runs the compensating blocks in reverse declaration order. Returns whether all succeeded. */
  private async compensate(
    context: ProductExecutionContext,
    definition: ProductDefinition,
    record: ExecutionRecord,
    failed: ProductBlock,
    priorOutputs: Record<string, BlockOutputs>,
  ): Promise<boolean> {
    for (const key of [...failed.compensateWith].reverse()) {
      const block = definition.blocks.find((candidate) => candidate.key === key);
      if (!block) return false;

      const result = await this.runBlock(context, definition, record, block, priorOutputs);
      if (result.outcome !== 'success') return false;
    }

    return true;
  }

  // --- graph ---------------------------------------------------------------

  private firstNode(definition: ProductDefinition, entryBlock: string | null): string | null {
    if (entryBlock) {
      const exists = definition.blocks.some((block) => block.key === entryBlock);
      if (!exists) {
        throw productError(
          'product_definition_invalid',
          `The operation enters at "${entryBlock}", which this product does not contain.`,
          { productId: definition.productId, blockKey: entryBlock },
        );
      }
      return entryBlock;
    }

    return (
      definition.transitions.find((transition) => transition.from === START_NODE)?.to ?? null
    );
  }

  /**
   * Which node comes next.
   *
   * Conditional transitions are evaluated in declaration order and the **first match wins**;
   * `always` and the matching kind come last. That order is deliberate: a conditional branch is a
   * decision the product author wrote, and an unconditional fallback beside it is the default.
   * Evaluating the fallback first would make every branch dead.
   */
  private nextNode(
    definition: ProductDefinition,
    from: string,
    kind: 'on_success' | 'on_failure',
    data: Record<string, unknown>,
  ): string | null {
    const outgoing = definition.transitions.filter(
      (transition: ProductTransition) => transition.from === from,
    );

    for (const transition of outgoing) {
      if (transition.kind !== 'conditional') continue;
      if (transition.when && evaluateCondition(transition.when, data)) return transition.to;
    }

    const fallback = outgoing.find(
      (transition) => transition.kind === kind || transition.kind === 'always',
    );

    return fallback?.to ?? null;
  }

  private resolveConnector(
    context: ProductExecutionContext,
    definition: ProductDefinition,
    block: ProductBlock,
    providerInterface: string | undefined,
  ): ConnectorDefinition | null {
    if (!providerInterface) return null;

    /*
     * A rule may select the connector, and it may only select an approved one.
     *
     * The registry check is what makes that true rather than advisory: a rule proposing a
     * connector the tenant has not approved is provider substitution, and it is on the
     * specification's threat list precisely because the product keeps working afterwards.
     */
    const connectorId =
      block.connectorId ??
      definition.providers.find((provider) => provider.providerInterface === providerInterface)
        ?.connectorId;

    if (!connectorId) {
      throw productError(
        'product_provider_unbound',
        `Block "${block.key}" needs a ${providerInterface} and nothing binds one.`,
        { productId: definition.productId, blockKey: block.key },
      );
    }

    return this.connectors.requireBindable(
      context.organizationId,
      connectorId,
      providerInterface,
    );
  }

  // --- finishing -----------------------------------------------------------

  private async finishRefused(
    context: ProductExecutionContext,
    record: ExecutionRecord,
    code: string,
    reason: string,
    input: ExecuteInput,
  ): Promise<ExecutionRecord> {
    record.state = 'refused';
    record.outcome = 'refusal';
    record.refusal = { code, reason };

    await this.emit(context, PRODUCT_EVENTS.RULE_DENIED, { code });
    return this.finish(context, record, input);
  }

  private async finish(
    context: ProductExecutionContext,
    record: ExecutionRecord,
    input: ExecuteInput,
  ): Promise<ExecutionRecord> {
    const finishedAt = this.clock.now();

    record.finishedAt = finishedAt;
    record.durationMs = finishedAt.getTime() - record.startedAt.getTime();
    record.outcome = executionOutcome(record.state);

    const eventName =
      record.outcome === 'success'
        ? PRODUCT_EVENTS.EXECUTION_COMPLETED
        : record.outcome === 'failure'
          ? PRODUCT_EVENTS.EXECUTION_FAILED
          : null;

    if (eventName) await this.emit(context, eventName, { state: record.state });

    await this.auditExecution(
      context,
      record.outcome === 'success'
        ? PRODUCT_AUDIT_ACTIONS.EXECUTION_COMPLETED
        : record.outcome === 'refusal'
          ? PRODUCT_AUDIT_ACTIONS.EXECUTION_REFUSED
          : PRODUCT_AUDIT_ACTIONS.EXECUTION_FAILED,
      record.outcome === 'refusal' ? 'refused' : record.outcome === 'failure' ? 'failed' : 'allowed',
      {
        state: record.state,
        steps: record.steps.length,
        durationMs: record.durationMs,
        ...(record.refusal ? { code: record.refusal.code } : {}),
      },
    );

    this.metrics.increment('financial_product.executions', {
      product: record.productId,
      outcome: record.outcome,
    });
    this.metrics.observe(
      'financial_product.execution_latency_ms',
      { product: record.productId, outcome: record.outcome },
      record.durationMs,
    );

    if (input.idempotencyKey) {
      await this.idempotency.complete(
        context.organizationId,
        record.productId,
        input.operation,
        input.idempotencyKey,
        record.outcome === 'failure' ? 'failed' : 'completed',
        record as unknown as Record<string, unknown>,
      );
    }

    return record;
  }

  private async emit(
    context: ProductExecutionContext,
    name: string,
    data: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    await this.events.publish({
      name,
      occurredAt: this.clock.now(),
      organizationId: context.organizationId,
      executionId: context.executionId,
      productId: context.productId,
      productVersion: context.productVersion,
      correlationId: context.correlationId,
      data,
    });
  }

  private async auditExecution(
    context: ProductExecutionContext,
    action: string,
    outcome: 'allowed' | 'refused' | 'failed',
    detail: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    await this.audit.record({
      action,
      occurredAt: this.clock.now(),
      organizationId: context.organizationId,
      actorId: context.actor.actorId,
      productId: context.productId,
      productVersion: context.productVersion,
      entityId: context.executionId,
      entityType: 'FinancialProductExecution',
      outcome,
      detail,
    });
  }
}

/**
 * The data a transition condition is evaluated against.
 *
 * The rule facts plus the outputs of blocks that have already run, namespaced under their block
 * key. Namespacing matters: two blocks both producing `status` would otherwise overwrite each
 * other, and a branch would be taken on whichever ran last.
 */
function facts(
  context: ProductExecutionContext,
  priorOutputs: Record<string, BlockOutputs>,
): Record<string, unknown> {
  return { ...buildFacts(context), ...priorOutputs };
}

/** The amount, for the idempotency hash. Absent when the operation carries none. */
function describeAmount(input: ExecutionInput): Record<string, string> {
  if (!input.amountMinorUnits) return {};
  return { amountMinorUnits: input.amountMinorUnits, currency: input.currency ?? '' };
}
