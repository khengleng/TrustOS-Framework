import { ApiError } from '@trustsystem/errors';
import { z } from 'zod';
import { eventNameSchema, type EventEnvelope } from '@trustsystem/event-sdk';

/**
 * The event schema registry.
 *
 * One rule: **an event whose schema is not registered is never published.** That sounds like
 * bureaucracy until the first time somebody renames a payload field and three consumers break in
 * production — the registry turns that into a validation failure at publish time, in the
 * publisher's own process, with the field name in the message.
 *
 * It also makes two other things possible that are otherwise guesswork:
 *
 *   * **A consumer can be written against a version.** `user.created` v1 and v2 are different
 *     contracts, and a subscriber can declare which it understands.
 *   * **The event surface is documentable.** `describeCatalog` is the list of everything this
 *     application publishes, generated rather than maintained — and a hand-maintained list of
 *     events is one that is wrong within a month.
 */

export const EVENT_STABILITY = ['experimental', 'stable', 'deprecated'] as const;
export type EventStability = (typeof EVENT_STABILITY)[number];

export interface EventSchemaDefinition<TPayload = unknown> {
  name: string;
  version: string;
  /** What happened, in a sentence. Rendered in the catalog and in the CLI. */
  description: string;
  /** Validates the payload. A caller supplies a zod schema; the registry never invents one. */
  payload: z.ZodType<TPayload>;
  stability?: EventStability;
  /**
   * The version that replaces this one.
   *
   * Set when deprecating, so a publisher on the old version is told what to move to rather than
   * only that they are behind.
   */
  supersededBy?: string;
  /** The aggregate type this event is about, when it has one. Documentation only. */
  aggregateType?: string;
  /** Example payload, for the catalog. Validated on registration — a wrong example is worse than none. */
  example?: TPayload;
}

interface RegisteredSchema extends EventSchemaDefinition {
  stability: EventStability;
  registeredAt: Date;
}

function key(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * The registry.
 *
 * Registration is at start-up, from code, rather than from a database. That is deliberate: a
 * schema loaded at runtime is a schema that can differ between two instances of the same
 * application, and "which of my three pods validates this event" is not a question anybody
 * should have to ask.
 */
export class EventRegistry {
  private readonly schemas = new Map<string, RegisteredSchema>();
  /** Latest version per name, so a publisher can omit it. */
  private readonly latest = new Map<string, string>();

  constructor(definitions: EventSchemaDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  /**
   * Registers a schema.
   *
   * Re-registering the same name and version throws rather than overwriting. Two modules that
   * both define `user.created` v1 with different payloads is a real conflict, and last-write-wins
   * would make which one applies depend on import order.
   */
  register<TPayload>(definition: EventSchemaDefinition<TPayload>): this {
    const nameResult = eventNameSchema.safeParse(definition.name);
    if (!nameResult.success) {
      throw ApiError.validation(
        [{ path: 'name', message: nameResult.error.issues[0]?.message ?? 'Invalid event name.' }],
        `"${definition.name}" is not a valid event name.`,
      );
    }

    if (!/^\d+$/.test(definition.version)) {
      throw ApiError.validation(
        [{ path: 'version', message: 'An event version is a whole number as a string: "1", "2".' }],
        `"${definition.version}" is not a valid event version.`,
      );
    }

    const id = key(definition.name, definition.version);

    if (this.schemas.has(id)) {
      throw ApiError.conflict(
        `The event schema ${id} is already registered. Two definitions of one event version ` +
          'would make which applies depend on import order.',
        { reason: 'event_schema_conflict', event: id },
      );
    }

    /*
     * The example is validated against its own schema.
     *
     * An example that does not parse is worse than no example: it is copied into a consumer,
     * which then fails at publish time against a payload the documentation said was correct.
     */
    if (definition.example !== undefined) {
      const parsed = definition.payload.safeParse(definition.example);
      if (!parsed.success) {
        throw ApiError.validation(
          parsed.error.issues.map((issue) => ({
            path: `example.${issue.path.join('.')}`,
            message: issue.message,
          })),
          `The example payload for ${id} does not satisfy its own schema.`,
        );
      }
    }

    this.schemas.set(id, {
      ...(definition as EventSchemaDefinition),
      stability: definition.stability ?? 'stable',
      registeredAt: new Date(),
    });

    const current = this.latest.get(definition.name);
    if (current === undefined || Number(definition.version) > Number(current)) {
      this.latest.set(definition.name, definition.version);
    }

    return this;
  }

  registerAll(definitions: EventSchemaDefinition[]): this {
    for (const definition of definitions) this.register(definition);
    return this;
  }

  has(name: string, version?: string): boolean {
    const resolved = version ?? this.latest.get(name);
    if (!resolved) return false;
    return this.schemas.has(key(name, resolved));
  }

  /** The latest registered version of an event, or null when it is unknown. */
  latestVersion(name: string): string | null {
    return this.latest.get(name) ?? null;
  }

  /**
   * Resolves a schema, or explains what is available.
   *
   * The message lists the registered versions, because "unknown event" with no further detail
   * sends somebody to grep for a name they have already spelled correctly — the usual cause is a
   * version mismatch, not a typo.
   */
  get(name: string, version: string): RegisteredSchema {
    const found = this.schemas.get(key(name, version));
    if (found) return found;

    const versions = [...this.schemas.values()]
      .filter((schema) => schema.name === name)
      .map((schema) => schema.version)
      .sort();

    if (versions.length === 0) {
      throw ApiError.validation(
        [
          {
            path: 'name',
            message:
              `No schema is registered for "${name}". An event whose schema is not registered ` +
              'is never published — register it at start-up.',
            code: 'event_schema_unknown',
          },
        ],
        `Unknown event "${name}".`,
      );
    }

    throw ApiError.validation(
      [
        {
          path: 'version',
          message: `Version ${version} of "${name}" is not registered. Registered: ${versions.join(', ')}.`,
          code: 'event_version_unknown',
        },
      ],
      `Unknown version of "${name}".`,
    );
  }

  /**
   * Validates an envelope's payload against its registered schema.
   *
   * Returns the *parsed* payload, so defaults and coercions apply — a consumer then receives what
   * the schema promised rather than what the publisher happened to send.
   */
  validate(envelope: EventEnvelope): EventEnvelope {
    const schema = this.get(envelope.name, envelope.version);
    const parsed = schema.payload.safeParse(envelope.payload);

    if (!parsed.success) {
      throw ApiError.validation(
        parsed.error.issues.map((issue) => ({
          path: `payload.${issue.path.join('.')}`,
          message: issue.message,
          code: 'event_payload_invalid',
        })),
        `The payload for ${envelope.name}@${envelope.version} does not match its schema.`,
      );
    }

    return { ...envelope, payload: parsed.data };
  }

  /**
   * Warnings a publisher should see but that do not block.
   *
   * Deprecation is a warning rather than an error, deliberately. Refusing a deprecated event
   * would break a running consumer at the moment somebody marked it deprecated — which is
   * exactly when nothing should break. The warning goes to the log and to the catalog; the
   * removal happens when the version is unregistered, which is a deliberate act.
   */
  warningsFor(envelope: EventEnvelope): string[] {
    const schema = this.schemas.get(key(envelope.name, envelope.version));
    if (!schema) return [];

    const warnings: string[] = [];

    if (schema.stability === 'deprecated') {
      warnings.push(
        `${envelope.name}@${envelope.version} is deprecated` +
          (schema.supersededBy ? `; use version ${schema.supersededBy}` : '') +
          '.',
      );
    }

    if (schema.stability === 'experimental') {
      warnings.push(
        `${envelope.name}@${envelope.version} is experimental and may change without a version bump.`,
      );
    }

    const latest = this.latest.get(envelope.name);
    if (latest && latest !== envelope.version && schema.stability !== 'deprecated') {
      warnings.push(`A newer version of ${envelope.name} exists: ${latest}.`);
    }

    return warnings;
  }

  /**
   * The catalog.
   *
   * Generated rather than maintained — a hand-written list of an application's events is one that
   * is wrong within a month. Rendered by `trustos doctor integrations` and by the docs.
   */
  describeCatalog(): Array<{
    name: string;
    version: string;
    description: string;
    stability: EventStability;
    aggregateType: string | null;
    supersededBy: string | null;
    isLatest: boolean;
    example: unknown;
  }> {
    return [...this.schemas.values()]
      .map((schema) => ({
        name: schema.name,
        version: schema.version,
        description: schema.description,
        stability: schema.stability,
        aggregateType: schema.aggregateType ?? null,
        supersededBy: schema.supersededBy ?? null,
        isLatest: this.latest.get(schema.name) === schema.version,
        example: schema.example ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || Number(a.version) - Number(b.version));
  }

  /** Every registered name, deduplicated. For a subscription UI. */
  names(): string[] {
    return [...new Set([...this.schemas.values()].map((schema) => schema.name))].sort();
  }

  get size(): number {
    return this.schemas.size;
  }

  /**
   * Removes a version.
   *
   * The deliberate act that actually breaks a consumer, which is why it is separate from
   * deprecation and why nothing calls it automatically. Present so a long-lived application can
   * eventually retire a version rather than carrying every schema it has ever had.
   */
  unregister(name: string, version: string): boolean {
    const removed = this.schemas.delete(key(name, version));

    if (removed && this.latest.get(name) === version) {
      const remaining = [...this.schemas.values()]
        .filter((schema) => schema.name === name)
        .map((schema) => schema.version)
        .sort((a, b) => Number(b) - Number(a));

      if (remaining[0]) this.latest.set(name, remaining[0]);
      else this.latest.delete(name);
    }

    return removed;
  }
}

/**
 * Reports conflicts between two registries before merging them.
 *
 * A module contributes its own schemas, and two modules that both define `document.uploaded`
 * with different payloads is a real conflict that should surface at start-up rather than at the
 * first publish. `register` throws on a duplicate; this lets a composition root find every
 * conflict at once instead of one per restart.
 */
export function findSchemaConflicts(
  registries: Array<{ source: string; definitions: EventSchemaDefinition[] }>,
): Array<{ event: string; sources: string[] }> {
  const seen = new Map<string, string[]>();

  for (const { source, definitions } of registries) {
    for (const definition of definitions) {
      const id = key(definition.name, definition.version);
      const sources = seen.get(id) ?? [];
      sources.push(source);
      seen.set(id, sources);
    }
  }

  return [...seen.entries()]
    .filter(([, sources]) => sources.length > 1)
    .map(([event, sources]) => ({ event, sources }));
}
