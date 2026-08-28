import { describe, expect, it } from 'vitest';
import {
  DR_SCENARIOS,
  assertActivatable,
  capabilityStatement,
  drPlanSchema,
  readinessOf,
  reviewPlans,
} from './index';

function exercise(overrides: Record<string, unknown> = {}) {
  return {
    exerciseId: 'ex_20260401',
    performedAt: '2026-04-01T00:00:00.000Z',
    kind: 'full',
    achievedMinutes: 42,
    succeeded: true,
    findings: [
      'The DNS change took eleven minutes to propagate, which the plan assumed was instant.',
    ],
    evidenceRef: 'docs/dr/evidence/2026-04-01-region-failover.md',
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return drPlanSchema.parse({
    planId: 'dr.region-failure',
    scenario: 'region_failure',
    title: 'Primary region unavailable',
    trigger:
      'Every instance in the primary region fails readiness for more than ten minutes and the provider status page confirms a regional event.',
    serviceIds: ['payments.api'],
    ownerId: 'usr_platform',
    decisionAuthority: 'Head of Platform',
    deputyAuthority: 'On-call platform lead',
    procedure: [
      {
        title: 'Confirm the region is genuinely unavailable',
        action:
          'Probe from a second region and check the provider status page before failing over.',
        verification: 'Two independent probes and the status page agree.',
        performedBy: 'Platform on-call',
      },
    ],
    recoveryProcedureIds: ['rp.postgres-full'],
    dataDecision:
      'Fail over to the standby at its last confirmed replication position; writes after that position are replayed from the event log.',
    communication: {
      audiences: ['Merchants with active integrations', 'Internal operations', 'Executive team'],
      channels: [
        'Status page hosted outside the primary region',
        'Direct email to technical contacts',
      ],
      spokespersonRole: 'Head of Platform',
      cadenceMinutes: 30,
    },
    validation: [
      'A synthetic payment completes end to end against the recovered region.',
      'The ledger balances against the last pre-failover close.',
    ],
    failback: {
      procedure:
        'Once the primary region is confirmed healthy, resynchronize from the secondary, verify balance, and cut back during a scheduled window.',
      dataReconciliation:
        'Writes made during the failover are replayed into the primary and reconciled against the ledger before cutover.',
      decisionAuthority: 'Head of Platform, with the finance controller for the ledger position',
    },
    rtoMinutes: 60,
    rpoMinutes: 5,
    lastReviewedAt: '2026-04-15T00:00:00.000Z',
    exercises: [exercise()],
    ...overrides,
  });
}

describe('writing a plan', () => {
  it('requires a deputy who is not the authority', () => {
    /*
     * The authority is unreachable during exactly the events this covers — that is what "disaster"
     * means — and a plan whose authority is one person is a plan that waits for them.
     */
    expect(() => plan({ deputyAuthority: 'Head of Platform' })).toThrow(/waits for one person/);
  });

  it('requires a data decision for a corruption scenario', () => {
    /*
     * "Restore the latest backup" is the wrong answer for corruption and compromise, and the reason
     * it is wrong takes a paragraph that nobody writes during the incident.
     */
    expect(() => plan({ scenario: 'database_corruption', dataDecision: null })).toThrow(
      /recovery point is chosen/,
    );
  });

  it('names the trap for a credential compromise', () => {
    const error = (() => {
      try {
        plan({ scenario: 'credential_compromise', dataDecision: null });
        return '';
      } catch (thrown) {
        return String(thrown);
      }
    })();

    expect(error).toContain('restores whatever the attacker did');
  });

  it('requires a failback with data reconciliation', () => {
    // Failing over is half of it; the way back is harder because the two sides have diverged.
    expect(() => drPlanSchema.parse({ ...plan(), failback: undefined })).toThrow();
  });

  it('requires a communication cadence', () => {
    // Silence during a region failure is read as nobody working on it, and generates a second incident.
    expect(plan().communication.cadenceMinutes).toBe(30);
  });

  it('does not default the targets', () => {
    // The specification is explicit: do not invent targets. The owner sets them or the plan fails to parse.
    expect(() => drPlanSchema.parse({ ...plan(), rtoMinutes: undefined })).toThrow();
  });
});

describe('what can be claimed', () => {
  it('states a full exercise with its measured duration', () => {
    const readiness = readinessOf(plan());

    expect(readiness.exercisedFully).toBe(true);
    expect(readiness.meetsRto).toBe(true);
    expect(readiness.statement).toContain('42 minutes');
  });

  it('says a tabletop is a walkthrough, not a run', () => {
    /*
     * "DR tested" covering a meeting is how a readiness scorecard becomes fiction. The statement is
     * written to be quoted, so it has to be careful.
     */
    const readiness = readinessOf(
      plan({ exercises: [exercise({ kind: 'tabletop', achievedMinutes: null })] }),
    );

    expect(readiness.exercisedFully).toBe(false);
    expect(readiness.statement).toContain('walked through, not run');
  });

  it('says nothing is known when nothing was exercised', () => {
    expect(readinessOf(plan({ exercises: [] })).statement).toContain('Nothing is known');
  });

  it('does not claim an RTO from an exercise that recorded no duration', () => {
    const readiness = readinessOf(plan({ exercises: [exercise({ achievedMinutes: null })] }));

    expect(readiness.meetsRto).toBeNull();
    expect(readiness.statement).toContain('unverified');
  });

  it('takes the slowest full exercise', () => {
    // The same reasoning as the measured restore time: the slow run is the one that matters.
    const readiness = readinessOf(
      plan({ exercises: [exercise(), exercise({ exerciseId: 'ex_2', achievedMinutes: 75 })] }),
    );

    expect(readiness.achievedMinutes).toBe(75);
    expect(readiness.meetsRto).toBe(false);
  });
});

describe('activation', () => {
  it('refuses a plan nobody has ever run', () => {
    expect(() => assertActivatable({ plan: plan({ exercises: [] }) })).toThrow(
      /never been exercised/,
    );
  });

  it('permits an override with a recorded reason', () => {
    /*
     * A refusal with no override would be worked around outside the system, and the record — which
     * is the only reason this package exists — would be lost with it.
     */
    expect(() =>
      assertActivatable({
        plan: plan({ exercises: [] }),
        force: {
          by: 'usr_platform_head',
          reason:
            'The primary region has been down for forty minutes and no exercised alternative exists.',
        },
      }),
    ).not.toThrow();
  });

  it('refuses an override with no real reason', () => {
    expect(() =>
      assertActivatable({
        plan: plan({ exercises: [] }),
        force: { by: 'usr_platform_head', reason: 'needed' },
      }),
    ).toThrow(/read sensibly in the review/);
  });

  it('permits an exercised plan without ceremony', () => {
    expect(() => assertActivatable({ plan: plan() })).not.toThrow();
  });
});

describe('reviewing the estate', () => {
  const expected = ['region_failure', 'database_corruption'] as const;

  it('finds a scenario with no plan at all', () => {
    /*
     * The gap that does not show up when plans are reviewed one at a time: every plan looks fine
     * and the missing one is invisible.
     */
    const findings = reviewPlans({ plans: [plan()], expectedScenarios: expected });
    const uncovered = findings.find((finding) => finding.kind === 'scenario_uncovered');

    expect(uncovered?.detail).toContain('database_corruption');
  });

  it('finds an RTO the exercise did not meet', () => {
    const findings = reviewPlans({
      plans: [plan({ exercises: [exercise({ achievedMinutes: 200 })] })],
      expectedScenarios: ['region_failure'],
    });

    expect(findings[0]?.kind).toBe('rto_not_met');
    expect(findings[0]?.severity).toBe('high');
  });

  it('finds a dependency on a recovery procedure that does not exist', () => {
    const findings = reviewPlans({
      plans: [plan()],
      procedures: [],
      expectedScenarios: ['region_failure'],
    });
    expect(findings.some((finding) => finding.kind === 'missing_recovery_procedure')).toBe(true);
  });

  it('is quiet about a well-kept estate', () => {
    const findings = reviewPlans({
      plans: [plan()],
      procedures: [{ procedureId: 'rp.postgres-full' } as never],
      expectedScenarios: ['region_failure'],
    });

    expect(findings).toHaveLength(0);
  });

  it('covers every scenario the framework names by default', () => {
    expect(reviewPlans({ plans: [] }).filter((f) => f.kind === 'scenario_uncovered')).toHaveLength(
      DR_SCENARIOS.length,
    );
  });
});

describe('the capability statement', () => {
  it('does not claim multi-region recovery without a plan', () => {
    /*
     * Written for the one line in the specification that says not to claim multi-region DR if it
     * has not been implemented — and for the summary sentence leadership reads, where the
     * temptation to round up is strongest.
     */
    expect(capabilityStatement([])).toContain('not a capability this platform has');
  });

  it('says documented, not demonstrated, after a tabletop', () => {
    const statement = capabilityStatement([
      plan({ exercises: [exercise({ kind: 'tabletop', achievedMinutes: null })] }),
    ]);
    expect(statement).toContain('documented, not demonstrated');
  });

  it('claims it once, and only once, it has been done', () => {
    const statement = capabilityStatement([plan()]);
    expect(statement).toContain('exercised end to end');
    expect(statement).toContain('docs/dr/evidence');
  });
});
