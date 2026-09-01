import { describe, expect, it } from 'vitest';
import { ServiceRegistry, runbookSchema, serviceSchema } from '@trustsystem/sre-core';
import { DependencyHealthBoard, healthProbeSchema, worst } from './index';

const NOW = new Date('2026-06-01T12:00:00.000Z');

const runbook = runbookSchema.parse({
  runbookId: 'rb.dependency-outage',
  title: 'Dependency outage',
  trigger: 'A critical dependency reports UNAVAILABLE for more than two minutes.',
  severityHint: 'SEV2',
  steps: [
    {
      title: 'Confirm the dependency is down for everyone',
      action: 'Probe the dependency from a second service before declaring an outage.',
      verification: 'Two independent probes agree.',
    },
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
    runbookIds: ['rb.dependency-outage'],
    environment: 'production',
    registeredAt: '2026-01-01T00:00:00.000Z',
    dependencies: [
      {
        dependencyId: 'ledger',
        kind: 'api',
        description: 'Posts a journal entry for every accepted payment.',
        critical: true,
        targetServiceId: 'ledger.api',
        degradedBehaviour: 'Payments are refused rather than accepted un-posted.',
        runbookId: 'rb.dependency-outage',
      },
      {
        dependencyId: 'analytics',
        kind: 'integration',
        description: 'Receives a copy of each payment for reporting.',
        critical: false,
        targetServiceId: null,
        degradedBehaviour: 'Events queue locally; payments continue.',
        runbookId: null,
      },
    ],
    ...overrides,
  });
}

function board() {
  const registry = new ServiceRegistry({
    runbooks: [runbook],
    services: [
      service(),
      service({
        serviceId: 'ledger.api',
        name: 'Ledger API',
        onCallRotation: 'platform-primary',
        dependencies: [],
      }),
      service({
        serviceId: 'settlement.batch',
        name: 'Settlement batch',
        tier: 'tier_2',
        onCallRotation: null,
        dependencies: [
          {
            dependencyId: 'payments',
            kind: 'api',
            description: 'Reads accepted payments for the settlement run.',
            critical: true,
            targetServiceId: 'payments.api',
            degradedBehaviour: 'The run is deferred to the next cycle.',
            runbookId: null,
          },
        ],
      }),
    ],
  });

  return new DependencyHealthBoard(registry, () => NOW);
}

function probe(overrides: Record<string, unknown> = {}) {
  return healthProbeSchema.parse({
    dependencyId: 'ledger',
    serviceId: 'payments.api',
    kind: 'api',
    state: 'HEALTHY',
    observedAt: '2026-06-01T11:59:00.000Z',
    latencyMs: 12,
    ...overrides,
  });
}

describe('rolling up', () => {
  it('takes the worst state, not the average', () => {
    // An average is green during a partial outage, because most things are usually fine.
    expect(worst(['HEALTHY', 'HEALTHY', 'UNAVAILABLE', 'HEALTHY'])).toBe('UNAVAILABLE');
  });

  it('ranks not-knowing above impaired and below gone', () => {
    expect(worst(['DEGRADED', 'UNKNOWN'])).toBe('UNKNOWN');
    expect(worst(['UNKNOWN', 'UNAVAILABLE'])).toBe('UNAVAILABLE');
  });

  it('reports healthy when every dependency answered recently', () => {
    const healthBoard = board();
    healthBoard.record(probe());
    healthBoard.record(probe({ dependencyId: 'analytics', kind: 'integration' }));

    expect(healthBoard.serviceHealth('payments.api').state).toBe('HEALTHY');
  });

  it('takes the service down when a critical dependency is gone', () => {
    const healthBoard = board();
    healthBoard.record(probe({ state: 'UNAVAILABLE', detail: 'Connection refused.' }));
    healthBoard.record(probe({ dependencyId: 'analytics', kind: 'integration' }));

    const health = healthBoard.serviceHealth('payments.api');
    expect(health.state).toBe('UNAVAILABLE');
    expect(health.reason).toContain('ledger is UNAVAILABLE');
  });

  it('only degrades the service when a non-critical dependency is gone', () => {
    /*
     * What `critical: false` claimed. The declaration only means something if the roll-up honours
     * it, otherwise every dependency is effectively critical and the field is decoration.
     */
    const healthBoard = board();
    healthBoard.record(probe());
    healthBoard.record(
      probe({ dependencyId: 'analytics', kind: 'integration', state: 'UNAVAILABLE' }),
    );

    expect(healthBoard.serviceHealth('payments.api').state).toBe('DEGRADED');
  });
});

describe('staleness', () => {
  it('reads a probe older than its freshness budget as unknown', () => {
    /*
     * The state that gives this package its reason to exist. Carrying the last known-good state
     * forward means a monitoring outage renders as a healthy estate — the moment you cannot see is
     * rendered as the moment everything is fine.
     */
    const healthBoard = board();
    healthBoard.record(probe({ observedAt: '2026-06-01T11:00:00.000Z', freshnessSeconds: 120 }));

    const ledger = healthBoard.serviceHealth('payments.api').dependencies[0];
    expect(ledger?.state).toBe('UNKNOWN');
    expect(ledger?.stale).toBe(true);
  });

  it('says the state is unknown because nobody looked', () => {
    const healthBoard = board();
    healthBoard.record(probe({ observedAt: '2026-06-01T11:00:00.000Z' }));

    expect(healthBoard.serviceHealth('payments.api').reason).toContain('not been probed recently');
  });

  it('reads a dependency that was never probed as unknown but not stale', () => {
    // Never observed and observed-too-long-ago are both unknown; the remedies differ.
    const ledger = board().serviceHealth('payments.api').dependencies[0];
    expect(ledger?.state).toBe('UNKNOWN');
    expect(ledger?.stale).toBe(false);
  });

  it('lists what nobody is watching', () => {
    const healthBoard = board();
    healthBoard.record(probe());

    expect(healthBoard.unobserved().map((d) => d.dependencyId)).toContain('analytics');
  });
});

describe('recording', () => {
  it('refuses a probe for a dependency the service never declared', () => {
    // An undeclared dependency is invisible to the graph, so its health would be measured and unused.
    expect(() => board().record(probe({ dependencyId: 'redis' }))).toThrow(/did not declare/);
  });

  it('refuses a probe for a service that is not registered', () => {
    expect(() => board().record(probe({ serviceId: 'fraud.api' }))).toThrow(/not registered/);
  });
});

describe('blast radius', () => {
  it('names what else fails when a dependency goes', () => {
    // The incident question is "what is affected", not "what has already alerted".
    const radius = board().blastRadius({ serviceId: 'payments.api', dependencyId: 'ledger' });

    expect(radius.transitivelyAffected).toContain('settlement.batch');
    expect(radius.criticalFor).toEqual(['payments.api', 'settlement.batch']);
  });

  it('does not call a service critically affected by a dependency it tolerates', () => {
    const radius = board().blastRadius({ serviceId: 'payments.api', dependencyId: 'analytics' });
    expect(radius.criticalFor).not.toContain('payments.api');
  });
});

describe('the board', () => {
  it('sorts the worst first', () => {
    const healthBoard = board();
    healthBoard.record(probe({ state: 'UNAVAILABLE' }));
    healthBoard.record(probe({ dependencyId: 'analytics', kind: 'integration' }));

    expect(healthBoard.board()[0]?.serviceId).toBe('payments.api');
  });

  it('calls a service with no dependencies healthy', () => {
    // Nothing external can take it down; that is a real answer, not an absence of one.
    expect(board().serviceHealth('ledger.api').state).toBe('HEALTHY');
  });
});
