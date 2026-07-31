import { z } from 'zod';
import { createHash } from 'node:crypto';

/**
 * Telemetry.
 *
 * The framework's position, which is stronger than "respects privacy" and is enforced by the code
 * rather than promised in a policy:
 *
 * **Off unless switched on.** No implied consent, no opt-out-after-the-fact, no "anonymous usage
 * statistics" enabled by a default nobody read. `TelemetryCollector` with no explicit `enabled`
 * records nothing.
 *
 * **Local-first, and there is no default destination.** Events accumulate in a local sink. Sending
 * them anywhere requires a deployment to supply an exporter — the framework ships none and has no
 * endpoint. A framework with a hardcoded telemetry URL is a framework that phones home, whatever
 * its documentation says.
 *
 * **Tenant data cannot be recorded, structurally.** An event carries a name, a bounded set of
 * low-cardinality dimensions, and numbers. It has no free-text field, so there is nowhere for a
 * customer name to go. `assertNoIdentifiers` additionally refuses values that look like
 * identifiers, because the interesting failure is not malice but somebody putting an order id in
 * a dimension to make a dashboard more useful.
 *
 * Identifiers that must be counted — how many distinct organizations used a feature — are hashed
 * with a per-installation salt that never leaves the installation. That counts without
 * identifying, and it cannot be reversed by whoever receives the export.
 */

export const TELEMETRY_CATEGORIES = [
  'framework',
  'module',
  'cli',
  'template',
  'ai',
  'performance',
  'error',
  'feature',
] as const;

export type TelemetryCategory = (typeof TELEMETRY_CATEGORIES)[number];

/**
 * Dimension values are constrained on purpose.
 *
 * Lowercase, bounded, no spaces. A dimension that accepts arbitrary text is a dimension somebody
 * eventually puts a customer name in — usually while debugging, usually meaning to take it out.
 */
const dimensionValueSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/, 'Lowercase, no spaces; this is a label, not a message.');

export const telemetryEventSchema = z
  .object({
    category: z.enum(TELEMETRY_CATEGORIES),
    /** Dotted event name, e.g. `cli.command.run`. */
    name: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/, 'Dotted lowercase name.'),
    dimensions: z.record(dimensionValueSchema).default({}),
    /** Numbers only. A measurement with a unit in its name, e.g. `durationMs`. */
    measurements: z.record(z.number().finite()).default({}),
    occurredAt: z.string().min(10).max(40),
  })
  .strict();

export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

/**
 * Values that look like identifiers, refused in dimensions.
 *
 * Catches the honest mistake, not the determined one. Somebody who wants to exfiltrate data can
 * encode it — but nobody accidentally base64s a customer name into a dimension, and everybody
 * accidentally puts an order id in one.
 */
const IDENTIFIER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^[a-z0-9]{20,}$/i, label: 'an opaque id' },
  { pattern: /^c[a-z0-9]{24}$/i, label: 'a cuid' },
  { pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, label: 'a uuid' },
  { pattern: /@/, label: 'an email address' },
  { pattern: /^\+?\d[\d\s().-]{7,}$/, label: 'a phone number' },
];

export function assertNoIdentifiers(dimensions: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(dimensions)) {
    for (const { pattern, label } of IDENTIFIER_PATTERNS) {
      if (pattern.test(value)) {
        throw new Error(
          `Telemetry dimension "${key}" looks like ${label}. Dimensions are labels with few ` +
            'distinct values — a count of organizations goes through hashIdentifier, which counts ' +
            'without identifying.',
        );
      }
    }
  }
}

export interface TelemetrySink {
  write(event: TelemetryEvent): void;
}

/** The default sink: an array in memory. Nothing leaves the process unless an exporter is wired. */
export class InMemoryTelemetrySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];

  constructor(private readonly limit = 10_000) {}

  write(event: TelemetryEvent): void {
    this.events.push(event);

    // Bounded, so a long-running process cannot accumulate telemetry until it runs out of memory.
    // Oldest first: recent events are the ones anybody looks at.
    if (this.events.length > this.limit) this.events.shift();
  }
}

export interface TelemetryOptions {
  /**
   * Required, with no default.
   *
   * Not `enabled = false` as a default value but an explicit decision at every construction site,
   * so enabling telemetry is always visible in a diff.
   */
  enabled: boolean;
  sink?: TelemetrySink;
  /** Per-installation salt for `hashIdentifier`. Never exported, never logged. */
  salt?: string;
  now?: () => Date;
  /** Categories to record. Absent means all of them. */
  categories?: readonly TelemetryCategory[];
}

export class TelemetryCollector {
  private readonly sink: TelemetrySink;
  private readonly now: () => Date;
  private readonly salt: string;

  constructor(private readonly options: TelemetryOptions) {
    this.sink = options.sink ?? new InMemoryTelemetrySink();
    this.now = options.now ?? (() => new Date());
    this.salt = options.salt ?? '';
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /**
   * Records an event, or does nothing.
   *
   * Silently, when disabled. A collector that threw when switched off would push every caller into
   * writing `if (telemetry.enabled)`, and the one that forgot would crash a production path over
   * a metric.
   */
  record(input: {
    category: TelemetryCategory;
    name: string;
    dimensions?: Record<string, string>;
    measurements?: Record<string, number>;
  }): TelemetryEvent | null {
    if (!this.options.enabled) return null;
    if (this.options.categories && !this.options.categories.includes(input.category)) return null;

    const dimensions = input.dimensions ?? {};
    assertNoIdentifiers(dimensions);

    const event = telemetryEventSchema.parse({
      category: input.category,
      name: input.name,
      dimensions,
      measurements: input.measurements ?? {},
      occurredAt: this.now().toISOString(),
    });

    this.sink.write(event);
    return event;
  }

  /**
   * A stable pseudonym for an identifier.
   *
   * Salted per installation, so the same organization hashes differently in two deployments and
   * cannot be correlated across them. Truncated to 16 hex characters: enough to count distinct
   * values, short enough that a rainbow table over a known population is not a lookup.
   *
   * Returns null when no salt is configured — an unsalted hash of a known identifier space is
   * reversible, and silently emitting one would be worse than emitting nothing.
   */
  hashIdentifier(value: string): string | null {
    if (!this.salt) return null;

    return createHash('sha256')
      .update(this.salt)
      .update('\0')
      .update(value)
      .digest('hex')
      .slice(0, 16);
  }

  /** Times an operation and records the duration. Returns whatever the operation returns. */
  async time<T>(
    input: { category: TelemetryCategory; name: string; dimensions?: Record<string, string> },
    operation: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();

    try {
      const result = await operation();

      this.record({
        ...input,
        dimensions: { ...input.dimensions, outcome: 'success' },
        measurements: { durationMs: Date.now() - started },
      });

      return result;
    } catch (error) {
      /*
       * The error's *type* is recorded, never its message. A message carries whatever the failing
       * operation was working on, which is exactly the tenant data this file exists to keep out.
       */
      this.record({
        ...input,
        dimensions: {
          ...input.dimensions,
          outcome: 'failure',
          error: errorLabel(error),
        },
        measurements: { durationMs: Date.now() - started },
      });

      throw error;
    }
  }
}

function errorLabel(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : 'unknown';
  return name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'unknown';
}

/**
 * What an export would contain, for a deployment to inspect before sending anything.
 *
 * The command behind `trustos telemetry review`. Nobody should have to read source to find out
 * what a framework would transmit.
 */
export function describeExport(events: readonly TelemetryEvent[]): {
  eventCount: number;
  categories: Record<string, number>;
  dimensionKeys: string[];
  measurementKeys: string[];
} {
  const categories: Record<string, number> = {};
  const dimensionKeys = new Set<string>();
  const measurementKeys = new Set<string>();

  for (const event of events) {
    categories[event.category] = (categories[event.category] ?? 0) + 1;
    for (const key of Object.keys(event.dimensions)) dimensionKeys.add(key);
    for (const key of Object.keys(event.measurements)) measurementKeys.add(key);
  }

  return {
    eventCount: events.length,
    categories,
    dimensionKeys: [...dimensionKeys].sort(),
    measurementKeys: [...measurementKeys].sort(),
  };
}
