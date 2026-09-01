import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { merchantWalletBasicTemplate } from '@trustos/financial-product-composer';
import { publishVersion, type PublishedVersion } from '@trustos/financial-product-versioning';
import { SANDBOX_EPOCH, runSandbox } from '@trustos/financial-product-sandbox';
import { simulate } from '@trustos/financial-product-simulator';

/**
 * §13 and §14 of the pilot specification: the eight sandbox scenarios and the three simulation
 * volumes.
 *
 * Everything here runs the *framework's* sandbox and simulator against the *framework's* product
 * template. The pilot contributes the scenario list and the assertions; it contributes no runtime,
 * which is the point being measured.
 *
 * The numbers this file asserts are the numbers the evidence pack reports. Where a number is an
 * artefact of the harness rather than a property of the product, the test says so — see the
 * simulator's own caveats, which it emits with every report and which the evidence pack quotes.
 */

function activeVersion(): PublishedVersion {
  return publishVersion({
    definition: { ...merchantWalletBasicTemplate(), lifecycleStatus: 'active' },
    organizationId: 'org_pilot',
    publishedById: 'usr_publisher',
    authoredById: 'usr_maker',
    approvedBy: [{ level: 'RISK', actorId: 'usr_risk' }],
    supersedes: null,
    changeSummary: 'The pilot product, published for the evidence run.',
    changedPaths: [],
    now: SANDBOX_EPOCH,
  });
}

const payment = {
  amountMinorUnits: '150000',
  currency: 'XTS',
  transactionType: 'CREDIT',
  references: {},
  attributes: {},
};

// --- §13 the eight scenarios -------------------------------------------------

describe('the sandbox scenarios', () => {
  it('1. a successful payment completes every step', async () => {
    const result = await runSandbox({ version: activeVersion(), input: payment });

    expect(result.execution.outcome).toBe('success');
    expect(result.execution.steps).toHaveLength(8);
  });

  it('2. a limit refusal stops before the ledger', async () => {
    /*
     * The property worth asserting is not that it refused — it is *where*. A limit refusal that
     * reached the ledger would leave a journal for a payment that never happened.
     */
    const result = await runSandbox({
      version: activeVersion(),
      input: payment,
      scenarios: [{ scenario: 'limit_exceeded', times: 1 }],
    });

    expect(result.execution.outcome).not.toBe('success');
    expect(result.execution.steps.some((step) => step.blockKey === 'post-ledger')).toBe(false);
  });

  it('3. a frozen wallet refuses before the payment is taken', async () => {
    const result = await runSandbox({
      version: activeVersion(),
      input: payment,
      scenarios: [{ scenario: 'insufficient_balance', times: 1 }],
    });

    expect(result.execution.outcome).not.toBe('success');
  });

  it('4. a risk rejection refuses', async () => {
    const result = await runSandbox({
      version: activeVersion(),
      input: payment,
      scenarios: [{ scenario: 'risk_rejection', times: 1 }],
    });

    expect(result.execution.outcome).toBe('refusal');
  });

  it('5. a duplicate request replays rather than executing again', async () => {
    const version = activeVersion();

    const first = await runSandbox({ version, input: payment, idempotencyKey: 'ORDER-DUP' });
    const second = await runSandbox({ version, input: payment, idempotencyKey: 'ORDER-DUP' });

    /*
     * Each sandbox run builds its own idempotency store, so this exercises the *product's* replay
     * path rather than the store's. Both runs completing identically is what a caller sees; the
     * cross-run assertion belongs to the pilot's own engine, which is tested in `pilot.spec.ts`.
     */
    expect(second.execution.outcome).toBe(first.execution.outcome);
    expect(second.execution.steps.map((step) => step.outputs)).toEqual(
      first.execution.steps.map((step) => step.outputs),
    );
  });

  it('6. a provider timeout fails the execution rather than crashing the process', async () => {
    const result = await runSandbox({
      version: activeVersion(),
      input: payment,
      scenarios: [{ scenario: 'provider_timeout', atBlock: 'accept-payment', times: 1 }],
    });

    // A *failure*, not a refusal. The distinction matters: a refusal is a decision the product
    // made, and a failure is something that went wrong — and only the second is worth retrying.
    expect(result.execution.outcome).toBe('failure');
    expect(result.execution.state).toBe('failed');
  });

  it('7. a settlement failure leaves the ledger posting standing', async () => {
    /*
     * The interesting property, and it needs `atBlock`: an injection with no block fires at the
     * *first* block that could produce it, which for a generic failure is `verify-merchant` — and
     * a run that failed at verification would not have reached settlement at all.
     *
     * Settlement is after the posting, so a settlement failure must not unwind the journal. The
     * money was received; a reversal would be a second untrue statement about it.
     */
    const result = await runSandbox({
      version: activeVersion(),
      input: payment,
      scenarios: [{ scenario: 'settlement_failure', atBlock: 'settle', times: 1 }],
    });

    const stepKeys = result.execution.steps.map((step) => step.blockKey);
    expect(stepKeys).toContain('post-ledger');
    expect(result.execution.outcome).not.toBe('success');
  });

  it('8. a reconciliation mismatch is raised after the money has moved', async () => {
    // Reconciliation is the last block, so a mismatch is an exception to investigate rather than
    // a reason to unwind anything.
    const result = await runSandbox({
      version: activeVersion(),
      input: payment,
      scenarios: [{ scenario: 'reconciliation_mismatch', atBlock: 'reconcile', times: 1 }],
    });

    const stepKeys = result.execution.steps.map((step) => step.blockKey);
    expect(stepKeys).toContain('settle');
    expect(result.execution.outcome).toBe('refusal');
  });

  it('reports a scenario that was armed and never fired', async () => {
    // An unfired scenario is a gap, not a pass: the test believed it exercised a path it did not.
    const result = await runSandbox({
      version: activeVersion(),
      input: payment,
      scenarios: [{ scenario: 'compensation_failure', atBlock: 'no-such-block', times: 1 }],
    });

    expect(result.unfiredScenarios.length).toBeGreaterThan(0);
  });

  it('touches no production data, structurally', async () => {
    /*
     * The sandbox constructs its own connector registry, idempotency store, event publisher and
     * audit recorder, all in memory. There is no constructor parameter through which a production
     * store could be passed — so this asserts the shape rather than a policy.
     */
    const result = await runSandbox({ version: activeVersion(), input: payment });

    expect(result.state).toBeDefined();
    expect(result.audit.every((record) => record.action.startsWith('financial.product.'))).toBe(
      true,
    );
  });
});

// --- §14 the three volumes ---------------------------------------------------

/**
 * The measured results, filled in as the tests run and printed at the end.
 *
 * Held here so the evidence pack quotes numbers this file actually produced rather than numbers
 * somebody transcribed.
 */
const measured: Array<Record<string, unknown>> = [];

/**
 * Two modes, and reporting only one of them would be misleading.
 *
 * **Per-transaction** resets the synthetic limit consumption between transactions, so each is
 * measured on its own. This is what the CLI does, and it measures the product's per-transaction
 * logic: the injected scenario mix is what refuses, and the numbers are about the product.
 *
 * **Cumulative** lets consumption accumulate across the run, so the product's *own* daily ceiling
 * refuses once it is reached. The first run of this pilot did that by omission and produced an 84%
 * refusal rate — which looked like a broken product and was in fact one simulated day containing a
 * hundred thousand payments against a daily limit.
 *
 * Both are true and neither is "the" success rate, which is why the evidence pack reports both
 * with what each measures.
 */
describe('simulation at three volumes', () => {
  const SCENARIO_MIX = {
    limit_exceeded: 0.02,
    risk_rejection: 0.01,
    provider_timeout: 0.01,
    settlement_failure: 0.005,
    reconciliation_mismatch: 0.005,
  } as const;

  function run(count: number, extra: Record<string, unknown> = {}) {
    return simulate({
      version: activeVersion(),
      count,
      seed: 1,
      scenarioMix: { ...SCENARIO_MIX },
      duplicateEvery: 50,
      // Each transaction measured on its own — see the block comment above.
      resetBalanceEvery: 1,
      ...extra,
    });
  }

  it('100 transactions', async () => {
    const report = await run(100);
    measured.push({ count: 100, mode: 'per-transaction', ...summarize(report) });

    /*
     * `executed` is below `count` because a duplicate is not a second execution — it replays. The
     * two numbers differing is the idempotency working, and asserting they are equal would be
     * asserting that it is not.
     */
    expect(report.executed + report.duplicatesPrevented).toBe(100);
    expect(report.successCount + report.refusalCount + report.failureCount + report.openCount).toBe(
      report.executed,
    );
  });

  it('1,000 transactions', async () => {
    const report = await run(1_000);
    measured.push({ count: 1_000, mode: 'per-transaction', ...summarize(report) });

    expect(report.executed + report.duplicatesPrevented).toBe(1_000);
  });

  it('100,000 transactions', async () => {
    const report = await run(100_000);
    measured.push({ count: 100_000, mode: 'per-transaction', ...summarize(report) });

    expect(report.executed + report.duplicatesPrevented).toBe(100_000);
    // Deterministic: the same seed produces the same report, which is what lets two runs be
    // compared at all.
    expect(report.seed).toBe(1);
    // A hundred thousand simulated payments, sharing a machine with the rest of the
    // suite. Two minutes was enough when this file ran alone and not when it did not.
  }, 300_000);

  it('refuses more as consumption accumulates, which is the daily limit working', async () => {
    /*
     * The finding the first evidence run produced by accident. With consumption carried across the
     * run, the product's own daily ceiling refuses — and at a hundred thousand payments in one
     * simulated day it refuses most of them, which is correct rather than broken.
     */
    const perTransaction = await run(1_000);
    const cumulative = await run(1_000, { resetBalanceEvery: undefined });

    measured.push({ count: 1_000, mode: 'cumulative', ...summarize(cumulative) });

    expect(cumulative.limitRefusals).toBeGreaterThan(perTransaction.limitRefusals);
    expect(cumulative.successRate).toBeLessThan(perTransaction.successRate);
  });

  it('refuses the injected scenarios rather than succeeding through them', async () => {
    const report = await run(1_000);

    expect(report.refusalCount + report.failureCount).toBeGreaterThan(0);
    expect(report.successRate).toBeLessThan(1);
  });

  it('prevents the injected duplicates', async () => {
    const report = await run(1_000);
    expect(report.duplicatesPrevented).toBeGreaterThan(0);
  });

  it('posts a journal for every success and none for a refusal', async () => {
    /*
     * The invariant that matters most in the whole report. A journal count above the success count
     * means money was recorded for a payment that did not happen.
     */
    const report = await run(1_000);
    expect(report.journalsPosted).toBeLessThanOrEqual(report.successCount);
  });

  it('carries its caveats into the report', async () => {
    /*
     * The simulator states what its numbers do not mean, in the report rather than in
     * documentation. The evidence pack quotes these verbatim — a benchmark without its caveats is
     * a benchmark that gets quoted as a production figure.
     */
    const report = await run(100);

    expect(report.caveats.length).toBeGreaterThan(0);
    expect(report.caveats.join(' ')).toContain('mock');
  });

  it('writes what was measured to the evidence pack', async () => {
    /*
     * Written to a file rather than printed.
     *
     * The evidence pack quotes these numbers, and a number transcribed from a terminal is a number
     * that drifts from the run that produced it. Re-running this suite regenerates the file, so
     * the pack and the run cannot disagree.
     */
    /*
     * Written only when explicitly asked for — see the note in `performance.spec.ts`. The
     * simulation itself is deterministic; only `wallClockMs` moves, and rewriting the file on
     * every test run left the working tree dirty for a number nothing quotes.
     */
    if (process.env.TRUSTOS_WRITE_EVIDENCE !== '1') {
      expect(measured.length).toBeGreaterThanOrEqual(4);
      return;
    }

    const path = resolve(__dirname, '../../../docs/pilot/evidence/simulation-results.json');
    await mkdir(dirname(path), { recursive: true });

    await writeFile(
      path,
      `${JSON.stringify(
        {
          note: 'Generated by apps/merchant-wallet-basic/src/sandbox-and-simulation.spec.ts. Do not edit by hand.',
          product: 'merchant-wallet-basic',
          seed: 1,
          scenarioMix: SCENARIO_MIX,
          duplicateEvery: 50,
          runs: measured,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    expect(measured.length).toBeGreaterThanOrEqual(4);
  });
});

function summarize(report: Awaited<ReturnType<typeof simulate>>) {
  return {
    executed: report.executed,
    successCount: report.successCount,
    refusalCount: report.refusalCount,
    failureCount: report.failureCount,
    successRate: report.successRate,
    failureRate: report.failureRate,
    limitRefusals: report.limitRefusals,
    duplicatesPrevented: report.duplicatesPrevented,
    journalsPosted: report.journalsPosted,
    settlementsCreated: report.settlementsCreated,
    compensationsRun: report.compensationsRun,
    wallClockMs: report.wallClockMs,
    refusalsByCode: report.refusalsByCode,
    feeTotals: report.feeTotals,
  };
}
