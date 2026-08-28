import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ActorType } from '@trustos/shared-types';

/**
 * The event envelope.
 *
 * Every event in the system has the same outer shape and a payload the schema registry
 * validates. The split matters: the envelope is the framework's, the payload is the
 * publisher's, and a consumer can route, deduplicate and audit an event without understanding
 * its payload at all.
 *
 * The fields that are not obvious, and why each is here:
 *
 *   * **`idempotencyKey`** — a consumer that receives the same event twice must be able to tell.
 *     Delivery is at-least-once in every real system, and "exactly once" is a property of the
 *     consumer rather than of the bus.
 *   * **`correlationId`** — ties an event to the chain of work that produced it, across
 *     process boundaries. A single failed webhook is nearly useless to debug; the same failure
 *     with the correlation id that started at an HTTP request is a story.
 *   * **`actor` and `organizationId`** — an event without them cannot be audited or scoped, and
 *     an event that reaches the wrong tenant's subscriber is the worst outcome in this phase.
 *   * **`version`** — a payload shape changes, and a consumer written against v1 must be able to
 *     say so rather than crash on a v2 it does not understand.
 */

export const eventVersionSchema = z
  .string()
  .regex(/^\d+$/, 'An event version is a whole number, as a string: "1", "2".')
  .describe('Schema version of the payload.');

/**
 * An event name.
 *
 * `domain.entity.action`, past tense. Past tense because an event is a record of something that
 * already happened — `user.created`, not `user.create` — and a name in the imperative is a
 * command masquerading as an event, which is how a bus turns into an RPC mechanism nobody
 * intended.
 */
export const eventNameSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(
    /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/,
    'An event name is lowercase, dot-separated, and reads as something that happened: ' +
      '"user.created", "workflow.instance.completed".',
  );

export const eventActorSchema = z
  .object({
    /** Null for a system-initiated event. Not the empty string — see `isSameActor` in workflow-core. */
    id: z.string().min(1).max(64).nullable(),
    type: z.enum(['user', 'service_account', 'api_key', 'system']),
    /** Resolved server-side. Never read from a claim. */
    roles: z.array(z.string().max(120)).max(50).default([]),
  })
  .strict();

export type EventActor = z.infer<typeof eventActorSchema> & { type: ActorType };

export const eventMetadataSchema = z
  .object({
    /**
     * Ties this event to the work that caused it.
     *
     * Propagated across every event a handler publishes, so a chain that starts at one HTTP
     * request is traceable to its end. Generated when absent rather than left null, because an
     * event with no correlation id breaks the chain for everything downstream of it.
     */
    correlationId: z.string().min(1).max(64),
    /** The HTTP request that caused it, when there was one. */
    requestId: z.string().min(1).max(64).nullable().default(null),
    /** Distributed trace id, when tracing is on. */
    traceId: z.string().min(1).max(64).nullable().default(null),
    /**
     * The event this one is a consequence of.
     *
     * Distinct from `correlationId`: correlation is the whole chain, causation is the single
     * parent. Both are needed to reconstruct a tree rather than a flat list.
     */
    causationId: z.string().min(1).max(64).nullable().default(null),
    /** Which application published it. */
    source: z.string().min(1).max(120),
    /** Free-form, non-sensitive. Redacted before storage. */
    attributes: z
      .record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
      .default({}),
  })
  .strict();

export type EventMetadata = z.infer<typeof eventMetadataSchema>;

export const eventEnvelopeSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: eventNameSchema,
    version: eventVersionSchema,

    /**
     * The owning organization.
     *
     * Null only for a genuinely platform-level event — `application.started`, a health change.
     * A tenant event with a null organization is one the bus cannot scope, so
     * `assertTenantScoped` refuses to deliver it to a tenant subscriber.
     */
    organizationId: z.string().min(1).max(64).nullable(),

    actor: eventActorSchema,

    /**
     * What the event is about: `{ type: 'Merchant', id: 'mch_1' }`.
     *
     * Also the ordering key — see `OrderedEventBus`. Two events about the same aggregate are
     * delivered in order; two about different aggregates are not, because a total order across
     * a whole system is a throughput ceiling nobody asked for.
     */
    aggregate: z
      .object({
        type: z.string().min(1).max(120),
        id: z.string().min(1).max(64),
      })
      .strict()
      .nullable()
      .default(null),

    /**
     * Deduplication key.
     *
     * Defaults to the event id, which makes redelivery of the *same* event idempotent. A
     * publisher deriving it from business identity — `invoice-paid:inv_123` — additionally makes
     * two *different* publications of the same fact idempotent, which is what you want when a
     * retry re-runs the code that publishes.
     */
    idempotencyKey: z.string().min(1).max(200),

    occurredAt: z.coerce.date(),
    metadata: eventMetadataSchema,

    /** Validated by the registry against the schema for `name` at `version`. */
    payload: z.unknown(),
  })
  .strict();

export type EventEnvelope<TPayload = unknown> = Omit<
  z.infer<typeof eventEnvelopeSchema>,
  'payload'
> & { payload: TPayload };

export interface BuildEventInput<TPayload> {
  name: string;
  version?: string;
  payload: TPayload;
  organizationId: string | null;
  actor: EventActor;
  aggregate?: { type: string; id: string } | null;
  idempotencyKey?: string;
  correlationId?: string;
  requestId?: string | null;
  traceId?: string | null;
  causationId?: string | null;
  source: string;
  attributes?: Record<string, string | number | boolean | null>;
  occurredAt?: Date;
}

/**
 * Builds an envelope, filling in what a publisher should not have to.
 *
 * `correlationId` is generated when absent rather than left null: an event with no correlation
 * id breaks the chain for every event published downstream of it, and the publisher who omitted
 * it is rarely the person who later needs the trace.
 */
export function buildEvent<TPayload>(
  input: BuildEventInput<TPayload>,
  options: { newId?: () => string; now?: () => Date } = {},
): EventEnvelope<TPayload> {
  const newId = options.newId ?? (() => `evt_${randomUUID()}`);
  const now = options.now ?? (() => new Date());
  const id = newId();

  return {
    id,
    name: input.name,
    version: input.version ?? '1',
    organizationId: input.organizationId,
    actor: input.actor,
    aggregate: input.aggregate ?? null,
    // The event id by default: redelivery of the same event is then idempotent without the
    // publisher doing anything.
    idempotencyKey: input.idempotencyKey ?? id,
    occurredAt: input.occurredAt ?? now(),
    metadata: {
      correlationId: input.correlationId ?? id,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      causationId: input.causationId ?? null,
      source: input.source,
      attributes: input.attributes ?? {},
    },
    payload: input.payload,
  };
}

/**
 * Derives a child envelope from a parent.
 *
 * The whole reason correlation and causation are separate fields. A handler that publishes in
 * response to an event calls this, and the chain stays intact: same `correlationId`, and
 * `causationId` pointing at the immediate parent — so the result is a tree rather than a flat
 * list of things that happened around the same time.
 */
export function deriveEvent<TPayload>(
  parent: EventEnvelope,
  input: Omit<BuildEventInput<TPayload>, 'correlationId' | 'causationId' | 'requestId' | 'traceId'>,
  options: { newId?: () => string; now?: () => Date } = {},
): EventEnvelope<TPayload> {
  return buildEvent(
    {
      ...input,
      correlationId: parent.metadata.correlationId,
      causationId: parent.id,
      requestId: parent.metadata.requestId,
      traceId: parent.metadata.traceId,
    },
    options,
  );
}

/** The ordering key: two events about the same aggregate are delivered in order. */
export function orderingKey(envelope: EventEnvelope): string | null {
  if (!envelope.aggregate) return null;
  // The organization is in the key so two tenants' events about identically-named aggregates do
  // not serialise against each other — which would make one tenant's throughput depend on
  // another's.
  return `${envelope.organizationId ?? 'platform'}:${envelope.aggregate.type}:${envelope.aggregate.id}`;
}

/**
 * The deduplication key a consumer should use.
 *
 * Scoped by subscriber, because "this subscriber has already handled this event" is the question
 * — and two subscribers must each get their own chance at it.
 */
export function deduplicationKey(envelope: EventEnvelope, subscriberId: string): string {
  return `${subscriberId}:${envelope.idempotencyKey}`;
}
