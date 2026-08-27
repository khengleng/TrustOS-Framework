import { describe, expect, it } from 'vitest';
import { runbookSchema, serviceSchema } from '@trustos/sre-core';
import { servicePostureSchema } from '@trustos/resilience';
import {
  assertRunnable,
  experimentResultSchema,
  experimentSchema,
  interpret,
  untestedFaults,
} from './index';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function experiment(overrides: Record<string, unknown> = {}) {
  return experimentSchema.parse({
    experimentId: 'ex.ledger-timeout',
    title: 'Ledger stops answering within its timeout',
    fault: 'dependency_timeout',
    targetServiceId: 'payments.api',
    targetDependencyId: 'ledger',
    targetDependencyKind: 'api',
    environment: 'staging',
    steadyStateHypothesis:
      'Payments continue to be refused cleanly with a 503 rather than accepted without a ledger entry, and the breaker opens within thirty seconds.',
    measuredBy: [
      'The count of payments accepted without a corresponding journal entry, which must stay at zero.',
      'The circuit breaker state, which must reach open.',
    ],
    blastRadius:
      'Every payment through the staging environment for the duration; no production traffic and no real merchants.',
    trafficFraction: 1,
    durationSeconds: 300,
    abortConditions: [
      'Any payment is accepted without a journal entry.',
      'Error rate on unrelated endpoints exceeds five percent.',
    ],
    abortProcedure:
      'Remove the fault injection rule from the mesh and confirm latency returns to baseline.',
    ownerId: 'usr_platform',
    ...overrides,
  });
}

const runbook = runbookSchema.parse({
  runbookId: 'rb.outage',
  title: 'Dependency outage',
  trigger: 'A critical dependency is unavailable for more than two minutes.',
  severityHint: 'SEV2',
  steps: [
    { title: 'Confirm', action: 'Probe the dependency from a second service.', verification: null },
  ],
  escalateTo: 'Platform on-call.',
  lastReviewedAt: '2026-05-01T00:00:00.000Z',
  ownerId: 'usr_platform',
});

function service(overrides: Record<string, unknown> = {}) {
  return serviceSchema.parse({
    serviceId: 'payments.api',
    name: 'Payments API',
    description: 'Accepts payment requests and posts them to the ledger.',
    tier: 'tier_1',
    ownerTeam: 'payments',
    onCallRotation: 'payments-primary',
    runbookIds: ['rb.outage'],
    environment: 'production',
    registeredAt: '2026-01-01T00:00:00.000Z',
    dependencies: [
      {
        dependencyId: 'ledger',
        kind: 'api',
        description: 'Posts a journal entry for every accepted payment.',
        critical: true,
        targetServiceId: null,
        degradedBehaviour: 'Payments are refused rather than accepted un-posted.',
        runbookId: 'rb.outage',
      },
    ],
    ...overrides,
  });
}

function posture(overrides: Record<string, unknown> = {}) {
  return servicePostureSchema.parse({
    serviceId: 'payments.api',
    callerTimeoutMs: 5_000,
    dependencies: [
      {
        dependencyId: 'ledger',
        kind: 'api',
        timeoutMs: 1_000,
        totalBudgetMs: 3_000,
        circuitBreaker: {},
        fallback: {
          mode: 'fail_fast',
          description:
            'Payments are refused with a 503 rather than accepted without a ledger entry.',
          businessImpact: 'Merchants cannot accept payments while the ledger is unavailable.',
          approvedBy: 'usr_product',
        },
      },
    ],
    reviewedAt: '2026-05-01T00:00:00.000Z',
    reviewedBy: 'usr_platform',
    ...overrides,
  });
}

function result(overrides: Record<string, unknown> = {}) {
  return experimentResultSchema.parse({
    experimentId: 'ex.ledger-timeout',
    runId: 'run_001',
    startedAt: '2026-06-01T12:00:00.000Z',
    endedAt: '2026-06-01T12:05:00.000Z',
    hypothesisHeld: true,
    aborted: false,
    observations: ['The breaker opened after 22 seconds and every payment was refused with a 503.'],
    findings: [],
    runBy: 'usr_platform',
    ...overrides,
  });
}

describe('what may never run against production', () => {
  it('refuses a destructive fault outright', () => {
    /*
     * Not a policy default a deployment adjusts. There is no correct value for "who may corrupt the
     * production ledger to see what happens", and offering the setting is how it gets set.
     */
    expect(() =>
      experiment({ fault: 'data_corruption', environment: 'production', approvedBy: 'usr_head' }),
    ).toThrow(/destructive and never runs against production/);
  });

  it('refuses it at run time too, with no override', () => {
    // The mistake this catches is a copied command line, not malice.
    const staged = experiment({ fault: 'data_deletion' });

    expect(() =>
      assertRunnable({ experiment: { ...staged, environment: 'production' }, at: NOW }),
    ).toThrow(/under any configuration/);
  });

  it('keeps database faults out of production as well', () => {
    // The same thing is learned in staging, where a restart loop costs nobody a payment.
    expect(() =>
      experiment({
        fault: 'database_unavailable',
        environment: 'production',
        approvedBy: 'usr_head',
      }),
    ).toThrow(/use staging/);
  });

  it('permits a dependency timeout in production, with approval', () => {
    const approved = experiment({
      environment: 'production',
      approvedBy: 'usr_head',
      approvedAt: '2026-05-30T00:00:00.000Z',
    });

    expect(() => assertRunnable({ experiment: approved, at: NOW })).not.toThrow();
  });
});

describe('approval', () => {
  it('requires a person, not a flag', () => {
    expect(() => experiment({ environment: 'production' })).toThrow(/Not a flag — a person/);
  });

  it('refuses an owner approving their own production run', () => {
    // The same separation the framework applies to every other consequential action.
    const selfApproved = experiment({
      environment: 'production',
      approvedBy: 'usr_platform',
      approvedAt: '2026-05-30T00:00:00.000Z',
    });

    expect(() => assertRunnable({ experiment: selfApproved, at: NOW })).toThrow(
      /does not approve their own/,
    );
  });

  it('does not require approval outside production', () => {
    expect(() => assertRunnable({ experiment: experiment(), at: NOW })).not.toThrow();
  });
});

describe('when an experiment may not start', () => {
  it('refuses while an incident is open', () => {
    /*
     * A fault injected now is indistinguishable from the incident in the timeline afterwards, and
     * the two get confused with each other during exactly the investigation that needs clarity.
     */
    expect(() => assertRunnable({ experiment: experiment(), at: NOW, activeIncidents: 1 })).toThrow(
      /indistinguishable from the incident/,
    );
  });

  it('refuses a fault against a dependency the service does not declare', () => {
    expect(() =>
      assertRunnable({
        experiment: experiment({ targetDependencyId: 'redis' }),
        service: service(),
        at: NOW,
      }),
    ).toThrow(/not runnable/);
  });

  it('refuses an experiment that would only confirm nothing is in place', () => {
    // Which a posture review establishes without injecting a fault at all.
    expect(() =>
      assertRunnable({
        experiment: experiment(),
        service: service(),
        posture: posture({ dependencies: [] }),
        at: NOW,
      }),
    ).toThrow(/not runnable/);
  });

  it('permits one against a declared, protected dependency', () => {
    expect(() =>
      assertRunnable({ experiment: experiment(), service: service(), posture: posture(), at: NOW }),
    ).not.toThrow();
  });
});

describe('defining an experiment', () => {
  it('requires abort conditions', () => {
    /*
     * An experiment that cannot say what "too far" looks like has no way to stop, and the person
     * watching decides under time pressure whether what they see is the experiment working or an
     * incident starting.
     */
    expect(() => experiment({ abortConditions: [] })).toThrow();
  });

  it('requires a stated hypothesis', () => {
    // Without one, the result is whatever the observer concluded, which is always that it coped.
    expect(() =>
      experimentSchema.parse({ ...experiment(), steadyStateHypothesis: 'it works' }),
    ).toThrow();
  });

  it('requires a dependency fault to name its dependency', () => {
    expect(() => experiment({ targetDependencyId: null })).toThrow(
      /names the dependency it faults/,
    );
  });

  it('requires a blast radius stated before the run', () => {
    // The honest answer is often larger than expected, and writing it down is the cheap way to find out.
    expect(experiment().blastRadius).toContain('no production traffic');
  });
});

describe('interpreting a result', () => {
  it('states a held hypothesis as the weak result it is', () => {
    /*
     * One fault, one duration, one traffic fraction. "The system is resilient" is not something a
     * single experiment can establish, and the wording refuses to imply it.
     */
    const interpretation = interpret({ experiment: experiment(), result: result() });

    expect(interpretation.learned).toContain('not a statement about the system');
    expect(interpretation.actionable).toBe(false);
  });

  it('treats an abort as the safety mechanism working', () => {
    const interpretation = interpret({
      experiment: experiment(),
      result: result({
        aborted: true,
        abortReason: 'A payment was accepted with no journal entry within the first minute.',
        hypothesisHeld: false,
      }),
    });

    expect(interpretation.learned).toContain('abort mechanism worked');
    expect(interpretation.actionable).toBe(true);
  });

  it('requires an aborted run to say which condition fired', () => {
    expect(() => result({ aborted: true })).toThrow(/which condition fired/);
  });

  it('reports a broken hypothesis with what was seen', () => {
    const interpretation = interpret({
      experiment: experiment(),
      result: result({
        hypothesisHeld: false,
        observations: [
          'Four payments were accepted with no journal entry before the breaker opened.',
        ],
      }),
    });

    expect(interpretation.learned).toContain('did not hold');
    expect(interpretation.learned).toContain('Four payments');
  });
});

describe('what has never been tested', () => {
  it('lists the non-destructive faults nobody has run', () => {
    const untested = untestedFaults({
      serviceId: 'payments.api',
      experiments: [experiment()],
      results: [result()],
    });

    expect(untested).not.toContain('dependency_timeout');
    expect(untested).toContain('queue_backlog');
  });

  it('never suggests a destructive one', () => {
    const untested = untestedFaults({ serviceId: 'payments.api', experiments: [], results: [] });

    expect(untested).not.toContain('data_deletion');
    expect(untested).not.toContain('data_corruption');
  });

  it('does not count an experiment that was defined and never run', () => {
    const untested = untestedFaults({
      serviceId: 'payments.api',
      experiments: [experiment()],
      results: [],
    });
    expect(untested).toContain('dependency_timeout');
  });
});
