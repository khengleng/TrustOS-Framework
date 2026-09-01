import {
  collectingAuditRecorder,
  collectingEventPublisher,
  productError,
  type ExecutionInput,
  type ProductActor,
  type ProductAuditRecord,
  type ProductEvent,
  type ProductDefinition,
} from '@trustsystem/financial-product-core';
import { fromMinorUnits, type Money } from '@trustsystem/financial-core';
import {
  BlockHandlerRegistry,
  InMemoryIdempotencyStore,
  ProductRuntime,
  type ExecutionRecord,
} from '@trustsystem/financial-product-runtime';
import type { PublishedVersion } from '@trustsystem/financial-product-versioning';
import {
  SANDBOX_CURRENCIES,
  bindSandboxConnectors,
  createSandboxState,
  sandboxConnectorRegistry,
  sandboxHandlers,
  type SandboxState,
} from './handlers';
import { ScenarioPlan, type ScenarioInjection, type SandboxScenario } from './scenarios';

/**
 * The sandbox.
 *
 * An isolated runtime wired entirely to mocks: mock providers, synthetic customers, synthetic
 * balances, and a scenario plan that makes a chosen block fail in a chosen way. Everything is
 * created per run and discarded after it.
 *
 * **The sandbox has no path to production data**, and that is structural rather than a rule
 * somebody follows. It constructs its own `ConnectorRegistry` — empty — its own idempotency
 * store, its own event publisher and its own audit recorder, all in memory. There is no
 * constructor parameter through which a production store could be passed, so "the sandbox must
 * never use production credentials" is not a policy this package enforces; it is a sentence that
 * has nowhere to be violated.
 *
 * A run is **deterministic**. The clock is fixed, references come from a counter, and the mock
 * handlers hold no randomness. Two runs of the same product with the same inputs produce
 * byte-identical records, which is what makes "did my change do anything" a comparison rather
 * than an impression.
 */

export interface SandboxRunInput {
  version: PublishedVersion;
  definition?: ProductDefinition;
  input: ExecutionInput;
  scenarios?: ScenarioInjection[];
  /** Opening synthetic balance. Defaults to a generous one, so a run fails for the reason chosen. */
  openingBalance?: Money;
  /** Limit ceilings, by code. Read from the product when omitted. */
  ceilings?: Record<string, Money>;
  idempotencyKey?: string | null;
  operation?: string;
  /** The synthetic actor. Defaults to a sandbox user in the platform tenant. */
  actor?: ProductActor;
  /** Fixed instant. Defaults to an epoch chosen so the output is stable across machines. */
  now?: Date;
}

export interface SandboxRunResult {
  execution: ExecutionRecord;
  events: ProductEvent[];
  audit: ProductAuditRecord[];
  state: SandboxState;
  /** Scenarios that were armed and never fired. An unfired scenario is a gap, not a pass. */
  unfiredScenarios: SandboxScenario[];
}

/** The fixed instant a sandbox run starts at, so two runs on two machines agree. */
export const SANDBOX_EPOCH = new Date('2026-01-01T00:00:00.000Z');

const SANDBOX_ACTOR: ProductActor = {
  actorId: 'usr_sandbox',
  actorType: 'user',
  organizationId: 'org_sandbox',
};

export async function runSandbox(input: SandboxRunInput): Promise<SandboxRunResult> {
  const definition = input.definition ?? input.version.definition;

  /*
   * A sandbox run is refused in production mode, always.
   *
   * The runtime's own binding refuses a non-active product in production; this refuses the
   * opposite mistake — a sandbox handed a production environment. Both directions matter,
   * because the expensive one is a mock handler answering a real request.
   */
  const ceilings = input.ceilings ?? ceilingsFrom(definition);

  const state = createSandboxState({
    openingBalance:
      input.openingBalance ??
      fromMinorUnits(100_000_000n, definition.supportedCurrencies[0] ?? 'XTS', SANDBOX_CURRENCIES),
    ceilings,
  });

  const plan = new ScenarioPlan(input.scenarios ?? []);
  const events = collectingEventPublisher();
  const audit = collectingAuditRecorder();
  const now = input.now ?? SANDBOX_EPOCH;

  const actor = input.actor ?? SANDBOX_ACTOR;

  const runtime = new ProductRuntime({
    handlers: new BlockHandlerRegistry(sandboxHandlers({ state, plan })),
    events,
    audit,
    // Mock connectors, constructed here rather than accepted: there is no parameter through
    // which a production connector registry could arrive.
    connectors: sandboxConnectorRegistry(actor.organizationId ?? 'org_sandbox'),
    clock: { now: () => now },
  });

  const execution = await runtime.execute({
    version: input.version,
    definition: bindSandboxConnectors(definition),
    actor,
    input: input.input,
    usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
    operation: input.operation ?? 'sandbox',
    idempotencyKey: input.idempotencyKey ?? null,
    environment: 'sandbox',
  });

  return {
    execution,
    events: events.events,
    audit: audit.records,
    state,
    unfiredScenarios: plan.unfired(),
  };
}

/**
 * A sandbox that keeps its state across runs.
 *
 * For exercising a sequence — a cash-in followed by a cash-out, or a duplicate request. Each run
 * still gets a fresh scenario plan, because a scenario that stayed armed across runs would make
 * the second run of an identical product behave differently from the first.
 */
export class Sandbox {
  private readonly state: SandboxState;
  private readonly events = collectingEventPublisher();
  private readonly audit = collectingAuditRecorder();
  private readonly connectors = sandboxConnectorRegistry('org_sandbox');
  private now: Date;

  constructor(
    private readonly version: PublishedVersion,
    options: { openingBalance?: Money; ceilings?: Record<string, Money>; now?: Date } = {},
  ) {
    const definition = version.definition;

    this.state = createSandboxState({
      openingBalance:
        options.openingBalance ??
        fromMinorUnits(
          100_000_000n,
          definition.supportedCurrencies[0] ?? 'XTS',
          SANDBOX_CURRENCIES,
        ),
      ceilings: options.ceilings ?? ceilingsFrom(definition),
    });

    this.now = options.now ?? SANDBOX_EPOCH;
  }

  /** Moves the sandbox clock. What a settlement-window test needs and a live runtime cannot have. */
  advance(milliseconds: number): this {
    this.now = new Date(this.now.getTime() + milliseconds);
    return this;
  }

  async run(input: {
    input: ExecutionInput;
    scenarios?: ScenarioInjection[];
    idempotencyKey?: string | null;
    operation?: string;
    definition?: ProductDefinition;
  }): Promise<SandboxRunResult> {
    const plan = new ScenarioPlan(input.scenarios ?? []);

    const runtime = new ProductRuntime({
      handlers: new BlockHandlerRegistry(sandboxHandlers({ state: this.state, plan })),
      events: this.events,
      audit: this.audit,
      connectors: this.connectors,
      idempotency: this.idempotency,
      clock: { now: () => this.now },
    });

    const execution = await runtime.execute({
      version: this.version,
      definition: bindSandboxConnectors(input.definition ?? this.version.definition),
      actor: SANDBOX_ACTOR,
      input: input.input,
      usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
      operation: input.operation ?? 'sandbox',
      idempotencyKey: input.idempotencyKey ?? null,
      environment: 'sandbox',
    });

    return {
      execution,
      events: [...this.events.events],
      audit: [...this.audit.records],
      state: this.state,
      unfiredScenarios: plan.unfired(),
    };
  }

  /**
   * Shared across runs, so a duplicate idempotency key is actually a duplicate.
   *
   * Constructed here rather than accepted as a parameter, for the same reason the connector
   * registry is: there is no way to hand this sandbox a production store.
   */
  private readonly idempotency = new InMemoryIdempotencyStore();

  balances(): SandboxState {
    return this.state;
  }
}

/** Reads the limit ceilings a product declares, so a sandbox run refuses where production would. */
function ceilingsFrom(definition: ProductDefinition): Record<string, Money> {
  const ceilings: Record<string, Money> = {};

  for (const limit of definition.limits) {
    if (!limit.amount) continue;
    ceilings[limit.code] = fromMinorUnits(
      BigInt(limit.amount.minorUnits),
      limit.amount.currency,
      SANDBOX_CURRENCIES,
    );
  }

  return ceilings;
}

/** Refuses a sandbox handed anything that looks like a production credential. */
export function assertSandboxSafe(configuration: Record<string, unknown>): void {
  const suspicious = Object.keys(configuration).filter((key) =>
    /secret|token|password|credential|apikey|api_key|private/i.test(key),
  );

  if (suspicious.length > 0) {
    throw productError(
      'product_sandbox_only',
      `The sandbox was handed ${suspicious.join(', ')}. It has no use for a credential — every ` +
        'provider is a mock — and anything that looks like one is a production value that ' +
        'reached a test path.',
      { actual: suspicious.join(',') },
    );
  }
}
