import { describe, expect, it } from 'vitest';
import { CurrencyRegistry, money } from '@trustos/financial-core';
import { RiskAssessor, combine, describeAssessment, type RiskProvider } from './risk';
import { KYC_LEVELS, describeCoverage, kycSatisfies, kycStatusSchema } from './compliance';

/**
 * The tests that matter are about what happens when a provider says nothing.
 *
 * A sanctions provider that times out has told you nothing, and treating silence as clearance is
 * how a screened platform stops being one — silently, and only discovered by an examiner.
 */

const currencies = new CurrencyRegistry();
const clock = new Date('2026-03-01T09:00:00.000Z');

const context = {
  organizationId: 'org_a' as string | null,
  amount: money('100.00', 'USD', currencies),
  type: 'payment',
  sourceWalletId: 'wlt_1',
  destinationWalletId: null,
  actorId: 'usr_1',
  reference: 'ORD-1',
  at: clock,
};

const provider = (
  name: string,
  score: number,
  options: { decisive?: boolean; kind?: 'sanctions' | 'fraud' | 'velocity' } = {},
): RiskProvider => ({
  name,
  kind: options.kind ?? 'fraud',
  assess: async () => ({
    kind: options.kind ?? 'fraud',
    source: name,
    score,
    detail: `${name} scored ${score}.`,
    decisive: options.decisive ?? false,
  }),
});

describe('combining signals', () => {
  it('takes the highest, not the average', () => {
    /*
     * Risk does not dilute. A sanctions match at 100 alongside three clean checks at 0 is still a
     * sanctions match, and an average would report 25.
     */
    const result = combine(
      [
        { kind: 'sanctions', source: 'a', score: 100, detail: 'match', decisive: false },
        { kind: 'fraud', source: 'b', score: 0, detail: 'clean', decisive: false },
        { kind: 'velocity', source: 'c', score: 0, detail: 'clean', decisive: false },
      ],
      50,
      85,
    );

    expect(result.score).toBe(100);
    expect(result.decision).toBe('decline');
  });

  it('lets a decisive signal decline outright', () => {
    // Otherwise three weak signals could outvote one that legally cannot be overridden.
    const result = combine(
      [{ kind: 'sanctions', source: 'ofac', score: 60, detail: 'name match', decisive: true }],
      50,
      85,
    );

    expect(result.decision).toBe('decline');
    expect(result.reason).toMatch(/ofac \(sanctions\): name match/);
  });

  it('routes a middling score to review', () => {
    const result = combine(
      [
        {
          kind: 'velocity',
          source: 'v',
          score: 60,
          detail: 'five in ten minutes',
          decisive: false,
        },
      ],
      50,
      85,
    );

    expect(result.decision).toBe('review');
  });

  it('approves a clean set', () => {
    const result = combine(
      [{ kind: 'fraud', source: 'f', score: 10, detail: 'clean', decisive: false }],
      50,
      85,
    );

    expect(result.decision).toBe('approve');
    expect(result.reason).toBeNull();
  });
});

describe('the assessor', () => {
  it('says nothing was checked when no provider is wired', async () => {
    /*
     * Approve, and record that nothing was checked. Declining everything makes an unwired
     * framework useless; implying something was screened is worse.
     */
    const assessment = await new RiskAssessor({ now: () => clock }).assess(context);

    expect(assessment.decision).toBe('approve');
    expect(assessment.reason).toMatch(/No risk providers are configured, so nothing was checked/);
  });

  it('runs providers concurrently', async () => {
    let concurrent = 0;
    let peak = 0;

    const slow = (name: string): RiskProvider => ({
      name,
      kind: 'fraud',
      assess: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent -= 1;
        return { kind: 'fraud' as const, source: name, score: 0, detail: 'clean', decisive: false };
      },
    });

    await new RiskAssessor({
      providers: [slow('a'), slow('b'), slow('c')],
      now: () => clock,
    }).assess(context);

    expect(peak).toBe(3);
  });

  it('treats a provider failure as review, not as clearance', async () => {
    // Silence is not clearance.
    const failing: RiskProvider = {
      name: 'sanctions-provider',
      kind: 'sanctions',
      assess: async () => {
        throw new Error('The provider is down.');
      },
    };

    const assessment = await new RiskAssessor({
      providers: [failing],
      now: () => clock,
    }).assess(context);

    expect(assessment.decision).toBe('review');
    expect(assessment.signals[0]!.detail).toMatch(/Silence is not clearance/);
  });

  it('lets a deployment choose to decline on failure', async () => {
    const failing: RiskProvider = {
      name: 'sanctions-provider',
      kind: 'sanctions',
      assess: async () => {
        throw new Error('down');
      },
    };

    const assessment = await new RiskAssessor({
      providers: [failing],
      onProviderFailure: 'decline',
      now: () => clock,
    }).assess(context);

    expect(assessment.decision).toBe('decline');
  });

  it('lets a deployment ignore a non-decisive provider’s failure, deliberately', async () => {
    const failing: RiskProvider = {
      name: 'device-fingerprint',
      kind: 'device',
      assess: async () => {
        throw new Error('down');
      },
    };

    const assessment = await new RiskAssessor({
      providers: [failing],
      onProviderFailure: 'approve',
      now: () => clock,
    }).assess(context);

    expect(assessment.decision).toBe('approve');
    expect(assessment.signals).toEqual([]);
  });

  it('does not let a hanging provider hang the payment', async () => {
    const hanging: RiskProvider = {
      name: 'slow-provider',
      kind: 'fraud',
      assess: () => new Promise(() => {}),
    };

    const assessment = await new RiskAssessor({
      providers: [hanging],
      timeoutMs: 20,
      now: () => clock,
    }).assess(context);

    expect(assessment.decision).toBe('review');
    expect(assessment.signals[0]!.detail).toMatch(/did not answer/);
  });

  it('names every provider that ran, including the clean ones', async () => {
    // A compliance answer to "was this screened" needs the list of what ran, not only what fired.
    const assessment = await new RiskAssessor({
      providers: [provider('sanctions', 0, { kind: 'sanctions' }), provider('fraud-engine', 30)],
      now: () => clock,
    }).assess(context);

    expect(describeAssessment(assessment, context)).toMatch(/sanctions=0 fraud-engine=30/);
  });

  it('declines above the decline threshold', async () => {
    const assessment = await new RiskAssessor({
      providers: [provider('fraud-engine', 90)],
      now: () => clock,
    }).assess(context);

    expect(assessment.decision).toBe('decline');
  });
});

describe('KYC', () => {
  const status = (overrides: Record<string, unknown> = {}) =>
    kycStatusSchema.parse({
      subjectId: 'usr_1',
      organizationId: 'org_a',
      level: 'verified',
      verifiedBy: 'provider-x',
      verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: clock,
      ...overrides,
    });

  it('accepts a level at or above what is required', () => {
    expect(kycSatisfies(status({ level: 'enhanced' }), 'verified', clock).ok).toBe(true);
    expect(kycSatisfies(status({ level: 'basic' }), 'verified', clock).ok).toBe(false);
  });

  it('refuses expired verification rather than treating it as valid', () => {
    /*
     * The quiet failure: the record says "verified", the date says two years ago, and nothing
     * notices until an examiner does.
     */
    const result = kycSatisfies(
      status({ expiresAt: new Date('2026-02-01T00:00:00.000Z') }),
      'verified',
      clock,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/Verification expired/);
  });

  it('refuses a sanctioned subject whatever their level', () => {
    const result = kycSatisfies(status({ level: 'enhanced', sanctioned: true }), 'basic', clock);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/sanctioned/);
  });

  it('needs no record when nothing is required', () => {
    expect(kycSatisfies(null, 'none', clock).ok).toBe(true);
  });

  it('says so when there is no record and one is required', () => {
    const result = kycSatisfies(null, 'verified', clock);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/No KYC record/);
  });

  it('orders the levels', () => {
    expect(KYC_LEVELS).toEqual(['none', 'basic', 'verified', 'enhanced']);
  });
});

describe('compliance coverage', () => {
  it('reports an empty configuration as empty rather than as clean', () => {
    /*
     * "Nothing was flagged" and "nothing was checked" look identical on a dashboard, and the
     * difference is the whole question.
     */
    const coverage = describeCoverage({});

    expect(coverage[0]).toMatch(/KYC: not wired — no verification is checked/);
    expect(coverage[1]).toMatch(/Travel rule: not wired/);
    expect(coverage[2]).toMatch(/Suspicious activity: not wired/);
    expect(coverage[3]).toMatch(/Regulatory export: none configured/);
  });

  it('names what is wired', () => {
    const coverage = describeCoverage({
      kyc: { name: 'provider-x', status: async () => null },
      exporters: [
        {
          name: 'ctr',
          description: 'Currency transaction report',
          export: async () => ({ contentType: 'text/csv', filename: 'x.csv', body: '' }),
        },
      ],
    });

    expect(coverage[0]).toBe('KYC: provider-x');
    expect(coverage[3]).toBe('Regulatory export: ctr.');
  });
});
