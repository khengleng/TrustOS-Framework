import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@trustos/errors';
import type { LoggerPort } from '@trustos/logging';
import {
  citationCoverage,
  containsExpected,
  costScore,
  excludesForbidden,
  groundedness,
  latencyScore,
  metricResultSchema,
  relevance,
  safetyScore,
  schemaCompliance,
  type MetricResult,
} from './metrics';

/**
 * Evaluation suites.
 *
 * A suite is a list of cases and the thresholds each must meet. Running one produces a score per
 * metric per case, an aggregate, and — the part that earns its keep — a comparison against the
 * previous run.
 *
 * **The comparison is the product.** An absolute groundedness of 0.62 tells you very little. A
 * groundedness that dropped from 0.81 to 0.62 after somebody edited a prompt tells you what to do
 * next. So the run keeps history, `compare()` reports per-case movement, and a regression is
 * reported per case rather than as a shifted average — an average hides two cases getting much
 * worse behind three getting slightly better.
 *
 * **Thresholds are per metric and per case.** A suite with one global pass mark forces every case
 * to the strictness of the hardest one, which in practice means the mark gets lowered until
 * everything passes and the suite stops meaning anything.
 */

export const evaluationCaseSchema = z
  .object({
    id: z.string().min(1).max(120),
    /** What is being asked. */
    input: z.string().min(1).max(100_000),
    /** Retrieved context, when the case is a RAG one. */
    sources: z.array(z.string().max(100_000)).max(50).default([]),

    /** Strings the answer must contain. Blunt, and catches the change that matters. */
    expected: z.array(z.string().max(500)).max(50).default([]),
    /** Strings the answer must not contain. The more important half. */
    forbidden: z.array(z.string().max(500)).max(50).default([]),

    /** Per-metric pass marks for this case. Absent means the metric is reported, not enforced. */
    thresholds: z.record(z.number().min(0).max(1)).default({}),

    /** For slicing a report: `refunds`, `khmer`, `adversarial`. */
    tags: z.array(z.string().max(60)).max(20).default([]),
    /**
     * Why this case exists.
     *
     * Required. A case with no stated purpose gets deleted the first time it fails, because
     * nobody remembers whether it was testing something real.
     */
    note: z.string().min(1).max(1000),
  })
  .strict();

export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;

export const evaluationSuiteSchema = z
  .object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).default(''),
    /** What this suite evaluates: an agent id, a prompt key, an application feature. */
    subject: z.string().min(1).max(200),
    cases: z.array(evaluationCaseSchema).min(1).max(1000),

    /** Applied to any case that does not set its own. */
    defaultThresholds: z.record(z.number().min(0).max(1)).default({}),
    latencyBudgetMs: z.number().int().min(1).default(30_000),
    costBudgetCents: z.number().min(0).default(5),
  })
  .strict();

export type EvaluationSuite = z.infer<typeof evaluationSuiteSchema>;

export const caseResultSchema = z
  .object({
    caseId: z.string(),
    output: z.string(),
    metrics: z.array(metricResultSchema),
    /** Every enforced metric met its threshold. */
    passed: z.boolean(),
    /** Which metrics failed, and by how much. */
    failures: z.array(z.string().max(500)).default([]),
    latencyMs: z.number().min(0),
    costCents: z.number().min(0),
    /** Set when the case could not be run at all. Distinct from scoring badly. */
    error: z.string().max(2000).nullable().default(null),
  })
  .strict();

export type CaseResult = z.infer<typeof caseResultSchema>;

export interface EvaluationRun {
  id: string;
  suiteId: string;
  subject: string;
  organizationId: string | null;
  /** What was being evaluated: a model id, a prompt version, a commit. For the comparison. */
  variant: string;
  startedAt: Date;
  finishedAt: Date;
  results: CaseResult[];
  /** Mean score per metric across the cases that produced one. */
  scores: Record<string, number>;
  passed: number;
  failed: number;
  errored: number;
  totalCostCents: number;
}

/** What the caller runs for each case. */
export type EvaluationTarget = (input: {
  case: EvaluationCase;
  suite: EvaluationSuite;
}) => Promise<{
  output: string;
  latencyMs?: number;
  costCents?: number;
  /** For `schema_compliance`, when the case expects structured output. */
  parsed?: unknown;
  /** For `safety`, from `@trustos/guardrails`. */
  safety?: { outcome: 'allowed' | 'blocked' | 'needs_review'; reasons?: string[] };
}>;

export interface EvaluationRunStore {
  save(run: EvaluationRun): Promise<EvaluationRun>;
  /** Most recent first. */
  history(input: {
    suiteId: string;
    organizationId: string | null;
    variant?: string;
    limit?: number;
  }): Promise<EvaluationRun[]>;
}

export interface EvaluationServiceOptions {
  store?: EvaluationRunStore;
  logger?: LoggerPort;
  /** Scores a case with a model. The framework ships no grader — see `metrics.ts`. */
  modelGrader?: (input: {
    case: EvaluationCase;
    output: string;
  }) => Promise<{ score: number; detail: string }>;
  /** Validates structured output, when a case has parsed output. */
  validateSchema?: (value: unknown) => { ok: boolean; errors?: string[] };
  /** How many cases run at once. Bounded so a suite does not become a load test. */
  concurrency?: number;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class EvaluationService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: EvaluationServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  /**
   * Runs a suite.
   *
   * A case that throws is recorded as `errored` rather than failing the run, because a suite that
   * stops at the first broken case tells you about one problem when you wanted a report.
   */
  async run(input: {
    suite: unknown;
    target: EvaluationTarget;
    variant: string;
    organizationId?: string | null;
  }): Promise<EvaluationRun> {
    const suite = evaluationSuiteSchema.parse(input.suite);
    const startedAt = this.now();
    const concurrency = Math.max(1, Math.min(this.options.concurrency ?? 4, 20));

    const results: CaseResult[] = [];

    for (let index = 0; index < suite.cases.length; index += concurrency) {
      const batch = suite.cases.slice(index, index + concurrency);
      results.push(
        ...(await Promise.all(batch.map((entry) => this.runCase(suite, entry, input.target)))),
      );
    }

    const run: EvaluationRun = {
      id: this.newId('evalrun'),
      suiteId: suite.id,
      subject: suite.subject,
      organizationId: input.organizationId ?? null,
      variant: input.variant,
      startedAt,
      finishedAt: this.now(),
      results,
      scores: this.aggregate(results),
      passed: results.filter((result) => result.passed && !result.error).length,
      failed: results.filter((result) => !result.passed && !result.error).length,
      errored: results.filter((result) => result.error !== null).length,
      totalCostCents: results.reduce((total, result) => total + result.costCents, 0),
    };

    await this.options.store?.save(run);

    return run;
  }

  private async runCase(
    suite: EvaluationSuite,
    entry: EvaluationCase,
    target: EvaluationTarget,
  ): Promise<CaseResult> {
    const startedAt = Date.now();

    let output: Awaited<ReturnType<EvaluationTarget>>;

    try {
      output = await target({ case: entry, suite });
    } catch (caught) {
      return caseResultSchema.parse({
        caseId: entry.id,
        output: '',
        metrics: [],
        passed: false,
        failures: [],
        latencyMs: Date.now() - startedAt,
        costCents: 0,
        // Distinct from scoring badly: nothing was measured, so nothing should be averaged.
        error: caught instanceof Error ? caught.message : String(caught),
      });
    }

    const latencyMs = output.latencyMs ?? Date.now() - startedAt;
    const costCents = output.costCents ?? 0;

    const metrics: MetricResult[] = [
      relevance(output.output, entry.input),
      containsExpected(output.output, entry.expected),
      excludesForbidden(output.output, entry.forbidden),
      latencyScore(latencyMs, suite.latencyBudgetMs),
      costScore(costCents, suite.costBudgetCents),
    ];

    if (entry.sources.length > 0) {
      metrics.push(
        groundedness(output.output, entry.sources),
        citationCoverage(output.output, entry.sources.length),
      );
    }

    if (output.safety) metrics.push(safetyScore(output.safety));

    if (output.parsed !== undefined && this.options.validateSchema) {
      metrics.push(schemaCompliance(output.parsed, this.options.validateSchema));
    }

    if (this.options.modelGrader) {
      const graded = await this.options.modelGrader({ case: entry, output: output.output });
      metrics.push(
        metricResultSchema.parse({
          name: 'model_graded',
          kind: 'model_graded',
          score: Math.max(0, Math.min(1, graded.score)),
          detail: graded.detail,
        }),
      );
    }

    const thresholds = { ...suite.defaultThresholds, ...entry.thresholds };
    const failures: string[] = [];

    const scored = metrics.map((metric) => {
      const threshold = thresholds[metric.name];
      if (threshold === undefined) return metric;

      const passed = metric.score >= threshold;
      if (!passed) {
        failures.push(
          `${metric.name} scored ${metric.score.toFixed(2)} against a threshold of ${threshold.toFixed(2)}. ${metric.detail}`,
        );
      }

      return { ...metric, passed };
    });

    return caseResultSchema.parse({
      caseId: entry.id,
      output: output.output,
      metrics: scored,
      passed: failures.length === 0,
      failures,
      latencyMs,
      costCents,
      error: null,
    });
  }

  /** Mean per metric, over the cases that produced it. Errored cases contribute nothing. */
  private aggregate(results: CaseResult[]): Record<string, number> {
    const totals = new Map<string, { sum: number; count: number }>();

    for (const result of results) {
      if (result.error) continue;

      for (const metric of result.metrics) {
        const existing = totals.get(metric.name) ?? { sum: 0, count: 0 };
        totals.set(metric.name, { sum: existing.sum + metric.score, count: existing.count + 1 });
      }
    }

    return Object.fromEntries(
      [...totals.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, { sum, count }]) => [name, Number((sum / count).toFixed(4))]),
    );
  }

  /**
   * Compares two runs.
   *
   * Per case, not per average. An average that moved from 0.78 to 0.76 hides two cases falling off
   * a cliff behind three improving slightly, and the two are the ones somebody needs to look at.
   */
  compare(
    baseline: EvaluationRun,
    candidate: EvaluationRun,
    options: { tolerance?: number } = {},
  ): {
    regressions: Array<{
      caseId: string;
      metric: string;
      from: number;
      to: number;
      detail: string;
    }>;
    improvements: Array<{ caseId: string; metric: string; from: number; to: number }>;
    newFailures: string[];
    fixed: string[];
    scoreDelta: Record<string, number>;
    verdict: 'better' | 'worse' | 'unchanged' | 'incomparable';
  } {
    if (baseline.suiteId !== candidate.suiteId) {
      throw ApiError.validation(
        [
          {
            path: 'baseline',
            message:
              `These runs are of different suites ("${baseline.suiteId}" and "${candidate.suiteId}"), ` +
              'so a comparison between them would be meaningless.',
          },
        ],
        'These runs cannot be compared.',
      );
    }

    // A change smaller than this is noise from a non-deterministic model, not a signal.
    const tolerance = options.tolerance ?? 0.05;

    const baselineCases = new Map(baseline.results.map((result) => [result.caseId, result]));
    const regressions: Array<{
      caseId: string;
      metric: string;
      from: number;
      to: number;
      detail: string;
    }> = [];
    const improvements: Array<{ caseId: string; metric: string; from: number; to: number }> = [];
    const newFailures: string[] = [];
    const fixed: string[] = [];

    for (const result of candidate.results) {
      const before = baselineCases.get(result.caseId);
      if (!before) continue;

      if (before.passed && !result.passed) newFailures.push(result.caseId);
      if (!before.passed && result.passed) fixed.push(result.caseId);

      const beforeMetrics = new Map(before.metrics.map((metric) => [metric.name, metric]));

      for (const metric of result.metrics) {
        const previous = beforeMetrics.get(metric.name);
        if (!previous) continue;

        const delta = metric.score - previous.score;

        if (delta < -tolerance) {
          regressions.push({
            caseId: result.caseId,
            metric: metric.name,
            from: previous.score,
            to: metric.score,
            detail: metric.detail,
          });
        } else if (delta > tolerance) {
          improvements.push({
            caseId: result.caseId,
            metric: metric.name,
            from: previous.score,
            to: metric.score,
          });
        }
      }
    }

    const scoreDelta = Object.fromEntries(
      Object.keys({ ...baseline.scores, ...candidate.scores })
        .sort()
        .map((name) => [
          name,
          Number(((candidate.scores[name] ?? 0) - (baseline.scores[name] ?? 0)).toFixed(4)),
        ]),
    );

    const shared = candidate.results.filter((result) => baselineCases.has(result.caseId)).length;

    const verdict =
      shared === 0
        ? 'incomparable'
        : newFailures.length > 0 || regressions.length > 0
          ? 'worse'
          : fixed.length > 0 || improvements.length > 0
            ? 'better'
            : 'unchanged';

    return { regressions, improvements, newFailures, fixed, scoreDelta, verdict };
  }

  /**
   * Runs a suite and compares it against the last run of the same suite.
   *
   * The shape a CI job wants: run, compare, fail the build on a regression.
   */
  async runAndCompare(input: {
    suite: unknown;
    target: EvaluationTarget;
    variant: string;
    organizationId?: string | null;
    tolerance?: number;
  }): Promise<{
    run: EvaluationRun;
    comparison: ReturnType<EvaluationService['compare']> | null;
  }> {
    const suite = evaluationSuiteSchema.parse(input.suite);

    const previous = await this.options.store?.history({
      suiteId: suite.id,
      organizationId: input.organizationId ?? null,
      limit: 1,
    });

    const run = await this.run({ ...input, suite });

    return {
      run,
      comparison: previous?.[0]
        ? this.compare(previous[0], run, { tolerance: input.tolerance })
        : null,
    };
  }

  /** A short report, for `trustos ai evaluate`. */
  summarise(run: EvaluationRun): string {
    const lines = [
      `${run.suiteId} — ${run.variant}`,
      `${run.passed} passed, ${run.failed} failed${run.errored > 0 ? `, ${run.errored} errored` : ''} ` +
        `(${run.results.length} cases, ${run.totalCostCents.toFixed(2)}c)`,
      '',
    ];

    for (const [name, score] of Object.entries(run.scores)) {
      lines.push(`  ${name.padEnd(20)} ${score.toFixed(2)}`);
    }

    const failing = run.results.filter((result) => !result.passed);

    if (failing.length > 0) {
      lines.push('', 'Failures:');
      for (const result of failing) {
        lines.push(`  ${result.caseId}: ${result.error ?? result.failures.join(' ')}`);
      }
    }

    return lines.join('\n');
  }
}
