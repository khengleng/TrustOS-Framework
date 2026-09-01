import { z } from 'zod';
import type { MetricsRecorder } from '@trustsystem/observability';

/**
 * AI observability.
 *
 * What the platform did, in numbers: requests, latency, failures, retries, provider health,
 * tokens, cost, cache hit rate, which agents and prompts are actually used.
 *
 * **Metadata only, never content.** No prompt text, no completion text, no tool arguments. An
 * observability store is queried by more people than any other store in a system, is exported to
 * dashboards, and is retained for longer than anybody intends — putting a customer's message in it
 * is the widest data exposure available for the least benefit. The conversation store holds the
 * text, behind the tenant checks that belong to it.
 *
 * **Percentiles over a bounded window.** The store keeps the most recent N records per tenant and
 * computes exactly over those. It says so in the report (`sampleSize`, `windowStart`), because a
 * "p95 latency" computed over an unstated window is a number people make capacity decisions with.
 *
 * **Provider health is recent failures, not a probe.** Nothing here calls a provider to check
 * whether it is up. A health signal derived from real traffic reflects what users experienced; a
 * synthetic probe reflects whether one endpoint answered one request.
 */

export const AI_OUTCOMES = [
  'success',
  /** The provider failed after retries. */
  'provider_error',
  /** A guardrail refused the input or the output. */
  'guardrail_blocked',
  /** Tenant policy refused. */
  'policy_denied',
  /** Over budget. */
  'budget_exceeded',
  /** The output did not match the requested schema. */
  'schema_mismatch',
  'cancelled',
] as const;
export type AiOutcome = (typeof AI_OUTCOMES)[number];

export const aiRequestRecordSchema = z
  .object({
    id: z.string(),
    at: z.coerce.date(),

    organizationId: z.string().nullable(),
    /** Which application asked. For per-application attribution. */
    application: z.string().max(120).default('unknown'),

    modelId: z.string().max(120),
    provider: z.string().max(60),
    /** Set when the first-choice model was unavailable and the router fell back. */
    fallbackFrom: z.string().max(120).nullable().default(null),

    agentId: z.string().max(120).nullable().default(null),
    promptId: z.string().max(120).nullable().default(null),
    promptVersion: z.string().max(40).nullable().default(null),

    outcome: z.enum(AI_OUTCOMES),
    /** Why it failed, when it did. A short reason code, never a message with content in it. */
    reason: z.string().max(120).nullable().default(null),

    latencyMs: z.number().int().min(0),
    /** Attempts including the first. More than one means something failed and was retried. */
    attempts: z.number().int().min(1).default(1),
    cached: z.boolean().default(false),

    promptTokens: z.number().int().min(0).default(0),
    completionTokens: z.number().int().min(0).default(0),
    totalTokens: z.number().int().min(0).default(0),
    costCents: z.number().min(0).default(0),
    /** Whether the usage numbers were measured or estimated. */
    estimated: z.boolean().default(false),
  })
  .strict();

export type AiRequestRecord = z.infer<typeof aiRequestRecordSchema>;

export interface TelemetryStore {
  record(entry: AiRequestRecord): Promise<void>;
  query(input: {
    organizationId: string | null;
    since?: Date;
    until?: Date;
    agentId?: string;
    modelId?: string;
    provider?: string;
    application?: string;
    limit?: number;
  }): Promise<AiRequestRecord[]>;
}

export interface UsageBreakdown {
  key: string;
  requests: number;
  failures: number;
  totalTokens: number;
  costCents: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export interface ProviderHealth {
  provider: string;
  requests: number;
  failures: number;
  /** Failures over requests, in the window. */
  failureRate: number;
  p95LatencyMs: number;
  /** How many requests were routed away from this provider to another. */
  fallbacksAway: number;
  status: 'healthy' | 'degraded' | 'failing' | 'unknown';
}

export interface AiReport {
  organizationId: string | null;
  windowStart: Date | null;
  windowEnd: Date | null;
  /** How many records the numbers are computed from. Stated because it bounds their meaning. */
  sampleSize: number;

  requests: number;
  failures: number;
  failureRate: number;
  /** Requests that needed more than one attempt. A leading indicator of provider trouble. */
  retried: number;

  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;

  totalTokens: number;
  costCents: number;
  /** The fraction of cost derived from estimated usage rather than provider numbers. */
  estimatedCostFraction: number;

  cacheHits: number;
  cacheHitRate: number;
  /** Cost avoided by cache hits, using the mean cost of an uncached request. Approximate. */
  cacheSavedCents: number;

  byOutcome: Record<string, number>;
  byModel: UsageBreakdown[];
  byAgent: UsageBreakdown[];
  byApplication: UsageBreakdown[];
  byPrompt: UsageBreakdown[];
  providers: ProviderHealth[];
}

export interface TelemetryOptions {
  store: TelemetryStore;
  metrics?: MetricsRecorder;
  /** Failure rate above which a provider is `degraded`. */
  degradedFailureRate?: number;
  /** Failure rate above which it is `failing`. */
  failingFailureRate?: number;
  /** Requests needed before a rate is meaningful. Below it a provider is `unknown`. */
  minSamplesForHealth?: number;
  now?: () => Date;
}

export const AI_METRICS = {
  REQUESTS: 'ai.requests',
  FAILURES: 'ai.failures',
  LATENCY_MS: 'ai.latency_ms',
  TOKENS: 'ai.tokens',
  COST_CENTS: 'ai.cost_cents',
  CACHE_HITS: 'ai.cache.hits',
  RETRIES: 'ai.retries',
  FALLBACKS: 'ai.fallbacks',
} as const;

export class AiTelemetry {
  private readonly now: () => Date;

  constructor(private readonly options: TelemetryOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Records one request.
   *
   * Never throws. Telemetry that can fail a request is worse than telemetry that has a gap: a
   * dashboard with a hole is a nuisance, and a failed customer request because the metrics store
   * was down is an outage caused by the thing watching for outages.
   */
  async record(input: unknown): Promise<void> {
    let entry: AiRequestRecord;

    try {
      entry = aiRequestRecordSchema.parse(input);
    } catch {
      return;
    }

    const labels = {
      model: entry.modelId,
      provider: entry.provider,
      outcome: entry.outcome,
      ...(entry.agentId ? { agent: entry.agentId } : {}),
    };

    try {
      this.options.metrics?.increment(AI_METRICS.REQUESTS, 1, labels);
      this.options.metrics?.observe(AI_METRICS.LATENCY_MS, entry.latencyMs, labels);
      this.options.metrics?.increment(AI_METRICS.TOKENS, entry.totalTokens, labels);
      this.options.metrics?.increment(AI_METRICS.COST_CENTS, entry.costCents, labels);

      if (entry.outcome !== 'success') {
        this.options.metrics?.increment(AI_METRICS.FAILURES, 1, labels);
      }
      if (entry.cached) this.options.metrics?.increment(AI_METRICS.CACHE_HITS, 1, labels);
      if (entry.attempts > 1) {
        this.options.metrics?.increment(AI_METRICS.RETRIES, entry.attempts - 1, labels);
      }
      if (entry.fallbackFrom) {
        this.options.metrics?.increment(AI_METRICS.FALLBACKS, 1, {
          from: entry.fallbackFrom,
          to: entry.modelId,
        });
      }

      await this.options.store.record(entry);
    } catch {
      // Deliberately swallowed. See the doc comment.
    }
  }

  /** The dashboard. */
  async report(input: {
    organizationId: string | null;
    since?: Date;
    until?: Date;
    limit?: number;
  }): Promise<AiReport> {
    const records = await this.options.store.query({
      organizationId: input.organizationId,
      since: input.since,
      until: input.until,
      limit: input.limit ?? 10_000,
    });

    return this.summarise(input.organizationId, records);
  }

  /** Provider health on its own, for `trustos ai doctor`. */
  async providerHealth(input: {
    organizationId: string | null;
    since?: Date;
  }): Promise<ProviderHealth[]> {
    return (await this.report(input)).providers;
  }

  private summarise(organizationId: string | null, records: AiRequestRecord[]): AiReport {
    if (records.length === 0) {
      return {
        organizationId,
        windowStart: null,
        windowEnd: null,
        sampleSize: 0,
        requests: 0,
        failures: 0,
        failureRate: 0,
        retried: 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        p99LatencyMs: 0,
        totalTokens: 0,
        costCents: 0,
        estimatedCostFraction: 0,
        cacheHits: 0,
        cacheHitRate: 0,
        cacheSavedCents: 0,
        byOutcome: {},
        byModel: [],
        byAgent: [],
        byApplication: [],
        byPrompt: [],
        providers: [],
      };
    }

    const times = records.map((record) => record.at.getTime());
    const latencies = records.map((record) => record.latencyMs);
    const failures = records.filter((record) => record.outcome !== 'success');
    const cached = records.filter((record) => record.cached);
    const uncached = records.filter((record) => !record.cached);

    const costCents = records.reduce((total, record) => total + record.costCents, 0);
    const estimatedCost = records
      .filter((record) => record.estimated)
      .reduce((total, record) => total + record.costCents, 0);

    // Mean cost of an actual provider call, applied to the hits. Approximate and labelled as such:
    // the true saving depends on which requests were cached, which is not knowable after the fact.
    const meanUncachedCost =
      uncached.length > 0
        ? uncached.reduce((total, record) => total + record.costCents, 0) / uncached.length
        : 0;

    const byOutcome: Record<string, number> = {};
    for (const record of records) {
      byOutcome[record.outcome] = (byOutcome[record.outcome] ?? 0) + 1;
    }

    return {
      organizationId,
      windowStart: new Date(Math.min(...times)),
      windowEnd: new Date(Math.max(...times)),
      sampleSize: records.length,

      requests: records.length,
      failures: failures.length,
      failureRate: round(failures.length / records.length),
      retried: records.filter((record) => record.attempts > 1).length,

      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      p99LatencyMs: percentile(latencies, 99),

      totalTokens: records.reduce((total, record) => total + record.totalTokens, 0),
      costCents: round(costCents, 4),
      estimatedCostFraction: costCents > 0 ? round(estimatedCost / costCents) : 0,

      cacheHits: cached.length,
      cacheHitRate: round(cached.length / records.length),
      cacheSavedCents: round(cached.length * meanUncachedCost, 4),

      byOutcome,
      byModel: breakdown(records, (record) => record.modelId),
      byAgent: breakdown(records, (record) => record.agentId),
      byApplication: breakdown(records, (record) => record.application),
      byPrompt: breakdown(records, (record) =>
        record.promptId ? `${record.promptId}@${record.promptVersion ?? '?'}` : null,
      ),
      providers: this.providers(records),
    };
  }

  private providers(records: AiRequestRecord[]): ProviderHealth[] {
    const degraded = this.options.degradedFailureRate ?? 0.05;
    const failing = this.options.failingFailureRate ?? 0.25;
    const minSamples = this.options.minSamplesForHealth ?? 10;

    const names = [...new Set(records.map((record) => record.provider))].sort();

    return names.map((provider) => {
      const own = records.filter((record) => record.provider === provider);
      const failed = own.filter((record) => record.outcome !== 'success');
      const rate = failed.length / own.length;

      return {
        provider,
        requests: own.length,
        failures: failed.length,
        failureRate: round(rate),
        p95LatencyMs: percentile(
          own.map((record) => record.latencyMs),
          95,
        ),
        // Requests that started here and were served elsewhere. The clearest signal that the
        // router is working around this provider.
        fallbacksAway: records.filter((record) => record.fallbackFrom?.startsWith(provider)).length,
        status:
          // Below the sample floor a rate is noise: one failure in three requests is 33%, and
          // reporting that as "failing" makes the dashboard cry wolf.
          own.length < minSamples
            ? 'unknown'
            : rate >= failing
              ? 'failing'
              : rate >= degraded
                ? 'degraded'
                : 'healthy',
      };
    });
  }
}

/**
 * Nearest-rank percentile.
 *
 * Exact over the records given, which is the honest choice for a bounded window — an interpolated
 * percentile over a sample is a smoother-looking number with no more information in it.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);

  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))]!;
}

function round(value: number, places = 4): number {
  return Number(value.toFixed(places));
}

function breakdown(
  records: AiRequestRecord[],
  key: (record: AiRequestRecord) => string | null,
): UsageBreakdown[] {
  const groups = new Map<string, AiRequestRecord[]>();

  for (const record of records) {
    const name = key(record);
    // Null means "not applicable to this request" — a completion with no agent is not an agent
    // called "unknown", and counting it as one makes the busiest agent a fiction.
    if (name === null) continue;

    const existing = groups.get(name) ?? [];
    existing.push(record);
    groups.set(name, existing);
  }

  return (
    [...groups.entries()]
      .map(([name, own]) => ({
        key: name,
        requests: own.length,
        failures: own.filter((record) => record.outcome !== 'success').length,
        totalTokens: own.reduce((total, record) => total + record.totalTokens, 0),
        costCents: round(
          own.reduce((total, record) => total + record.costCents, 0),
          4,
        ),
        p50LatencyMs: percentile(
          own.map((record) => record.latencyMs),
          50,
        ),
        p95LatencyMs: percentile(
          own.map((record) => record.latencyMs),
          95,
        ),
      }))
      // Most expensive first: the question a cost dashboard is opened to answer.
      .sort(
        (a, b) =>
          b.costCents - a.costCents || b.requests - a.requests || a.key.localeCompare(b.key),
      )
  );
}
