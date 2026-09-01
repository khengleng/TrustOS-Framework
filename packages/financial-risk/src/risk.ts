import { z } from 'zod';
import type { LoggerPort } from '@trustsystem/logging';
import { formatMoney, type Money } from '@trustsystem/financial-core';

/**
 * Risk and compliance extension points.
 *
 * **This package implements no detection engine, and that is the deliverable.** AML, fraud
 * scoring, sanctions screening and PEP checks are products — they need lists that are licensed,
 * models that are trained, and thresholds that a compliance officer signs off on. A framework that
 * shipped one would ship a wrong one, and worse, a deployment would believe it was screened.
 *
 * So what is here is the *seam*: interfaces the platform calls at the right moments, a registry
 * that runs several of them, and a result shape that carries a decision with its reason. Wiring a
 * real provider is implementing one interface.
 *
 * **Every hook is called before money moves.** A risk check that runs after the posting is a risk
 * check that documents what happened rather than preventing it.
 */

export const RISK_DECISIONS = [
  /** Proceed. */
  'approve',
  /** Proceed only after a person looks. Routes to human review. */
  'review',
  /** Do not proceed. */
  'decline',
] as const;

export type RiskDecision = (typeof RISK_DECISIONS)[number];

export const RISK_SIGNAL_KINDS = [
  'aml',
  'fraud',
  'velocity',
  'sanctions',
  'pep',
  'device',
  'behavioural',
  'other',
] as const;

export type RiskSignalKind = (typeof RISK_SIGNAL_KINDS)[number];

export const riskSignalSchema = z
  .object({
    kind: z.enum(RISK_SIGNAL_KINDS),
    /** Which assessor produced it. Named, so a false positive can be traced to a provider. */
    source: z.string().min(1).max(120),
    /** 0 to 100. Higher is riskier. */
    score: z.number().min(0).max(100),
    /** What the assessor found, in words a compliance officer can read. */
    detail: z.string().min(1).max(1000),
    /**
     * Whether this signal alone should stop the transaction.
     *
     * A sanctions match is decisive; a slightly unusual amount is not. Without the distinction,
     * combining scores lets three weak signals outvote one that legally cannot be overridden.
     */
    decisive: z.boolean().default(false),
  })
  .strict();

export type RiskSignal = z.infer<typeof riskSignalSchema>;

export interface RiskContext {
  organizationId: string | null;
  amount: Money;
  type: string;
  sourceWalletId: string | null;
  destinationWalletId: string | null;
  actorId: string | null;
  reference: string | null;
  at: Date;
  /** Anything else the deployment's assessors need. Passed through untouched. */
  metadata?: Record<string, unknown>;
}

export interface RiskAssessment {
  decision: RiskDecision;
  /** The combined score. See `combine` for how, and why it is not an average. */
  score: number;
  signals: RiskSignal[];
  /** Why this decision. Never empty for `review` or `decline`. */
  reason: string | null;
  assessedAt: Date;
}

/**
 * One assessor: a fraud engine, a sanctions provider, a velocity rule.
 *
 * The framework ships none. `assess` should not throw — see `RiskAssessor.assess` below for what
 * happens when it does.
 */
export interface RiskProvider {
  readonly name: string;
  readonly kind: RiskSignalKind;
  assess(context: RiskContext): Promise<RiskSignal | null>;
}

export interface RiskAssessorOptions {
  providers?: RiskProvider[];
  logger?: LoggerPort;
  /** At or above this, the transaction goes to review. */
  reviewThreshold?: number;
  /** At or above this, it is declined. */
  declineThreshold?: number;
  /**
   * What to do when a provider fails.
   *
   * `review` by default — not `approve`. A sanctions provider that times out has told you nothing,
   * and treating silence as clearance is how a screened platform stops being one. `approve` is
   * available and should be a deliberate, documented choice for a non-decisive provider.
   */
  onProviderFailure?: 'review' | 'decline' | 'approve';
  /** Per-provider timeout. A provider that hangs must not hang the payment. */
  timeoutMs?: number;
  now?: () => Date;
}

export class RiskAssessor {
  private readonly providers: RiskProvider[];
  private readonly reviewThreshold: number;
  private readonly declineThreshold: number;
  private readonly onProviderFailure: 'review' | 'decline' | 'approve';
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: RiskAssessorOptions = {}) {
    this.providers = options.providers ?? [];
    this.reviewThreshold = options.reviewThreshold ?? 50;
    this.declineThreshold = options.declineThreshold ?? 85;
    this.onProviderFailure = options.onProviderFailure ?? 'review';
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Runs every provider and combines the result.
   *
   * Providers run concurrently, because they are independent and a payment should not wait for
   * four of them in series. A provider that fails does not fail the assessment — it contributes
   * the configured failure signal, so the decision is made deliberately rather than by omission.
   */
  async assess(context: RiskContext): Promise<RiskAssessment> {
    const at = this.now();

    if (this.providers.length === 0) {
      /*
       * No providers configured.
       *
       * Approve, and say so in the reason. The alternative — declining everything — makes an
       * unwired framework useless, and the honest thing is to record that nothing was checked
       * rather than to imply something was.
       */
      return {
        decision: 'approve',
        score: 0,
        signals: [],
        reason: 'No risk providers are configured, so nothing was checked.',
        assessedAt: at,
      };
    }

    const results = await Promise.all(
      this.providers.map(async (provider) => {
        try {
          return await this.withTimeout(provider, context);
        } catch (error) {
          this.options.logger?.error(
            {
              provider: provider.name,
              kind: provider.kind,
              error: error instanceof Error ? error.message : String(error),
            },
            'risk provider failed',
          );

          if (this.onProviderFailure === 'approve') return null;

          return riskSignalSchema.parse({
            kind: provider.kind,
            source: provider.name,
            score: this.onProviderFailure === 'decline' ? 100 : this.reviewThreshold,
            detail:
              `The "${provider.name}" provider did not answer. Silence is not clearance, so this ` +
              `is treated as ${this.onProviderFailure}.`,
            decisive: this.onProviderFailure === 'decline',
          });
        }
      }),
    );

    const signals = results.filter((signal): signal is RiskSignal => signal !== null);

    return { ...combine(signals, this.reviewThreshold, this.declineThreshold), assessedAt: at };
  }

  private async withTimeout(
    provider: RiskProvider,
    context: RiskContext,
  ): Promise<RiskSignal | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        provider.assess(context),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`"${provider.name}" did not answer within ${this.timeoutMs}ms.`)),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Combines signals into a decision.
 *
 * **Not an average, and not a sum.** The combined score is the highest single signal, because risk
 * does not dilute: a sanctions match at 100 alongside three clean checks at 0 is still a sanctions
 * match, and an average would report 25.
 *
 * A `decisive` signal above the review threshold declines outright, whatever else was found.
 */
export function combine(
  signals: RiskSignal[],
  reviewThreshold: number,
  declineThreshold: number,
): Omit<RiskAssessment, 'assessedAt'> {
  if (signals.length === 0) {
    return { decision: 'approve', score: 0, signals, reason: null };
  }

  const highest = signals.reduce((worst, signal) => (signal.score > worst.score ? signal : worst));
  const decisive = signals.filter((signal) => signal.decisive && signal.score >= reviewThreshold);

  if (decisive.length > 0) {
    const worst = decisive.reduce((a, b) => (a.score > b.score ? a : b));

    return {
      decision: 'decline',
      score: worst.score,
      signals,
      reason: `${worst.source} (${worst.kind}): ${worst.detail}`,
    };
  }

  if (highest.score >= declineThreshold) {
    return {
      decision: 'decline',
      score: highest.score,
      signals,
      reason: `${highest.source} (${highest.kind}) scored ${highest.score}: ${highest.detail}`,
    };
  }

  if (highest.score >= reviewThreshold) {
    return {
      decision: 'review',
      score: highest.score,
      signals,
      reason: `${highest.source} (${highest.kind}) scored ${highest.score}: ${highest.detail}`,
    };
  }

  return { decision: 'approve', score: highest.score, signals, reason: null };
}

/**
 * A description of a risk assessment for an audit record.
 *
 * Names every provider that ran, including the ones that found nothing — a compliance answer to
 * "was this screened" needs the list of what ran, not only what fired.
 */
export function describeAssessment(assessment: RiskAssessment, context: RiskContext): string {
  if (assessment.signals.length === 0) {
    return assessment.reason ?? 'No signals.';
  }

  const parts = assessment.signals
    .map((signal) => `${signal.source}=${signal.score}${signal.decisive ? '!' : ''}`)
    .join(' ');

  return `${assessment.decision} (${assessment.score}) for ${formatMoney(context.amount)}: ${parts}`;
}
