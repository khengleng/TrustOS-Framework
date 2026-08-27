import { z } from 'zod';

/**
 * The execution context, and the ports the runtime reaches the outside world through.
 *
 * Defined in `core` because four packages need the same shape and none of them should have to
 * depend on the runtime to get it: the sandbox builds one, the simulator builds thousands, the
 * rules engine reads one, and the runtime is the only thing that executes one.
 *
 * The ports are the deliberate hole in the middle of this layer. The framework ships **no**
 * event bus binding, **no** audit sink, **no** metric exporter and **no** clock — a deployment
 * wires the ones it already has. That is not minimalism: an event publisher shipped here would
 * be a second one beside `@trustos/event-bus`, and the two would have different delivery
 * guarantees while looking identical at the call site.
 */

/**
 * Who is executing, resolved server-side.
 *
 * Note what is absent. There is no `roles`, no `permissions` and no `organizationId` that a
 * caller could supply: the organization comes from the verified actor and the server-side
 * membership lookup, and a rule that could read the caller's roles would let the caller decide
 * the fee. The runtime receives an already-authorized actor; it does not authorize one.
 */
export interface ProductActor {
  /** The verified actor's identifier. */
  actorId: string;
  /** `user`, `service_account` or `api_key` — what kind of credential authenticated. */
  actorType: 'user' | 'service_account' | 'api_key';
  /** The organization, from the verified actor. Null is the platform tenant, not a wildcard. */
  organizationId: string | null;
}

/**
 * The inputs one execution runs against.
 *
 * Everything a rule may read arrives here, and nothing else does. `attributes` is bounded
 * scalars — the same restriction the rule facts carry — because a nested payload in the context
 * is a payload the rules engine would eventually be asked to reach into.
 */
export const executionInputSchema = z
  .object({
    /** Minor units as a string. Never a number. See `definition.ts`. */
    amountMinorUnits: z.string().regex(/^[0-9]{1,24}$/).optional(),
    currency: z.string().min(3).max(8).optional(),
    country: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/).optional(),
    transactionType: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/).optional(),
    customerType: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/).optional(),
    merchantType: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/).optional(),
    merchantTier: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/).optional(),
    channel: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/).optional(),
    kycLevel: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/).optional(),
    /** Opaque references the blocks resolve. Ids, never records. */
    references: z.record(z.string().max(120)).default({}),
    /** Anything else a block reads. Scalars only, bounded. */
    attributes: z
      .record(z.union([z.string().max(400), z.number().finite(), z.boolean()]))
      .refine((value) => Object.keys(value).length <= 50, 'At most 50 attributes.')
      .default({}),
  })
  .strict();

export type ExecutionInput = z.infer<typeof executionInputSchema>;

/**
 * Usage the limit engine already knows about.
 *
 * Supplied by the caller rather than fetched by the rules engine, because a rule that performed
 * I/O would be a rule whose answer depends on when it ran — and the whole promise of this layer
 * is that the same inputs produce the same decision. The runtime reads these once, before rule
 * evaluation, and passes the snapshot down.
 */
export interface UsageSnapshot {
  dailyUsageMinorUnits: string;
  monthlyUsageMinorUnits: string;
  velocityCount: number;
}

/** Risk the upstream checks produced, if any ran. */
export interface RiskSnapshot {
  score?: number;
  level?: string;
}

export interface ProductExecutionContext {
  executionId: string;
  productId: string;
  /** The exact version this execution is bound to for its whole life. Never re-resolved. */
  productVersion: string;
  /** The definition hash at bind time. The check that survives a direct database edit. */
  definitionHash: string;
  variantId: string | null;
  actor: ProductActor;
  organizationId: string | null;
  /** The client's key. Present for every operation that creates something. */
  idempotencyKey: string | null;
  input: ExecutionInput;
  usage: UsageSnapshot;
  risk: RiskSnapshot;
  /** `production` or `sandbox`. The runtime refuses to run a non-active product in `production`. */
  environment: 'production' | 'sandbox';
  startedAt: Date;
  /** Correlates every event, audit record and log line for this execution. */
  correlationId: string;
}

// --- ports -----------------------------------------------------------------

/**
 * The clock.
 *
 * A port rather than `new Date()` because a simulation of a hundred thousand transactions across
 * three settlement windows has to be able to move time, and a runtime that reads the wall clock
 * cannot be simulated at all. It is also what makes "did this breach its SLA" testable.
 */
export interface ProductClock {
  now(): Date;
}

export const systemClock: ProductClock = { now: () => new Date() };

/** An event the runtime emitted. Amounts are strings; balances never appear. */
export interface ProductEvent {
  name: string;
  occurredAt: Date;
  organizationId: string | null;
  executionId: string;
  productId: string;
  productVersion: string;
  correlationId: string;
  /** Ids, outcomes and string amounts. No payload, no balance, no personal data. */
  data: Record<string, string | number | boolean | null>;
}

/**
 * Where events go.
 *
 * A port, and the framework ships only an in-memory implementation for tests. A deployment wires
 * `@trustos/event-bus`. Publishing is `void` rather than `Promise` at the call sites that matter:
 * the runtime records the event as part of its own step record first, so a publisher that throws
 * cannot lose the fact that the step happened.
 */
export interface ProductEventPublisher {
  publish(event: ProductEvent): Promise<void>;
}

/** One audit record. What moved, who decided, and under which version. */
export interface ProductAuditRecord {
  action: string;
  occurredAt: Date;
  organizationId: string | null;
  actorId: string;
  productId: string;
  productVersion: string | null;
  /** The thing acted on: an execution, a version, a connector. */
  entityId: string;
  entityType: string;
  outcome: 'allowed' | 'refused' | 'failed';
  /** Diagnostic detail. Identifiers and reasons — never a payload or a secret. */
  detail: Record<string, string | number | boolean | null>;
}

export interface ProductAuditRecorder {
  record(entry: ProductAuditRecord): Promise<void>;
}

/**
 * Metrics.
 *
 * Bounded, low-cardinality dimensions only — the type says so, and
 * `@trustos/financial-product-observability` enforces it. A metric dimension carrying a customer
 * id produces a time series per customer, which is how a metrics bill becomes the largest line
 * in an infrastructure budget and how tenant data ends up somewhere nobody classified.
 */
export interface ProductMetricSink {
  increment(name: string, dimensions: Record<string, string>, value?: number): void;
  observe(name: string, dimensions: Record<string, string>, milliseconds: number): void;
}

/** A sink that discards. The default, so a runtime with no observability wired still runs. */
export const noopMetricSink: ProductMetricSink = {
  increment: () => undefined,
  observe: () => undefined,
};

/** A publisher that discards. Never a default in production — the runtime demands one explicitly. */
export function collectingEventPublisher(): ProductEventPublisher & { events: ProductEvent[] } {
  const events: ProductEvent[] = [];
  return {
    events,
    publish: async (event) => {
      events.push(event);
    },
  };
}

/** An audit recorder that collects. For tests, and for the sandbox. */
export function collectingAuditRecorder(): ProductAuditRecorder & { records: ProductAuditRecord[] } {
  const records: ProductAuditRecord[] = [];
  return {
    records,
    record: async (entry) => {
      records.push(entry);
    },
  };
}
