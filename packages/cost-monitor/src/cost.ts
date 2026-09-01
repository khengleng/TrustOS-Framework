import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LoggerPort } from '@trustsystem/logging';
import { AiError, type AiRequestContext, type Usage } from '@trustsystem/ai-sdk';
import { computeCost, type ModelRegistry } from '@trustsystem/model-registry';

/**
 * Cost accounting.
 *
 * Every gateway call produces one record. From those, four questions get answered: what did this
 * request cost, what has this tenant spent today, are we near a budget, and where is the money
 * going.
 *
 * Two decisions worth stating:
 *
 * **1. Cost is recorded in cents as a float, and rounded once at the point money is reported.**
 * Rounding each call accumulates error in the direction of whoever rounds, and a per-call cost is
 * genuinely sub-cent — a thousand calls at 0.4c is four dollars, and rounding each to zero loses
 * all of it.
 *
 * **2. Estimated and measured usage are counted separately.** A cache hit, a streamed response
 * with no usage block, and a request that failed after the prompt was sent all produce estimates.
 * A report that cannot say how much of its total is estimated is a report nobody can reconcile
 * against an invoice — and reconciling is the entire reason anybody looks at it.
 */

export const costEntrySchema = z
  .object({
    id: z.string(),
    organizationId: z.string().nullable(),
    /** Which application spent it. */
    application: z.string().max(120),
    actorId: z.string().nullable(),

    modelId: z.string().max(120),
    provider: z.string().max(60),

    /** Set when the call was on an agent's behalf. */
    agentId: z.string().max(120).nullable().default(null),
    promptKey: z.string().max(120).nullable().default(null),

    promptTokens: z.number().int().min(0),
    completionTokens: z.number().int().min(0),
    reasoningTokens: z.number().int().min(0).default(0),
    cachedPromptTokens: z.number().int().min(0).default(0),
    totalTokens: z.number().int().min(0),

    /** Cents. Sub-cent precision preserved; rounded only when reported. */
    costCents: z.number().min(0),

    /** Whether the token counts came from the provider or from an estimate. */
    estimated: z.boolean(),
    /** True when no provider call happened at all. */
    cached: z.boolean().default(false),

    latencyMs: z.number().int().min(0),
    /** `stop`, `length`, `error` — so a cost report can separate wasted spend from useful spend. */
    outcome: z.string().max(40),

    occurredAt: z.coerce.date(),
  })
  .strict();

export type CostEntry = z.infer<typeof costEntrySchema>;

export interface CostFilter {
  organizationId: string | null;
  from?: Date;
  to?: Date;
  application?: string;
  modelId?: string;
  agentId?: string;
}

export interface CostTotals {
  costCents: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
  /** How much of `costCents` came from estimated usage. The reconciliation number. */
  estimatedCostCents: number;
  cachedRequests: number;
}

export interface CostStore {
  record(entry: CostEntry): Promise<void>;
  /** Aggregated, not the rows — a month of rows for a busy tenant is millions. */
  totals(filter: CostFilter): Promise<CostTotals>;
  /** Grouped, for the dashboard. */
  breakdown(
    filter: CostFilter,
    by: 'model' | 'application' | 'agent' | 'day',
  ): Promise<Array<{ key: string; totals: CostTotals }>>;
  /** Retention. A busy tenant produces millions of rows a year. */
  purgeOlderThan(cutoff: Date): Promise<number>;
}

export const budgetAlertSchema = z
  .object({
    level: z.enum(['warning', 'exceeded']),
    period: z.enum(['request', 'day', 'month']),
    organizationId: z.string().nullable(),
    limitCents: z.number(),
    spentCents: z.number(),
    fraction: z.number(),
    message: z.string(),
  })
  .strict();

export type BudgetAlert = z.infer<typeof budgetAlertSchema>;

export interface CostMonitorOptions {
  store: CostStore;
  registry: ModelRegistry;
  logger?: LoggerPort;
  /** Called on a warning or a breach. Wire it to notifications or the event bus. */
  onAlert?: (alert: BudgetAlert) => void | Promise<void>;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export class CostMonitor {
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;

  constructor(private readonly options: CostMonitorOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID()}`);
  }

  /**
   * Records what a call cost.
   *
   * Never throws. A cost record that failed to write must not fail the request that produced it —
   * the work is already done and the money already spent, and losing the *answer* as well as the
   * accounting is strictly worse than losing the accounting.
   */
  async record(input: {
    context: Pick<
      AiRequestContext,
      'organizationId' | 'actorId' | 'application' | 'agentId' | 'promptId'
    >;
    modelId: string;
    usage: Usage;
    latencyMs: number;
    outcome: string;
    cached?: boolean;
  }): Promise<CostEntry | null> {
    try {
      const model = this.options.registry.find(input.modelId, input.context.organizationId);

      /*
       * An unknown model costs zero and says so.
       *
       * It happens: a model is retired between the call starting and the record being written.
       * Guessing a price would put a fabricated number in a financial report, which is worse than
       * a zero somebody can see and investigate.
       */
      const costCents = model ? computeCost(model, input.usage) : 0;

      if (!model) {
        this.options.logger?.warn(
          { modelId: input.modelId, organizationId: input.context.organizationId },
          'cost recorded as zero: the model is no longer in the registry',
        );
      }

      const entry = costEntrySchema.parse({
        id: this.newId('cost'),
        organizationId: input.context.organizationId,
        application: input.context.application,
        actorId: input.context.actorId,
        modelId: input.modelId,
        provider: model?.provider ?? 'unknown',
        agentId: input.context.agentId ?? null,
        promptKey: input.context.promptId ?? null,
        promptTokens: input.usage.promptTokens,
        completionTokens: input.usage.completionTokens,
        reasoningTokens: input.usage.reasoningTokens,
        cachedPromptTokens: input.usage.cachedPromptTokens,
        totalTokens: input.usage.totalTokens,
        costCents,
        estimated: input.usage.estimated,
        cached: input.cached ?? false,
        latencyMs: input.latencyMs,
        outcome: input.outcome,
        occurredAt: this.now(),
      });

      await this.options.store.record(entry);
      return entry;
    } catch (error) {
      this.options.logger?.error(
        {
          modelId: input.modelId,
          organizationId: input.context.organizationId,
          error: error instanceof Error ? error.message : String(error),
        },
        'failed to record AI cost; the request itself was not affected',
      );
      return null;
    }
  }

  /**
   * Checks a tenant against its budget before a request runs.
   *
   * Returns the decision rather than throwing, so a caller can distinguish "warn and proceed"
   * from "stop" — the two need different handling and collapsing them means a warning either
   * blocks or is invisible.
   */
  async checkBudget(input: {
    organizationId: string | null;
    budget: {
      maxCostCentsPerRequest: number | null;
      maxCostCentsPerDay: number | null;
      maxCostCentsPerMonth: number | null;
      warnAtFraction: number;
    };
    estimatedCostCents?: number;
  }): Promise<{ allowed: boolean; alerts: BudgetAlert[] }> {
    const alerts: BudgetAlert[] = [];
    let allowed = true;

    if (
      input.budget.maxCostCentsPerRequest !== null &&
      input.estimatedCostCents !== undefined &&
      input.estimatedCostCents > input.budget.maxCostCentsPerRequest
    ) {
      allowed = false;
      alerts.push({
        level: 'exceeded',
        period: 'request',
        organizationId: input.organizationId,
        limitCents: input.budget.maxCostCentsPerRequest,
        spentCents: input.estimatedCostCents,
        fraction: input.estimatedCostCents / input.budget.maxCostCentsPerRequest,
        message:
          `This single request is estimated at ${input.estimatedCostCents.toFixed(2)}c, over the ` +
          `${input.budget.maxCostCentsPerRequest}c per-request ceiling.`,
      });
    }

    const now = this.now();

    if (input.budget.maxCostCentsPerDay !== null) {
      const totals = await this.options.store.totals({
        organizationId: input.organizationId,
        from: startOfDay(now),
        to: now,
      });

      const projected = totals.costCents + (input.estimatedCostCents ?? 0);
      const alert = this.evaluate(
        'day',
        input.organizationId,
        input.budget.maxCostCentsPerDay,
        projected,
        input.budget.warnAtFraction,
      );

      if (alert) {
        alerts.push(alert);
        if (alert.level === 'exceeded') allowed = false;
      }
    }

    if (input.budget.maxCostCentsPerMonth !== null) {
      const totals = await this.options.store.totals({
        organizationId: input.organizationId,
        from: startOfMonth(now),
        to: now,
      });

      const projected = totals.costCents + (input.estimatedCostCents ?? 0);
      const alert = this.evaluate(
        'month',
        input.organizationId,
        input.budget.maxCostCentsPerMonth,
        projected,
        input.budget.warnAtFraction,
      );

      if (alert) {
        alerts.push(alert);
        if (alert.level === 'exceeded') allowed = false;
      }
    }

    for (const alert of alerts) {
      // Fired for warnings too. Reaching a budget with no prior signal is how an AI feature gets
      // switched off during business hours.
      try {
        await this.options.onAlert?.(alert);
      } catch {
        /* An alert handler must not fail the budget check. */
      }
    }

    return { allowed, alerts };
  }

  private evaluate(
    period: 'day' | 'month',
    organizationId: string | null,
    limitCents: number,
    spentCents: number,
    warnAtFraction: number,
  ): BudgetAlert | null {
    const fraction = limitCents === 0 ? Number.POSITIVE_INFINITY : spentCents / limitCents;

    if (spentCents > limitCents) {
      return {
        level: 'exceeded',
        period,
        organizationId,
        limitCents,
        spentCents,
        fraction,
        message:
          `This tenant has spent ${spentCents.toFixed(2)}c this ${period}, over its ` +
          `${limitCents}c budget. Further AI requests are refused until the budget resets or is raised.`,
      };
    }

    if (fraction >= warnAtFraction) {
      return {
        level: 'warning',
        period,
        organizationId,
        limitCents,
        spentCents,
        fraction,
        message:
          `This tenant has spent ${spentCents.toFixed(2)}c of its ${limitCents}c ${period} budget ` +
          `(${Math.round(fraction * 100)}%).`,
      };
    }

    return null;
  }

  /** Throws when a budget is exceeded. For a caller that just wants the request to stop. */
  async assertBudget(input: Parameters<CostMonitor['checkBudget']>[0]): Promise<void> {
    const result = await this.checkBudget(input);
    if (result.allowed) return;

    const breach = result.alerts.find((alert) => alert.level === 'exceeded')!;
    throw AiError.budgetExceeded(breach.message, {
      reason: 'budget_exceeded',
      period: breach.period,
      limitCents: breach.limitCents,
      spentCents: breach.spentCents,
    });
  }

  async totals(filter: CostFilter): Promise<CostTotals> {
    return this.options.store.totals(filter);
  }

  async breakdown(
    filter: CostFilter,
    by: 'model' | 'application' | 'agent' | 'day',
  ): Promise<Array<{ key: string; totals: CostTotals }>> {
    return this.options.store.breakdown(filter, by);
  }

  /**
   * A report for a person.
   *
   * Rounds once, here, and states how much of the total is estimated — which is what makes it
   * reconcilable rather than merely plausible.
   */
  async report(filter: CostFilter): Promise<{
    totalCostCents: number;
    totalCostDisplay: string;
    estimatedFraction: number;
    caveat: string | null;
    requests: number;
    cacheHitRate: number;
    byModel: Array<{ key: string; costCents: number; requests: number }>;
  }> {
    const [totals, byModel] = await Promise.all([
      this.options.store.totals(filter),
      this.options.store.breakdown(filter, 'model'),
    ]);

    const estimatedFraction =
      totals.costCents === 0 ? 0 : totals.estimatedCostCents / totals.costCents;

    return {
      totalCostCents: round(totals.costCents),
      totalCostDisplay: formatCents(totals.costCents),
      estimatedFraction,
      caveat:
        estimatedFraction > 0.05
          ? `${Math.round(estimatedFraction * 100)}% of this total is from estimated token counts ` +
            'rather than provider-reported ones, so it will not reconcile exactly against an invoice.'
          : null,
      requests: totals.requests,
      cacheHitRate: totals.requests === 0 ? 0 : totals.cachedRequests / totals.requests,
      byModel: byModel
        .map((entry) => ({
          key: entry.key,
          costCents: round(entry.totals.costCents),
          requests: entry.totals.requests,
        }))
        .sort((a, b) => b.costCents - a.costCents),
    };
  }
}

function round(cents: number): number {
  return Math.round(cents * 100) / 100;
}

/** Cents to something a person reads. Rounded once, here. */
export function formatCents(cents: number): string {
  if (cents < 1) return `${(Math.round(cents * 1000) / 1000).toFixed(3)}c`;
  if (cents < 100) return `${(Math.round(cents * 100) / 100).toFixed(2)}c`;
  return `$${(cents / 100).toFixed(2)}`;
}

export function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

export function startOfMonth(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCDate(1);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

/** An empty totals object. Kept here so every store implementation returns the same shape. */
export const EMPTY_TOTALS: CostTotals = {
  costCents: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  requests: 0,
  estimatedCostCents: 0,
  cachedRequests: 0,
};
