import { formatDecimal, toMinorUnits } from '@trustsystem/financial-core';
import type { ExecutionRecord } from '@trustsystem/financial-product-runtime';
import type { SandboxState } from '@trustsystem/financial-product-sandbox';

/**
 * Simulation metrics.
 *
 * Section 16's eleven measures, plus the two the runtime's own shape makes necessary: the state
 * distribution and the path distribution.
 *
 * The **path distribution** is the one worth running a simulation for. A product owner can read a
 * fee off a definition; what they cannot read is that 4% of transactions take the enhanced-review
 * branch, which is forty people a day at the volume they are planning. Every other number here is
 * checkable by hand on ten transactions; this one is not checkable at all without running it.
 *
 * Two things this report deliberately does not claim:
 *
 * **The latency figures are the runtime's own overhead.** Every handler is a mock that returns
 * immediately. Quoting them as end-to-end latency would be quoting a number that has never met a
 * network, and somebody will put it in a capacity plan.
 *
 * **A success rate is a success rate under the injected scenario mix.** With no scenarios injected
 * it is a measure of the product's internal logic and nothing else — which is useful, and is not
 * a reliability estimate.
 */

export interface PathCount {
  /** The block sequence, joined. What an execution actually did. */
  path: string;
  count: number;
  proportion: number;
}

export interface SimulationReport {
  productId: string;
  version: string;
  seed: number;
  requested: number;
  executed: number;

  successCount: number;
  refusalCount: number;
  failureCount: number;
  openCount: number;
  successRate: number;
  failureRate: number;

  /** Executions by terminal state. `refused` and `failed` are different things. */
  byState: Record<string, number>;
  /** Refusals by code, most frequent first. What a product owner reads to tune a limit. */
  refusalsByCode: Array<{ code: string; count: number }>;
  /** The distinct block sequences transactions took, most frequent first. */
  pathDistribution: PathCount[];

  /** Totals the sandbox computed, as decimal strings. Never numbers. */
  feeTotals: Record<string, string>;
  limitRefusals: number;
  reviewsRequired: number;
  duplicatesPrevented: number;
  compensationsRun: number;
  compensationFailures: number;
  slaBreaches: number;
  journalsPosted: number;
  settlementsCreated: number;

  /** Block latency, in milliseconds, measured against the simulator's fixed clock. */
  blockLatency: Array<{ blockId: string; count: number; totalMs: number }>;
  /** Wall clock for the whole run. The only real time in the report. */
  wallClockMs: number;
  /** Stated rather than implied, because somebody will put these numbers in a capacity plan. */
  caveats: string[];
}

export function summarise(input: {
  productId: string;
  version: string;
  seed: number;
  requested: number;
  records: readonly ExecutionRecord[];
  wallClockMs: number;
  state: SandboxState;
  /** Whether limit consumption was cleared between transactions. Changes what the counts mean. */
  limitsResetPerTransaction?: boolean;
}): SimulationReport {
  const { records } = input;

  const byState: Record<string, number> = {};
  const refusalCodes = new Map<string, number>();
  const paths = new Map<string, number>();
  const latency = new Map<string, { count: number; totalMs: number }>();

  let successCount = 0;
  let refusalCount = 0;
  let failureCount = 0;
  let openCount = 0;
  let reviewsRequired = 0;
  let slaBreaches = 0;
  let compensationsRun = 0;
  let compensationFailures = 0;
  let limitRefusals = 0;

  const seenExecutions = new Set<string>();
  let duplicatesPrevented = 0;

  for (const record of records) {
    /*
     * A replayed execution appears twice in the list with one execution id.
     *
     * Counting it as two would report a hundred thousand transactions when ninety thousand ran,
     * and the success rate would be computed over the wrong denominator.
     */
    if (seenExecutions.has(record.executionId)) {
      duplicatesPrevented += 1;
      continue;
    }
    seenExecutions.add(record.executionId);

    byState[record.state] = (byState[record.state] ?? 0) + 1;

    if (record.outcome === 'success') successCount += 1;
    else if (record.outcome === 'refusal') refusalCount += 1;
    else if (record.outcome === 'failure') failureCount += 1;
    else openCount += 1;

    if (record.pendingReview) reviewsRequired += 1;
    if (record.state === 'compensation_failed') compensationFailures += 1;

    if (record.refusal) {
      refusalCodes.set(record.refusal.code, (refusalCodes.get(record.refusal.code) ?? 0) + 1);
      if (record.refusal.code === 'limit_exceeded') limitRefusals += 1;
    }

    const path = record.steps.map((step) => step.blockKey).join(' -> ') || '(nothing ran)';
    paths.set(path, (paths.get(path) ?? 0) + 1);

    for (const step of record.steps) {
      if (step.slaBreached) slaBreaches += 1;

      const entry = latency.get(step.blockId) ?? { count: 0, totalMs: 0 };
      entry.count += 1;
      entry.totalMs += step.durationMs;
      latency.set(step.blockId, entry);
    }

    compensationsRun += record.steps.filter(
      (step) =>
        step.blockKey.startsWith('reverse') ||
        step.blockKey.startsWith('adjust') ||
        step.blockKey.startsWith('refund'),
    ).length;
  }

  const executed = seenExecutions.size;

  const feeTotals: Record<string, string> = {};
  for (const [code, money] of input.state.fees) {
    feeTotals[code] = `${formatDecimal(money.amount)} ${money.currency}`;
  }

  return {
    productId: input.productId,
    version: input.version,
    seed: input.seed,
    requested: input.requested,
    executed,

    successCount,
    refusalCount,
    failureCount,
    openCount,
    successRate: executed === 0 ? 0 : successCount / executed,
    failureRate: executed === 0 ? 0 : failureCount / executed,

    byState,
    refusalsByCode: [...refusalCodes.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => right.count - left.count),
    pathDistribution: [...paths.entries()]
      .map(([path, count]) => ({ path, count, proportion: executed === 0 ? 0 : count / executed }))
      .sort((left, right) => right.count - left.count),

    feeTotals,
    limitRefusals,
    reviewsRequired,
    duplicatesPrevented,
    compensationsRun,
    compensationFailures,
    slaBreaches,
    journalsPosted: input.state.journals.length,
    settlementsCreated: input.state.settlements.length,

    blockLatency: [...latency.entries()]
      .map(([blockId, entry]) => ({ blockId, ...entry }))
      .sort((left, right) => right.totalMs - left.totalMs),

    wallClockMs: input.wallClockMs,
    caveats: [
      'Every provider is a mock that returns immediately. The block latencies measure the ' +
        'runtime’s own overhead and say nothing about a provider or a network.',
      ...(input.limitsResetPerTransaction
        ? [
            'Limit consumption was cleared between transactions, so each one was measured on its ' +
              'own. Cumulative limits — daily, monthly, velocity — therefore refused nothing, and ' +
              'a zero in "limit refusals" says nothing about how they behave over a real day.',
          ]
        : []),
      'The success rate is a rate under the injected scenario mix. With no scenarios injected it ' +
        'measures the product’s internal logic and is not a reliability estimate.',
      'Fees are computed by the sandbox’s placeholder rate, not by the product’s fee schedule. ' +
        'Use @trustsystem/fees for a priced figure.',
    ],
  };
}

/** The report as lines a person reads. What the CLI prints. */
export function formatReport(report: SimulationReport): string[] {
  const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;

  const lines = [
    `${report.productId}@${report.version} — ${report.executed} executed of ${report.requested} requested (seed ${report.seed})`,
    '',
    `  success   ${report.successCount} (${percent(report.successRate)})`,
    `  refused   ${report.refusalCount}`,
    `  failed    ${report.failureCount} (${percent(report.failureRate)})`,
    `  open      ${report.openCount}`,
    '',
    `  reviews required      ${report.reviewsRequired}`,
    `  limit refusals        ${report.limitRefusals}`,
    `  duplicates prevented  ${report.duplicatesPrevented}`,
    `  compensations run     ${report.compensationsRun}`,
    `  compensation failures ${report.compensationFailures}`,
    `  SLA breaches          ${report.slaBreaches}`,
    `  journals posted       ${report.journalsPosted}`,
    `  settlements created   ${report.settlementsCreated}`,
    '',
    '  fee totals:',
    ...Object.entries(report.feeTotals).map(([code, total]) => `    ${code}  ${total}`),
    '',
    '  path distribution:',
    ...report.pathDistribution
      .slice(0, 8)
      .map((entry) => `    ${percent(entry.proportion).padStart(7)}  ${entry.path}`),
  ];

  if (report.refusalsByCode.length > 0) {
    lines.push('', '  refusals by code:');
    for (const entry of report.refusalsByCode)
      lines.push(`    ${entry.count.toString().padStart(7)}  ${entry.code}`);
  }

  lines.push('', `  wall clock: ${report.wallClockMs}ms`, '', '  caveats:');
  for (const caveat of report.caveats) lines.push(`    - ${caveat}`);

  return lines;
}

/** The unused import guard: `toMinorUnits` is re-exported for a caller totalling a report. */
export { toMinorUnits };
