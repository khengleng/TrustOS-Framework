import { PRODUCT_METRICS } from './metrics';

/**
 * Dashboard descriptors.
 *
 * Data, for the same reason the designer's canvas is data: the admin application renders these,
 * the CLI prints them, and a deployment exports them to whatever it already runs. A dashboard
 * defined in a rendering library would be a dashboard only that library can show.
 *
 * The panels are chosen to answer the four questions somebody actually opens a dashboard with,
 * in the order they ask them:
 *
 *   1. **Is it working?** Volume and outcome, split so a refusal is visibly not a failure.
 *   2. **Is it slow?** Latency by block, because "the product is slow" is never actionable and
 *      "the settlement block is slow" is.
 *   3. **Is somebody waiting?** Reviews and exceptions — the queues with people at the end.
 *   4. **What is it earning, and what is it refusing?** Fees and limit refusals side by side,
 *      because a limit that refuses 30% of transactions is a pricing decision nobody made.
 */

export interface DashboardPanel {
  id: string;
  title: string;
  /** What a reader should take from it. Present because a panel with no thesis gets ignored. */
  interpretation: string;
  kind: 'stat' | 'timeseries' | 'breakdown' | 'table';
  metric: string;
  /** How to split the series. Must be dimensions the metric declares. */
  splitBy: string[];
  /** A threshold worth colouring. Never an alert — alerting belongs to the deployment. */
  warnAbove?: number;
}

export interface Dashboard {
  id: string;
  title: string;
  description: string;
  panels: DashboardPanel[];
}

export const PRODUCT_DASHBOARDS: readonly Dashboard[] = Object.freeze([
  {
    id: 'product-health',
    title: 'Product health',
    description: 'Volume, outcome and latency for one product. The first screen during an incident.',
    panels: [
      {
        id: 'volume',
        title: 'Executions',
        interpretation: 'Volume by outcome. A refusal is the system working; a failure is not.',
        kind: 'timeseries',
        metric: PRODUCT_METRICS.EXECUTIONS,
        splitBy: ['outcome'],
      },
      {
        id: 'latency',
        title: 'Execution latency',
        interpretation: 'End to end. A rise with flat block latency is queueing, not a slow block.',
        kind: 'timeseries',
        metric: PRODUCT_METRICS.EXECUTION_LATENCY,
        splitBy: ['outcome'],
      },
      {
        id: 'block-latency',
        title: 'Latency by block',
        interpretation: '"The product is slow" is not actionable. "Settlement is slow" is.',
        kind: 'breakdown',
        metric: PRODUCT_METRICS.BLOCK_LATENCY,
        splitBy: ['block'],
      },
      {
        id: 'sla',
        title: 'SLA breaches',
        interpretation: 'Blocks that exceeded the time the product promised for them.',
        kind: 'stat',
        metric: PRODUCT_METRICS.SLA_BREACHES,
        splitBy: ['block'],
        warnAbove: 0,
      },
    ],
  },
  {
    id: 'provider-health',
    title: 'Provider health',
    description: 'How the interfaces this product depends on are behaving. Never split by vendor.',
    panels: [
      {
        id: 'provider-latency',
        title: 'Provider latency',
        interpretation: 'By interface. A single interface degrading is a fallback decision.',
        kind: 'timeseries',
        metric: PRODUCT_METRICS.PROVIDER_LATENCY,
        splitBy: ['provider_interface'],
      },
      {
        id: 'provider-failures',
        title: 'Provider failures',
        interpretation: 'Calls that did not answer. Rising with retries is a provider degrading.',
        kind: 'timeseries',
        metric: PRODUCT_METRICS.PROVIDER_FAILURES,
        splitBy: ['provider_interface', 'code'],
      },
      {
        id: 'retries',
        title: 'Retries',
        interpretation: 'Attempts after the first. A leading indicator of the panel above.',
        kind: 'timeseries',
        metric: PRODUCT_METRICS.RETRIES,
        splitBy: ['block'],
      },
    ],
  },
  {
    id: 'queues',
    title: 'Who is waiting',
    description: 'The queues with people at the end of them.',
    panels: [
      {
        id: 'reviews',
        title: 'Reviews required',
        interpretation: 'Executions held for a person. This number is a staffing decision.',
        kind: 'timeseries',
        metric: PRODUCT_METRICS.REVIEWS_REQUIRED,
        splitBy: ['level'],
      },
      {
        id: 'reconciliation',
        title: 'Reconciliation exceptions',
        interpretation: 'Differences somebody must resolve. The output of reconciliation is a queue.',
        kind: 'timeseries',
        metric: PRODUCT_METRICS.RECONCILIATION_EXCEPTIONS,
        splitBy: ['type'],
      },
      {
        id: 'settlement',
        title: 'Settlement exceptions',
        interpretation: 'Instructions that failed or were adjusted after money had already moved.',
        kind: 'timeseries',
        metric: PRODUCT_METRICS.SETTLEMENT_EXCEPTIONS,
        splitBy: ['code'],
      },
    ],
  },
  {
    id: 'commercials',
    title: 'Earning and refusing',
    description: 'Fees beside limit refusals, because the two are the same conversation.',
    panels: [
      {
        id: 'fees',
        title: 'Fees charged',
        interpretation: 'Minor units, by fee code. A counter, so a reversal is visible as a gap.',
        kind: 'breakdown',
        metric: PRODUCT_METRICS.FEE_TOTAL_MINOR_UNITS,
        splitBy: ['fee_code', 'currency'],
      },
      {
        id: 'limit-refusals',
        title: 'Limit refusals',
        interpretation: 'A limit refusing 30% of transactions is a pricing decision nobody made.',
        kind: 'timeseries',
        metric: PRODUCT_METRICS.LIMIT_REFUSALS,
        splitBy: ['limit_code'],
      },
      {
        id: 'replays',
        title: 'Idempotent replays',
        interpretation: 'Requests served from a stored result. Rising means a client is retrying.',
        kind: 'stat',
        metric: PRODUCT_METRICS.IDEMPOTENT_REPLAYS,
        splitBy: [],
      },
    ],
  },
]);

export function findDashboard(id: string): Dashboard | undefined {
  return PRODUCT_DASHBOARDS.find((dashboard) => dashboard.id === id);
}
