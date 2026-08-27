import { describe, expect, it } from 'vitest';
import { merchantWalletBasicTemplate } from '@trustos/financial-product-composer';
import { publishVersion, type PublishedVersion } from '@trustos/financial-product-versioning';
import { formatReport, simulate } from './index';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function version(): PublishedVersion {
  return publishVersion({
    definition: { ...merchantWalletBasicTemplate(), lifecycleStatus: 'active' },
    organizationId: 'org_sandbox',
    publishedById: 'usr_publisher',
    authoredById: 'usr_maker',
    approvedBy: [{ level: 'RISK', actorId: 'usr_risk' }],
    supersedes: null,
    changeSummary: 'The worked example, published for the simulator suite.',
    changedPaths: [],
    now: NOW,
  });
}

describe('a small simulation', () => {
  it('runs the requested number of transactions', async () => {
    const report = await simulate({ version: version(), count: 10, seed: 1, resetBalanceEvery: 1 });

    expect(report.requested).toBe(10);
    expect(report.executed).toBe(10);
    expect(report.successCount + report.refusalCount + report.failureCount + report.openCount).toBe(10);
  });

  it('produces the same report from the same seed', async () => {
    // The first thing anybody does with a simulator is run it twice.
    const first = await simulate({ version: version(), count: 50, seed: 42, resetBalanceEvery: 1 });
    const second = await simulate({ version: version(), count: 50, seed: 42, resetBalanceEvery: 1 });

    expect(second.successCount).toBe(first.successCount);
    expect(second.pathDistribution).toEqual(first.pathDistribution);
    expect(second.feeTotals).toEqual(first.feeTotals);
  });

  it('produces a different report from a different seed', async () => {
    const first = await simulate({ version: version(), count: 200, seed: 1, resetBalanceEvery: 1 });
    const second = await simulate({ version: version(), count: 200, seed: 2, resetBalanceEvery: 1 });

    expect(second.feeTotals).not.toEqual(first.feeTotals);
  });

  it('reports the path distribution, which is the measure worth simulating for', async () => {
    const report = await simulate({
      version: version(),
      count: 100,
      seed: 7,
      amountRange: { minMinorUnits: '100', maxMinorUnits: '400000' },
      resetBalanceEvery: 1,
    });

    expect(report.pathDistribution.length).toBeGreaterThan(0);
    expect(report.pathDistribution[0]?.proportion).toBeGreaterThan(0);
    expect(report.pathDistribution.reduce((total, entry) => total + entry.count, 0)).toBe(100);
  });

  it('separates refusals from failures in the state distribution', async () => {
    const report = await simulate({
      version: version(),
      count: 100,
      seed: 3,
      scenarioMix: { limit_exceeded: 0.2, provider_failure: 0.1 },
      resetBalanceEvery: 1,
    });

    expect(report.refusalCount).toBeGreaterThan(0);
    expect(report.failureCount).toBeGreaterThan(0);
    // A product enforcing its limits correctly is not a product that is broken.
    expect(report.byState.refused).toBeGreaterThan(0);
    expect(report.refusalsByCode.some((entry) => entry.code === 'limit_exceeded')).toBe(true);
  });

  it('counts reviews as open rather than as successes', async () => {
    const report = await simulate({
      version: version(),
      count: 50,
      seed: 5,
      scenarioMix: { review_required: 1 },
      resetBalanceEvery: 1,
    });

    expect(report.reviewsRequired).toBe(50);
    expect(report.successCount).toBe(0);
    expect(report.openCount).toBe(50);
  });

  it('counts a replayed duplicate once, not twice', async () => {
    const report = await simulate({
      version: version(),
      count: 20,
      seed: 11,
      duplicateEvery: 2,
      resetBalanceEvery: 1,
    });

    // Counting a replay as a second transaction would compute the success rate over the wrong
    // denominator.
    expect(report.executed).toBeLessThan(report.requested);
    expect(report.duplicatesPrevented).toBeGreaterThan(0);
  });

  it('states its caveats rather than leaving them implied', async () => {
    const report = await simulate({ version: version(), count: 5, seed: 1, resetBalanceEvery: 1 });

    expect(report.caveats.some((caveat) => caveat.includes('mock that returns immediately'))).toBe(true);
    expect(report.caveats.some((caveat) => caveat.includes('not a reliability estimate'))).toBe(true);
  });

  it('formats a report a person can read', async () => {
    const report = await simulate({ version: version(), count: 10, seed: 1, resetBalanceEvery: 1 });
    const lines = formatReport(report);

    expect(lines[0]).toContain('merchant-wallet-basic@1.0.0');
    expect(lines.some((line) => line.includes('path distribution'))).toBe(true);
    expect(lines.some((line) => line.includes('caveats'))).toBe(true);
  });
});

describe('at volume', () => {
  it('runs a thousand transactions', async () => {
    const report = await simulate({ version: version(), count: 1000, seed: 99, resetBalanceEvery: 1 });

    expect(report.executed).toBe(1000);
    expect(report.journalsPosted).toBeGreaterThan(0);
  }, 30_000);

  it('runs a hundred thousand transactions', async () => {
    // The number section 16 asks for. It is here because a simulator that cannot run it is a
    // simulator whose claim to run it is untested.
    const report = await simulate({
      version: version(),
      count: 100_000,
      seed: 2026,
      amountRange: { minMinorUnits: '100', maxMinorUnits: '600000' },
      scenarioMix: { provider_timeout: 0.01, risk_rejection: 0.02 },
      resetBalanceEvery: 1,
    });

    expect(report.executed).toBe(100_000);
    expect(report.successCount + report.refusalCount + report.failureCount + report.openCount).toBe(
      100_000,
    );
    expect(report.pathDistribution.length).toBeGreaterThan(1);
    expect(report.wallClockMs).toBeGreaterThan(0);
  }, 300_000);
});
