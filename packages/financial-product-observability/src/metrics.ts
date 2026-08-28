import { z } from 'zod';
import type { ProductMetricSink } from '@trustos/financial-product-core';

/**
 * The product metric catalog.
 *
 * Section 28's thirteen measures, declared as data with their dimensions listed. Declaring them
 * matters more than it looks: **a metric dimension is a cardinality decision**, and the way a
 * metrics bill becomes the largest line in an infrastructure budget is one dimension carrying a
 * customer id. It is also how tenant data ends up somewhere nobody classified — a time series per
 * customer is a list of customers, in a system with no access control on it.
 *
 * So every dimension here is bounded and low-cardinality by construction: a product id, a block
 * id, an outcome, a provider *interface*. There is no dimension for a customer, an amount, a
 * merchant or an organization, and `assertLowCardinality` refuses one at the point of emission
 * rather than at review.
 *
 * The tenant is deliberately absent. A per-tenant time series is a legitimate thing to want and a
 * dangerous default: on a platform with ten thousand tenants it multiplies every series by ten
 * thousand. A deployment that wants it adds it knowingly, in its own sink.
 */

export const PRODUCT_METRICS = {
  EXECUTIONS: 'financial_product.executions',
  EXECUTION_LATENCY: 'financial_product.execution_latency_ms',
  BLOCK_LATENCY: 'financial_product.block_latency_ms',
  PROVIDER_LATENCY: 'financial_product.provider_latency_ms',
  PROVIDER_FAILURES: 'financial_product.provider_failures',
  RETRIES: 'financial_product.retries',
  LIMIT_REFUSALS: 'financial_product.limit_refusals',
  REVIEWS_REQUIRED: 'financial_product.reviews_required',
  SETTLEMENT_EXCEPTIONS: 'financial_product.settlement_exceptions',
  RECONCILIATION_EXCEPTIONS: 'financial_product.reconciliation_exceptions',
  FEE_TOTAL_MINOR_UNITS: 'financial_product.fee_total_minor_units',
  SLA_BREACHES: 'financial_product.sla_breaches',
  IDEMPOTENT_REPLAYS: 'financial_product.idempotent_replay',
} as const;

export type ProductMetricName = (typeof PRODUCT_METRICS)[keyof typeof PRODUCT_METRICS];

export const metricDefinitionSchema = z
  .object({
    name: z.string().min(3).max(80),
    kind: z.enum(['counter', 'histogram']),
    description: z.string().min(10).max(300),
    unit: z.enum(['count', 'milliseconds', 'minor_units']),
    /** Every dimension this metric may carry. A dimension outside the list is refused. */
    dimensions: z.array(z.string().regex(/^[a-z][a-z_]{0,29}$/)).max(6),
  })
  .strict();

export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;

/**
 * Dimensions that are never permitted, on any metric.
 *
 * Each one is unbounded in a live system. `customer` and `merchant` are one series per customer;
 * `amount` is one per distinct value; `execution` and `idempotency_key` are one per transaction.
 * A metric carrying any of them costs money and leaks a list.
 */
export const FORBIDDEN_DIMENSIONS: readonly string[] = [
  'customer',
  'customer_id',
  'merchant',
  'merchant_id',
  'wallet',
  'account',
  'amount',
  'execution',
  'execution_id',
  'idempotency_key',
  'reference',
  'email',
  'phone',
  'user',
  'user_id',
];

export const PRODUCT_METRIC_CATALOG: readonly MetricDefinition[] = Object.freeze(
  [
    {
      name: PRODUCT_METRICS.EXECUTIONS,
      kind: 'counter',
      description: 'Executions started, by product and outcome. A refusal is not a failure.',
      unit: 'count',
      dimensions: ['product', 'outcome'],
    },
    {
      name: PRODUCT_METRICS.EXECUTION_LATENCY,
      kind: 'histogram',
      description: 'End-to-end execution time, by product and outcome.',
      unit: 'milliseconds',
      dimensions: ['product', 'outcome'],
    },
    {
      name: PRODUCT_METRICS.BLOCK_LATENCY,
      kind: 'histogram',
      description: 'Time in one block. The measure that finds which step is slow.',
      unit: 'milliseconds',
      dimensions: ['product', 'block', 'outcome'],
    },
    {
      name: PRODUCT_METRICS.PROVIDER_LATENCY,
      kind: 'histogram',
      description: 'Time waiting on a provider interface. Never dimensioned by vendor name.',
      unit: 'milliseconds',
      dimensions: ['product', 'provider_interface'],
    },
    {
      name: PRODUCT_METRICS.PROVIDER_FAILURES,
      kind: 'counter',
      description: 'Provider calls that did not answer, by interface and code.',
      unit: 'count',
      dimensions: ['product', 'provider_interface', 'code'],
    },
    {
      name: PRODUCT_METRICS.RETRIES,
      kind: 'counter',
      description: 'Block attempts after the first. A rising count is a provider degrading.',
      unit: 'count',
      dimensions: ['product', 'block'],
    },
    {
      name: PRODUCT_METRICS.LIMIT_REFUSALS,
      kind: 'counter',
      description: 'Transactions a limit refused. The control working, and worth watching anyway.',
      unit: 'count',
      dimensions: ['product', 'limit_code'],
    },
    {
      name: PRODUCT_METRICS.REVIEWS_REQUIRED,
      kind: 'counter',
      description: 'Executions held for a person, by approval level. Drives staffing.',
      unit: 'count',
      dimensions: ['product', 'level'],
    },
    {
      name: PRODUCT_METRICS.SETTLEMENT_EXCEPTIONS,
      kind: 'counter',
      description: 'Settlement instructions that failed or were adjusted.',
      unit: 'count',
      dimensions: ['product', 'code'],
    },
    {
      name: PRODUCT_METRICS.RECONCILIATION_EXCEPTIONS,
      kind: 'counter',
      description: 'Differences queued for a person.',
      unit: 'count',
      dimensions: ['product', 'type'],
    },
    {
      name: PRODUCT_METRICS.FEE_TOTAL_MINOR_UNITS,
      kind: 'counter',
      description:
        'Fees charged, in minor units, by fee code and currency. A counter rather than a gauge ' +
        'because a total that can go down hides a reversal.',
      unit: 'minor_units',
      dimensions: ['product', 'fee_code', 'currency'],
    },
    {
      name: PRODUCT_METRICS.SLA_BREACHES,
      kind: 'counter',
      description: 'Blocks that exceeded their declared SLA.',
      unit: 'count',
      dimensions: ['product', 'block'],
    },
    {
      name: PRODUCT_METRICS.IDEMPOTENT_REPLAYS,
      kind: 'counter',
      description: 'Requests served from a stored result. A rising count is a client retrying.',
      unit: 'count',
      dimensions: ['product'],
    },
  ].map((entry) => metricDefinitionSchema.parse(entry)),
);

const BY_NAME = new Map(PRODUCT_METRIC_CATALOG.map((metric) => [metric.name, metric]));

/**
 * Refuses a dimension that would explode the cardinality.
 *
 * Called at emission rather than at review, because a dimension added during an incident is a
 * dimension nobody reviews. The refusal names the dimension and says why.
 */
export function assertLowCardinality(name: string, dimensions: Record<string, string>): void {
  const metric = BY_NAME.get(name);

  for (const key of Object.keys(dimensions)) {
    if (FORBIDDEN_DIMENSIONS.includes(key)) {
      throw new Error(
        `The metric "${name}" carries the dimension "${key}", which is unbounded in a live ` +
          'system: one time series per value. It costs money and it is a list of customers in a ' +
          'system with no access control on it.',
      );
    }

    if (metric && !metric.dimensions.includes(key)) {
      throw new Error(
        `The metric "${name}" does not declare the dimension "${key}". Declared: ` +
          `${metric.dimensions.join(', ')}. Add it to the catalog first, so the cardinality is a ` +
          'decision somebody made.',
      );
    }
  }
}

/**
 * A sink that checks before it records.
 *
 * Wraps another sink. The check is cheap and it runs on every emission, because the alternative
 * — checking in review — catches the dimension somebody added deliberately and misses the one
 * added at 3am.
 */
export function guardedSink(inner: ProductMetricSink): ProductMetricSink {
  return {
    increment: (name, dimensions, value) => {
      assertLowCardinality(name, dimensions);
      inner.increment(name, dimensions, value);
    },
    observe: (name, dimensions, milliseconds) => {
      assertLowCardinality(name, dimensions);
      inner.observe(name, dimensions, milliseconds);
    },
  };
}
