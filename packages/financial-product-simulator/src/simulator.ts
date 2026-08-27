import {
  collectingAuditRecorder,
  type ExecutionInput,
  type ProductActor,
  type ProductDefinition,
} from '@trustos/financial-product-core';
import { fromMinorUnits } from '@trustos/financial-core';
import {
  BlockHandlerRegistry,
  InMemoryIdempotencyStore,
  ProductRuntime,
  type ExecutionRecord,
} from '@trustos/financial-product-runtime';
import type { PublishedVersion } from '@trustos/financial-product-versioning';
import {
  SANDBOX_CURRENCIES,
  ScenarioPlan,
  bindSandboxConnectors,
  createSandboxState,
  sandboxConnectorRegistry,
  sandboxHandlers,
  type SandboxScenario,
} from '@trustos/financial-product-sandbox';
import { summarise, type SimulationReport } from './metrics';

/**
 * The product simulator.
 *
 * Ten transactions, a thousand, a hundred thousand — against the sandbox, with no production
 * data anywhere on the path. What it answers is the set of questions a product owner cannot
 * answer by reading a definition: **which branch do transactions actually take**, what do the
 * fees add up to, how often does the limit refuse, and how many end up in front of a person.
 *
 * Three properties make the numbers worth quoting.
 *
 * **It is deterministic.** The amount distribution comes from a seeded generator, the clock is
 * fixed, and the mock handlers hold no randomness. The same seed produces the same report, which
 * is what makes "we changed the fee tier and the totals moved" a measurement rather than an
 * impression. `seed` is a required field for exactly that reason: an optional one gets omitted,
 * and then two reports cannot be compared.
 *
 * **It reuses one runtime.** A hundred thousand executions each constructing a handler registry
 * over eighty-four blocks is a hundred thousand registries; the runtime, the handlers and the
 * connector registry are built once and the *state* is reset per transaction where it needs to
 * be. This is what makes 100,000 finish in seconds rather than minutes.
 *
 * **It never touches production.** It runs through `@trustos/financial-product-sandbox`, which
 * has no constructor parameter through which a production store could arrive. There is nothing
 * to configure wrongly.
 *
 * What it is **not**: a load test. Every handler is a mock that returns immediately, so the
 * latency figures measure the runtime's own overhead and say nothing about a provider. Reporting
 * them as throughput would be reporting a number that has never met a network.
 */

export interface SimulationInput {
  version: PublishedVersion;
  definition?: ProductDefinition;
  /** How many transactions. */
  count: number;
  /** Required. An optional seed is an omitted seed, and then two reports cannot be compared. */
  seed: number;
  /** The amount range, in minor units. Amounts are drawn uniformly across it. */
  amountRange?: { minMinorUnits: string; maxMinorUnits: string };
  currency?: string;
  /** Scenario mix: how often each failure is injected, as a proportion of transactions. */
  scenarioMix?: Partial<Record<SandboxScenario, number>>;
  /** Transaction types to draw from, uniformly. */
  transactionTypes?: string[];
  /** Merchant tiers to draw from. Exercises tier-dependent fee rules. */
  merchantTiers?: string[];
  actor?: ProductActor;
  now?: Date;
  /** Reset the synthetic balance every N transactions, so a long run does not simply run dry. */
  resetBalanceEvery?: number;
  /** Send a duplicate of every Nth transaction, exercising the idempotent replay path. */
  duplicateEvery?: number;
}

const SIMULATION_ACTOR: ProductActor = {
  actorId: 'usr_simulator',
  actorType: 'service_account',
  organizationId: 'org_sandbox',
};

const SIMULATION_EPOCH = new Date('2026-01-01T00:00:00.000Z');

/**
 * A seeded generator.
 *
 * `mulberry32` — thirty-two bits of state, four operations per draw, and the same sequence on
 * every platform. Deliberately not `Math.random()`: an unseeded generator makes every simulation
 * a different simulation, and the first thing anybody does with a simulator is run it twice.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export async function simulate(input: SimulationInput): Promise<SimulationReport> {
  const definition = bindSandboxConnectors(input.definition ?? input.version.definition);
  const currency = input.currency ?? definition.supportedCurrencies[0] ?? 'XTS';
  const actor = input.actor ?? SIMULATION_ACTOR;
  const now = input.now ?? SIMULATION_EPOCH;

  const random = mulberry32(input.seed);

  const min = BigInt(input.amountRange?.minMinorUnits ?? '100');
  const max = BigInt(input.amountRange?.maxMinorUnits ?? '400000');
  const span = max > min ? max - min : 1n;

  const types = input.transactionTypes ?? ['CREDIT'];
  const tiers = input.merchantTiers ?? ['STANDARD'];

  const mix = Object.entries(input.scenarioMix ?? {}) as Array<[SandboxScenario, number]>;

  /*
   * Built once, outside the loop.
   *
   * A hundred thousand executions each constructing a handler registry over eighty-four blocks
   * is a hundred thousand registries, and the simulator would spend its time on that rather than
   * on the product.
   */
  const state = createSandboxState({
    openingBalance: fromMinorUnits(100_000_000_000n, currency, SANDBOX_CURRENCIES),
    ceilings: ceilingsFrom(definition, currency),
  });

  const connectors = sandboxConnectorRegistry(actor.organizationId ?? 'org_sandbox');
  const idempotency = new InMemoryIdempotencyStore();

  /*
   * Events and audit are collected and discarded rather than published.
   *
   * A hundred thousand executions produce close to a million events, and holding them all is
   * hundreds of megabytes for numbers nobody reads. The counts are what the report needs, and
   * the counts come from the execution records.
   */
  const events = { publish: async () => undefined };
  const audit = collectingAuditRecorder();

  const records: ExecutionRecord[] = [];
  const startedAt = Date.now();

  /*
   * The previous transaction, kept so a duplicate can repeat it exactly.
   *
   * A "duplicate" that changed the amount would be an idempotency *conflict*, not a replay —
   * a different and also interesting path, but not the one `duplicateEvery` is asking for. The
   * replay is what a client retry after a timeout looks like, and it is the common case.
   */
  let previous: { input: ExecutionInput; key: string } | null = null;

  for (let index = 0; index < input.count; index += 1) {
    const plan = new ScenarioPlan(pickScenario(mix, random()));

    const runtime = new ProductRuntime({
      handlers: new BlockHandlerRegistry(sandboxHandlers({ state, plan })),
      events,
      audit,
      connectors,
      idempotency,
      clock: { now: () => now },
    });

    const amountMinorUnits = (min + (BigInt(Math.floor(random() * 1_000_000)) * span) / 1_000_000n).toString();

    const executionInput: ExecutionInput = {
      amountMinorUnits,
      currency,
      transactionType: types[Math.floor(random() * types.length)] as string,
      merchantTier: tiers[Math.floor(random() * tiers.length)] as string,
      references: {},
      attributes: {},
    };

    const isDuplicate: boolean =
      input.duplicateEvery !== undefined &&
      index > 0 &&
      index % input.duplicateEvery === 0 &&
      previous !== null;

    const attempt: { input: ExecutionInput; key: string } =
      isDuplicate && previous
        ? previous
        : { input: executionInput, key: `idm_sim_${input.seed}_${index}` };

    records.push(
      await runtime.execute({
        version: input.version,
        definition,
        actor,
        input: attempt.input,
        usage: { dailyUsageMinorUnits: '0', monthlyUsageMinorUnits: '0', velocityCount: 0 },
        operation: 'simulate',
        idempotencyKey: input.duplicateEvery === undefined ? null : attempt.key,
        environment: 'sandbox',
      }),
    );

    if (!isDuplicate) previous = attempt;

    if (input.resetBalanceEvery && index % input.resetBalanceEvery === 0) {
      state.balances.set('default', fromMinorUnits(100_000_000_000n, currency, SANDBOX_CURRENCIES));
      state.consumed.clear();
    }
  }

  return summarise({
    productId: definition.productId,
    version: input.version.version,
    seed: input.seed,
    requested: input.count,
    records,
    wallClockMs: Date.now() - startedAt,
    state,
    limitsResetPerTransaction: input.resetBalanceEvery === 1,
  });
}

/** Picks a scenario from the mix, or none. Consumes exactly one random draw either way. */
function pickScenario(
  mix: ReadonlyArray<[SandboxScenario, number]>,
  draw: number,
): Array<{ scenario: SandboxScenario; times: number }> {
  let cumulative = 0;

  for (const [scenario, proportion] of mix) {
    cumulative += proportion;
    if (draw < cumulative) return [{ scenario, times: 1 }];
  }

  return [];
}

function ceilingsFrom(definition: ProductDefinition, fallbackCurrency: string) {
  const ceilings: Record<string, ReturnType<typeof fromMinorUnits>> = {};

  for (const limit of definition.limits) {
    if (!limit.amount) continue;
    ceilings[limit.code] = fromMinorUnits(
      BigInt(limit.amount.minorUnits),
      limit.amount.currency || fallbackCurrency,
      SANDBOX_CURRENCIES,
    );
  }

  return ceilings;
}
