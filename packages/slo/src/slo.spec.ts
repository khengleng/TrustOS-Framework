import { describe, expect, it } from 'vitest';
import {
  aggregate,
  sliDefinitionSchema,
  sliMeasurementSchema,
  sufficientToJudge,
} from '@trustos/sli';
import {
  burnAlert,
  burnRate,
  errorBudget,
  evaluateSlo,
  sloSchema,
  validateObjective,
} from './index';

function slo(overrides: Record<string, unknown> = {}) {
  return sloSchema.parse({
    sloId: 'payments.api.availability',
    serviceId: 'payments.api',
    sliId: 'payments.api.availability',
    name: 'Payments API availability',
    target: 99.9,
    windowDays: 30,
    status: 'pilot',
    ownerTeam: 'payments',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function value(good: number, valid: number) {
  return aggregate([
    sliMeasurementSchema.parse({
      sliId: 'payments.api.availability',
      windowStart: '2026-06-01T00:00:00.000Z',
      windowEnd: '2026-06-30T00:00:00.000Z',
      goodEvents: good,
      validEvents: valid,
    }),
  ]);
}

function indicator(overrides: Record<string, unknown> = {}) {
  return sliDefinitionSchema.parse({
    sliId: 'payments.api.availability',
    serviceId: 'payments.api',
    kind: 'availability',
    name: 'Payments API availability',
    goodEventDefinition: 'An HTTP request answered with a status below 500 within the timeout.',
    validEventDefinition: 'Every authenticated request that reached the service.',
    source: 'ingress access logs',
    ...overrides,
  });
}

describe('defining an objective', () => {
  it('requires a stated policy for an exhausted budget', () => {
    // Deciding what an exhausted budget means during the incident is how nothing gets decided.
    expect(() =>
      slo({
        budgetPolicies: [
          {
            consumedAtLeast: 0,
            state: 'healthy',
            actions: ['notify_service_owner'],
            rationale: 'The budget is intact and the team may spend it.',
          },
        ],
      }),
    ).toThrow(/exhausted/);
  });

  it('requires a policy that applies from zero', () => {
    expect(() =>
      slo({
        budgetPolicies: [
          {
            consumedAtLeast: 0.5,
            state: 'exhausted',
            actions: ['stop_risky_rollout'],
            rationale: 'Half the budget is gone and shipping risk spends the rest.',
          },
        ],
      }),
    ).toThrow(/from zero/);
  });

  it('defaults to pilot rather than to a commitment', () => {
    // The specification is emphatic: a measured objective is not a promise until somebody says so.
    expect(sloSchema.parse({ ...slo(), status: undefined }).status).toBe('pilot');
  });
});

describe('the error budget', () => {
  it('counts what the objective permits and what was spent', () => {
    const budget = errorBudget(slo(), value(99_950, 100_000));

    expect(budget?.allowedBadEvents).toBe(100);
    expect(budget?.badEvents).toBe(50);
    expect(budget?.state).toBe('healthy');
  });

  it('warns before it is gone', () => {
    // 80 of 100 permitted failures — the point of a warning state is that it precedes the miss.
    expect(errorBudget(slo(), value(99_920, 100_000))?.state).toBe('warning');
  });

  it('reports overspend rather than clamping at exhausted', () => {
    /*
     * Consumption above 1 is kept. "140% of the budget" tells a team how far past the objective it
     * is, which is the number that decides whether this is a conversation or a postmortem.
     */
    const budget = errorBudget(slo(), value(99_860, 100_000));

    expect(budget?.consumed).toBeGreaterThan(1);
    expect(budget?.state).toBe('exhausted');
    expect(budget?.remainingBadEvents).toBe(0);
  });

  it('recommends actions and says why', () => {
    const budget = errorBudget(slo(), value(99_000, 100_000));

    expect(budget?.actions).toContain('require_incident_review');
    expect(budget?.rationale).toContain('already been missed');
  });

  it('never recommends stopping production traffic', () => {
    /*
     * The framework's position. Every default action is reversible and leaves a human deciding;
     * an automatic production halt is disabled after the first false positive, and then the whole
     * mechanism protects nothing.
     */
    const budget = errorBudget(slo(), value(0, 100_000));

    expect(budget?.actions.every((action) => action !== ('halt_production' as never))).toBe(true);
    expect(budget?.actions).toContain('pause_nonessential_deployment');
  });

  it('has no budget for an unmeasured window', () => {
    expect(errorBudget(slo(), value(0, 0))).toBeNull();
  });
});

describe('evaluating', () => {
  function judge(good: number, valid: number, objective = slo()) {
    const measured = value(good, valid);
    return evaluateSlo(
      objective,
      measured,
      sufficientToJudge(measured, { objectivePercentage: objective.target }),
    );
  }

  it('reports a met objective', () => {
    expect(judge(99_950, 100_000).verdict).toBe('met');
  });

  it('reports a missed one', () => {
    expect(judge(99_000, 100_000).verdict).toBe('missed');
  });

  it('refuses to call a thin window met', () => {
    /*
     * Four requests all night, all successful, against a 99.9% objective. Reporting "met" there
     * is technically true and completely misleading, and it is the specification's "do not claim
     * compliance unless actual metrics support it" as a verdict.
     */
    const status = judge(4, 4);

    expect(status.verdict).toBe('insufficient_data');
    expect(status.measured).toBe(100);
  });

  it('marks a pilot objective as not a commitment', () => {
    expect(judge(99_950, 100_000).isCommitment).toBe(false);
    expect(judge(99_950, 100_000, slo({ status: 'committed' })).isCommitment).toBe(true);
  });
});

describe('burn rate', () => {
  it('is one when failure exactly matches the allowance', () => {
    expect(burnRate({ slo: slo(), value: value(99_900, 100_000), observedHours: 720 })).toBe(1);
  });

  it('rises with the failure rate', () => {
    // 1% failure against a 0.1% allowance: ten times the sustainable rate.
    expect(burnRate({ slo: slo(), value: value(99_000, 100_000), observedHours: 1 })).toBe(10);
  });

  it('pages on a fast burn', () => {
    /*
     * Why burn rate rather than a consumption threshold: at 14.4× a thirty-day budget is gone in
     * two hours. A threshold alert fires once the damage is done; this fires while it is happening.
     */
    expect(burnAlert({ fastBurn: 20, slowBurn: 1 }).severity).toBe('page');
  });

  it('raises a ticket on a slow bleed', () => {
    expect(burnAlert({ fastBurn: 1, slowBurn: 4 }).severity).toBe('ticket');
  });

  it('is quiet within the sustainable rate', () => {
    expect(burnAlert({ fastBurn: 1.1, slowBurn: 0.9 }).severity).toBe('none');
  });

  it('has no rate for an unmeasured window', () => {
    expect(burnRate({ slo: slo(), value: value(0, 0), observedHours: 24 })).toBeNull();
  });
});

describe('validating an objective before it is committed', () => {
  it('accepts a coherent one', () => {
    expect(validateObjective({ slo: slo(), tier: 'tier_1', indicator: indicator() }).valid).toBe(
      true,
    );
  });

  it('rejects a target of 100%', () => {
    // No budget means every deployment is a violation, and an objective nobody can meet is ignored.
    const result = validateObjective({
      slo: slo({ target: 100 }),
      tier: 'tier_1',
      indicator: indicator(),
    });
    expect(result.problems.join(' ')).toContain('no budget');
  });

  it('rejects a tier-1 commitment below what tier 1 means', () => {
    const result = validateObjective({
      slo: slo({ target: 99, status: 'committed' }),
      tier: 'tier_1',
      indicator: indicator(),
    });

    expect(result.valid).toBe(false);
  });

  it('permits the same target as a pilot', () => {
    // Measuring where you actually are is how you find out whether the commitment is reachable.
    const result = validateObjective({
      slo: slo({ target: 99 }),
      tier: 'tier_1',
      indicator: indicator(),
    });

    expect(result.valid).toBe(true);
  });

  it('rejects an objective written against an indicator that counts bad events', () => {
    /*
     * "error_rate >= 99.9%" reads plausibly and means the opposite of what the author intended.
     * The direction is a property of the indicator kind, so this is catchable rather than a
     * matter of review attention.
     */
    const result = validateObjective({
      slo: slo(),
      tier: 'tier_1',
      indicator: indicator({ kind: 'error_rate' }),
    });

    expect(result.problems.join(' ')).toContain('inverts it');
  });

  it('rejects an objective and indicator describing different services', () => {
    const result = validateObjective({
      slo: slo(),
      tier: 'tier_1',
      indicator: indicator({ serviceId: 'ledger.api' }),
    });

    expect(result.valid).toBe(false);
  });
});
