import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import type { ServiceRegistry } from '@trustos/sre-core';

/**
 * Service level indicators.
 *
 * An SLI is a ratio: **good events over valid events**. Everything here follows from insisting on
 * that shape rather than accepting an average.
 *
 * Averages are the standard way a measurement stops being true. "Average latency 180ms" is
 * compatible with one request in twenty taking nine seconds, and the users who experience those
 * nine seconds are exactly the ones who complain. A ratio of requests-under-threshold to
 * requests-served cannot hide them.
 *
 * Two consequences are enforced rather than recommended:
 *
 * **A window with no valid events has no value.** Not 100%, not 0% — `null`. A service nobody
 * called at 4am was not perfectly available; it was unmeasured. Reporting 100% there is how an
 * objective is met by an outage that stopped all traffic.
 *
 * **Bad events cannot exceed valid ones.** A counter that reports more failures than requests is
 * broken, and a broken counter that silently clamps produces a number somebody will act on.
 */

export const SLI_KINDS = [
  'availability',
  'latency',
  'error_rate',
  'throughput',
  'queue_delay',
  'workflow_completion',
  'ai_response_success',
  'payment_processing_success',
] as const;
export type SliKind = (typeof SLI_KINDS)[number];

/**
 * Whether a higher measured ratio is better.
 *
 * `error_rate` is the odd one: its ratio counts *bad* events, so an objective on it is an upper
 * bound. Encoding the direction here keeps every comparison in `@trustos/slo` from having to
 * special-case it, which is where a sign error would hide.
 */
export const SLI_DIRECTION: Record<SliKind, 'higher_is_better' | 'lower_is_better'> = {
  availability: 'higher_is_better',
  latency: 'higher_is_better',
  error_rate: 'lower_is_better',
  throughput: 'higher_is_better',
  queue_delay: 'higher_is_better',
  workflow_completion: 'higher_is_better',
  ai_response_success: 'higher_is_better',
  payment_processing_success: 'higher_is_better',
};

export const sliDefinitionSchema = z
  .object({
    sliId: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/, 'Lowercase dotted or dashed identifier.'),
    serviceId: z.string().min(3).max(64),
    kind: z.enum(SLI_KINDS),
    name: z.string().min(3).max(120),
    /**
     * What counts as a *good* event, in words. Required, because the definition is the part that
     * gets argued about during an incident and the part nobody wrote down.
     */
    goodEventDefinition: z.string().min(15).max(500),
    /** What counts as a *valid* event — the denominator, and what it deliberately excludes. */
    validEventDefinition: z.string().min(15).max(500),
    /** For latency indicators: the millisecond threshold under which a request is good. */
    thresholdMs: z.number().int().positive().max(600_000).nullable().default(null),
    /** Where the numbers come from, so a disputed value can be traced. */
    source: z.string().min(3).max(200),
    unit: z.enum(['ratio', 'milliseconds', 'count']).default('ratio'),
    organizationId: z.string().min(1).max(64).nullable().default(null),
  })
  .strict()
  .superRefine((definition, ctx) => {
    if (definition.kind === 'latency' && definition.thresholdMs === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thresholdMs'],
        message:
          'A latency indicator states the threshold a request must beat. Without one it is an average.',
      });
    }
  });

export type SliDefinition = z.infer<typeof sliDefinitionSchema>;

/**
 * One measurement bucket.
 *
 * Counts, not percentages. Percentages cannot be re-aggregated: averaging the hourly percentages
 * of a day weights a quiet hour the same as a busy one, so a night-time blip outweighs a
 * lunchtime one. Counts sum correctly.
 */
export const sliMeasurementSchema = z
  .object({
    sliId: z.string().min(3).max(64),
    windowStart: z.string().datetime(),
    windowEnd: z.string().datetime(),
    goodEvents: z.number().int().nonnegative(),
    validEvents: z.number().int().nonnegative(),
    /** Minutes inside an approved maintenance window, already removed from the counts above. */
    excludedEvents: z.number().int().nonnegative().default(0),
  })
  .strict()
  .superRefine((measurement, ctx) => {
    if (measurement.goodEvents > measurement.validEvents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['goodEvents'],
        message:
          'More good events than valid ones. The counter is wrong, and clamping it would produce a number somebody acts on.',
      });
    }
    if (Date.parse(measurement.windowEnd) <= Date.parse(measurement.windowStart)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['windowEnd'],
        message: 'A measurement window ends after it starts.',
      });
    }
  });

export type SliMeasurement = z.infer<typeof sliMeasurementSchema>;

export interface SliValue {
  readonly sliId: string;
  /** Good over valid, in the range 0..1. Null when nothing valid was observed. */
  readonly ratio: number | null;
  /** The same, as a percentage to four decimal places — the form objectives are written in. */
  readonly percentage: number | null;
  readonly goodEvents: number;
  readonly validEvents: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  /**
   * Why a null ratio is null. `no_valid_events` is the honest state of an unobserved window and
   * is deliberately not 100%.
   */
  readonly unmeasuredReason: 'no_valid_events' | null;
}

/**
 * Aggregate measurements into one value.
 *
 * Sums the counts and divides once. The buckets need not be contiguous or equal in length; that
 * is the property counts have and percentages do not.
 */
export function aggregate(measurements: readonly SliMeasurement[]): SliValue {
  if (measurements.length === 0) {
    throw ApiError.validation(
      [{ path: 'measurements', message: 'Aggregating no measurements has no defined answer.' }],
      'Aggregating no measurements has no defined answer.',
    );
  }

  const sliId = measurements[0]?.sliId as string;
  if (measurements.some((measurement) => measurement.sliId !== sliId)) {
    throw ApiError.validation(
      [
        {
          path: 'measurements',
          message: 'Measurements from different indicators do not aggregate.',
        },
      ],
      'Measurements from different indicators do not aggregate.',
    );
  }

  const goodEvents = measurements.reduce((total, m) => total + m.goodEvents, 0);
  const validEvents = measurements.reduce((total, m) => total + m.validEvents, 0);

  const starts = measurements.map((m) => Date.parse(m.windowStart));
  const ends = measurements.map((m) => Date.parse(m.windowEnd));

  const ratio = validEvents === 0 ? null : goodEvents / validEvents;

  return {
    sliId,
    ratio,
    percentage: ratio === null ? null : Number((ratio * 100).toFixed(4)),
    goodEvents,
    validEvents,
    windowStart: new Date(Math.min(...starts)).toISOString(),
    windowEnd: new Date(Math.max(...ends)).toISOString(),
    unmeasuredReason: validEvents === 0 ? 'no_valid_events' : null,
  };
}

/**
 * Drop the buckets that fall inside an approved maintenance window.
 *
 * Done here rather than at measurement time so the raw counts stay intact and the exclusion can be
 * audited: the same measurements produce a different SLI depending on which windows were approved,
 * and that dependency should be visible.
 */
export function excludeMaintenance(
  measurements: readonly SliMeasurement[],
  input: { serviceId: string; registry: Pick<ServiceRegistry, 'inMaintenance'> },
): SliMeasurement[] {
  return measurements.filter(
    (measurement) =>
      input.registry.inMaintenance(input.serviceId, new Date(measurement.windowStart)) === null,
  );
}

/**
 * Whether a value may be reported against an objective at all.
 *
 * The specification's instruction — *do not claim compliance unless actual metrics support it* —
 * expressed as a function. A window thin enough that one request swings it by more than the
 * objective's own tolerance cannot confirm or deny compliance, so it reports as insufficient
 * rather than as a pass.
 */
export function sufficientToJudge(
  value: SliValue,
  input: { objectivePercentage: number; minimumEvents?: number },
): { sufficient: boolean; reason: string | null } {
  const minimum = input.minimumEvents ?? 0;

  if (value.validEvents === 0) {
    return { sufficient: false, reason: 'Nothing valid was observed in this window.' };
  }

  if (value.validEvents < minimum) {
    return {
      sufficient: false,
      reason: `${value.validEvents} valid events is below the ${minimum} this indicator needs.`,
    };
  }

  const allowedFailureFraction = (100 - input.objectivePercentage) / 100;
  const oneEvent = 1 / value.validEvents;

  if (allowedFailureFraction > 0 && oneEvent > allowedFailureFraction) {
    return {
      sufficient: false,
      reason:
        `A single event moves this indicator by ${(oneEvent * 100).toFixed(4)}%, which exceeds the ` +
        `${(allowedFailureFraction * 100).toFixed(4)}% the objective allows in total. ` +
        'The window is too thin to judge compliance.',
    };
  }

  return { sufficient: true, reason: null };
}

/** A registry of definitions, so a measurement arriving for an unknown indicator is caught. */
export class SliRegistry {
  private readonly definitions = new Map<string, SliDefinition>();

  constructor(definitions: readonly SliDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: SliDefinition): void {
    if (this.definitions.has(definition.sliId)) {
      throw ApiError.conflict(`Indicator ${definition.sliId} is already defined.`);
    }
    this.definitions.set(definition.sliId, definition);
  }

  get(sliId: string): SliDefinition | null {
    return this.definitions.get(sliId) ?? null;
  }

  require(sliId: string): SliDefinition {
    const definition = this.get(sliId);
    if (!definition) throw ApiError.notFound(`Indicator ${sliId} is not defined.`);
    return definition;
  }

  forService(serviceId: string): SliDefinition[] {
    return [...this.definitions.values()].filter(
      (definition) => definition.serviceId === serviceId,
    );
  }

  /** Aggregate, having first checked the indicator exists and the counts belong to it. */
  valueOf(sliId: string, measurements: readonly SliMeasurement[]): SliValue {
    this.require(sliId);
    return aggregate(measurements.filter((measurement) => measurement.sliId === sliId));
  }
}
