import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PILOT_CURRENCY, buildPilot, pilotLimits, type Pilot } from './pilot';
import { merchantSchema, type Merchant } from './domain/merchant';
import { paymentRequestSchema } from './domain/payment';

/**
 * §23 of the pilot specification: performance at three concurrency levels.
 *
 * **What this measures, stated first.** It measures the pilot's payment path in one Node process
 * against in-memory stores: validation, the limit consume, the fee calculation, the ledger posting
 * and the wallet balance derivation. It does **not** measure HTTP, TLS, JSON parsing, connection
 * pooling, database round trips, network latency or a real provider.
 *
 * A production p95 will be larger, and it will be larger by an amount dominated by the database
 * and the network rather than by anything here. What these numbers are good for is the opposite
 * question: whether the *application logic* has a cost worth worrying about, and whether it
 * degrades with concurrency.
 *
 * The specification says report actual measurements. These are actual, and the paragraph above is
 * why the readiness scorecard does not mark performance as passing on the strength of them.
 */

const NOW = new Date('2026-06-15T10:00:00.000Z');
const CONCURRENCY_LEVELS = [10, 50, 100] as const;
const PAYMENTS_PER_USER = 20;

interface Measurement {
  readonly concurrency: number;
  readonly payments: number;
  readonly wallClockMs: number;
  readonly throughputPerSecond: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly errorRate: number;
  readonly accepted: number;
  readonly refused: number;
  readonly heapUsedMb: number;
}

const measurements: Measurement[] = [];

function merchant(index: number): Merchant {
  return merchantSchema.parse({
    merchantId: `mer_${index.toString(36).padStart(4, '0')}`,
    organizationId: 'org_a',
    legalName: `Merchant ${index} Limited`,
    tradingName: `Merchant ${index}`,
    categoryCode: '5812',
    status: 'registered',
    productId: 'merchant-wallet-basic',
    productVersion: '1.0.0',
    currency: PILOT_CURRENCY,
    createdAt: NOW.toISOString(),
    createdBy: 'usr_ops_maker',
  });
}

async function approvedMerchants(harness: Pilot, count: number): Promise<string[]> {
  const ids: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const record = merchant(index);
    await harness.onboarding.register(record, 'usr_ops_maker');
    await harness.onboarding.verify({
      organizationId: 'org_a',
      merchantId: record.merchantId,
      actorId: 'usr_ops_checker',
      notes: 'Registration documents and bank details confirmed against the register.',
    });
    await harness.onboarding.approve({
      organizationId: 'org_a',
      merchantId: record.merchantId,
      actorId: 'usr_ops_manager',
      reason: 'Verification complete.',
    });
    ids.push(record.merchantId);
  }

  return ids;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Number((sorted[Math.max(0, index)] as number).toFixed(3));
}

async function measure(concurrency: number): Promise<Measurement> {
  /*
   * A generous daily limit, so the run measures throughput rather than the limit engine refusing.
   * The limit engine's own behaviour is measured in `pilot.spec.ts`, where it is the subject.
   */
  const harness = await buildPilot({
    now: () => NOW,
    limits: pilotLimits('org_a').map((limit) =>
      limit.key === 'wallet.daily.usd' ? { ...limit, maxAmount: '10000000.00' } : limit,
    ),
  });

  const merchants = await approvedMerchants(harness, concurrency);
  const latencies: number[] = [];
  let accepted = 0;
  let refused = 0;
  let errors = 0;

  const startedAt = performance.now();

  await Promise.all(
    merchants.map(async (merchantId, user) => {
      for (let index = 0; index < PAYMENTS_PER_USER; index += 1) {
        const began = performance.now();

        try {
          const result = await harness.payments.accept({
            request: paymentRequestSchema.parse({
              merchantId,
              amount: '10.00',
              currency: PILOT_CURRENCY,
              reference: `PERF-${user}-${index}`,
            }),
            organizationId: 'org_a',
            actorId: `usr_cashier_${user}`,
            correlationId: `cor_perf_${user}_${index}`,
          });

          if (result.status === 'accepted') accepted += 1;
          else refused += 1;
        } catch {
          errors += 1;
        }

        latencies.push(performance.now() - began);
      }
    }),
  );

  const wallClockMs = performance.now() - startedAt;
  const sorted = [...latencies].sort((left, right) => left - right);
  const payments = concurrency * PAYMENTS_PER_USER;

  return {
    concurrency,
    payments,
    wallClockMs: Number(wallClockMs.toFixed(1)),
    throughputPerSecond: Number(((payments / wallClockMs) * 1000).toFixed(1)),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: Number((sorted.at(-1) ?? 0).toFixed(3)),
    errorRate: Number((errors / payments).toFixed(6)),
    accepted,
    refused,
    heapUsedMb: Number((process.memoryUsage().heapUsed / 1_048_576).toFixed(1)),
  };
}

describe('payment path performance', () => {
  for (const concurrency of CONCURRENCY_LEVELS) {
    it(`${concurrency} concurrent merchants, ${PAYMENTS_PER_USER} payments each`, async () => {
      const result = await measure(concurrency);
      measurements.push(result);

      // The assertion is that it completed without error, not that it was fast. A latency
      // threshold asserted here would be a threshold measured on whichever machine ran CI.
      expect(result.errorRate).toBe(0);
      expect(result.accepted).toBe(result.payments);
    }, 120_000);
  }

  it('does not degrade non-linearly with concurrency', async () => {
    /*
     * The property worth asserting, and the only one that is machine-independent: ten times the
     * concurrency should not cost far more than ten times the work. A quadratic term here would
     * be a shared structure being rescanned per request, and it would be invisible at one user.
     */
    const [low, , high] = measurements;

    expect(low).toBeDefined();
    expect(high).toBeDefined();

    const workRatio = (high as Measurement).payments / (low as Measurement).payments;
    const timeRatio = (high as Measurement).wallClockMs / (low as Measurement).wallClockMs;

    // Allowed to be four times worse than linear before it counts as degradation. Generous,
    // because the machine is shared with whatever else CI is doing.
    expect(timeRatio).toBeLessThan(workRatio * 4);
  });

  it('writes the measurements to the evidence pack', async () => {
    /*
     * Written only when explicitly asked for.
     *
     * An ordinary `npm test` used to rewrite this file, so the committed artefact drifted from the
     * prose that quoted it on every run — and the working tree was dirty after every test. Worse,
     * the numbers here move with whatever else the machine is doing: the same suite has produced
     * 3,848 and 6,512 payments per second on this laptop depending on load.
     *
     * So the artefact is produced by a deliberate measurement run, and the documentation quotes
     * that run. `npm run evidence` sets the flag.
     */
    if (process.env.TRUSTOS_WRITE_EVIDENCE !== '1') {
      expect(measurements).toHaveLength(CONCURRENCY_LEVELS.length);
      return;
    }

    const path = resolve(__dirname, '../../../docs/pilot/evidence/performance-results.json');
    await mkdir(dirname(path), { recursive: true });

    await writeFile(
      path,
      `${JSON.stringify(
        {
          note: 'Generated by apps/merchant-wallet-basic/src/performance.spec.ts. Do not edit by hand.',
          measures:
            "The pilot's payment path in one Node process against in-memory stores: validation, " +
            'limit consume, fee calculation, ledger posting, wallet balance derivation.',
          doesNotMeasure:
            'HTTP, TLS, JSON parsing, connection pooling, database round trips, network latency, ' +
            'or any real provider. A production p95 will be larger, dominated by the database and ' +
            'the network rather than by anything measured here.',
          environment: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            cpus: cpus().length,
            cpuModel: cpus()[0]?.model ?? 'unknown',
            totalMemoryGb: Number((totalmem() / 1_073_741_824).toFixed(1)),
          },
          paymentsPerUser: PAYMENTS_PER_USER,
          runs: measurements,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    expect(measurements).toHaveLength(CONCURRENCY_LEVELS.length);
  });
});
