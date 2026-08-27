import { describe, expect, it } from 'vitest';
import {
  ServiceRegistry,
  assertGraphSound,
  maintenanceWindowSchema,
  runbookSchema,
  serviceSchema,
} from './index';

function runbook(overrides: Record<string, unknown> = {}) {
  return runbookSchema.parse({
    runbookId: 'rb.database-unavailable',
    title: 'Database unavailable',
    trigger: 'Readiness reports the primary database as down for more than two minutes.',
    severityHint: 'SEV1',
    steps: [
      {
        title: 'Confirm the outage is not a network partition on one instance',
        action:
          'Check readiness on every instance; a single failing instance is a restart, not an outage.',
        verification: 'At least one instance reports ready.',
      },
    ],
    escalateTo: 'Platform on-call, then the database vendor support contract.',
    lastReviewedAt: '2026-05-01T00:00:00.000Z',
    ownerId: 'usr_platform',
    ...overrides,
  });
}

function service(overrides: Record<string, unknown> = {}) {
  return serviceSchema.parse({
    serviceId: 'payments.api',
    name: 'Payments API',
    description: 'Accepts payment requests and posts them to the ledger.',
    tier: 'tier_1',
    ownerTeam: 'payments',
    onCallRotation: 'payments-primary',
    dependencies: [],
    runbookIds: ['rb.database-unavailable'],
    supportsProducts: ['merchant-wallet-basic'],
    repository: 'trustos/payments-api',
    environment: 'production',
    registeredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function dependency(overrides: Record<string, unknown> = {}) {
  return {
    dependencyId: 'ledger',
    kind: 'api',
    description: 'Posts double-entry journal entries for every accepted payment.',
    critical: true,
    targetServiceId: 'ledger.api',
    degradedBehaviour: 'Payments are refused rather than accepted un-posted.',
    runbookId: 'rb.database-unavailable',
    ...overrides,
  };
}

describe('registering a service', () => {
  it('accepts a well-formed tier-1 service', () => {
    const registry = new ServiceRegistry({ runbooks: [runbook()], services: [service()] });
    expect(registry.require('payments.api').tier).toBe('tier_1');
  });

  it('refuses a tier-1 service with nobody on call', () => {
    // An unrouted alert is indistinguishable from no alert.
    expect(() => service({ onCallRotation: null })).toThrow(/rotation/);
  });

  it('refuses a tier-1 service with no runbook', () => {
    expect(() => service({ runbookIds: [] })).toThrow(/runbook/);
  });

  it('permits a tier-3 service with neither', () => {
    const batch = serviceSchema.parse({
      ...service({
        serviceId: 'reporting.batch',
        tier: 'tier_3',
        runbookIds: [],
        onCallRotation: null,
      }),
    });
    expect(batch.onCallRotation).toBeNull();
  });

  it('refuses a runbook reference that does not resolve', () => {
    const registry = new ServiceRegistry();
    expect(() => registry.register(service())).toThrow(/not registered/);
  });

  it('refuses a service that depends on itself', () => {
    expect(() =>
      service({ dependencies: [dependency({ targetServiceId: 'payments.api' })] }),
    ).toThrow(/does not depend on itself/);
  });

  it('refuses duplicate dependency ids', () => {
    expect(() => service({ dependencies: [dependency(), dependency()] })).toThrow(/unique/);
  });

  it('refuses to register the same service twice', () => {
    const registry = new ServiceRegistry({ runbooks: [runbook()], services: [service()] });
    expect(() => registry.register(service())).toThrow(/already registered/);
  });
});

describe('the graph', () => {
  function estate() {
    return new ServiceRegistry({
      runbooks: [runbook()],
      services: [
        service({ dependencies: [dependency()] }),
        service({
          serviceId: 'ledger.api',
          name: 'Ledger API',
          onCallRotation: 'platform-primary',
          dependencies: [
            dependency({ dependencyId: 'postgres', kind: 'database', targetServiceId: null }),
          ],
        }),
        service({
          serviceId: 'settlement.batch',
          name: 'Settlement batch',
          tier: 'tier_2',
          onCallRotation: null,
          dependencies: [dependency({ targetServiceId: 'ledger.api' })],
        }),
      ],
    });
  }

  it('answers who else is affected', () => {
    // The question asked in every incident and answered accurately by nobody from memory.
    expect(estate().dependents('ledger.api')).toEqual(['payments.api', 'settlement.batch']);
  });

  it('walks dependencies transitively', () => {
    expect(estate().dependenciesOf('settlement.batch')).toContain('ledger.api');
  });

  it('collects the runbooks a responder might need', () => {
    expect(estate().runbooksFor('payments.api')).toHaveLength(1);
  });

  it('finds a tier inversion', () => {
    /*
     * A tier-1 service critically depending on a tier-3 one has an availability ceiling below its
     * own objective. The SLO is then arithmetic fiction, and the fiction survives review because
     * each service looks reasonable read alone.
     */
    const registry = new ServiceRegistry({
      runbooks: [runbook()],
      services: [
        service({ dependencies: [dependency({ targetServiceId: 'reporting.batch' })] }),
        service({
          serviceId: 'reporting.batch',
          tier: 'tier_3',
          onCallRotation: null,
          runbookIds: [],
        }),
      ],
    });

    const inversion = registry.analyse().find((finding) => finding.kind === 'tier_inversion');
    expect(inversion?.severity).toBe('high');
    expect(() => assertGraphSound(registry)).toThrow(/high-severity/);
  });

  it('does not call a non-critical dependency on a lower tier an inversion', () => {
    // Depending on something less available is fine when you keep working without it.
    const registry = new ServiceRegistry({
      runbooks: [runbook()],
      services: [
        service({
          dependencies: [
            dependency({
              targetServiceId: 'reporting.batch',
              critical: false,
              degradedBehaviour: 'Reports are queued; payments continue.',
            }),
          ],
        }),
        service({
          serviceId: 'reporting.batch',
          tier: 'tier_3',
          onCallRotation: null,
          runbookIds: [],
        }),
      ],
    });

    expect(registry.analyse().filter((f) => f.kind === 'tier_inversion')).toHaveLength(0);
  });

  it('finds a dependency on something that is not registered', () => {
    const registry = new ServiceRegistry({
      runbooks: [runbook()],
      services: [service({ dependencies: [dependency({ targetServiceId: 'fraud.api' })] })],
    });

    expect(registry.analyse()[0]?.kind).toBe('unregistered_dependency');
  });

  it('finds a cycle', () => {
    // Two services that cannot be brought up without each other have no recovery procedure.
    const registry = new ServiceRegistry({
      runbooks: [runbook()],
      services: [
        service({ dependencies: [dependency({ targetServiceId: 'ledger.api' })] }),
        service({
          serviceId: 'ledger.api',
          onCallRotation: 'platform-primary',
          dependencies: [dependency({ targetServiceId: 'payments.api' })],
        }),
      ],
    });

    expect(registry.analyse().some((finding) => finding.kind === 'dependency_cycle')).toBe(true);
  });

  it('is silent on a sound graph', () => {
    expect(() => assertGraphSound(estate())).not.toThrow();
  });
});

describe('maintenance windows', () => {
  function window(overrides: Record<string, unknown> = {}) {
    return maintenanceWindowSchema.parse({
      windowId: 'mw.2026-06-migration',
      title: 'Schema migration',
      serviceIds: ['payments.api'],
      startsAt: '2026-06-01T02:00:00.000Z',
      endsAt: '2026-06-01T04:00:00.000Z',
      approvedBy: 'usr_platform_lead',
      approvedAt: '2026-05-25T00:00:00.000Z',
      description: 'Adds the settlement adjustment tables; the API is read-only throughout.',
      ...overrides,
    });
  }

  function registry(overrides: Record<string, unknown> = {}) {
    return new ServiceRegistry({
      runbooks: [runbook()],
      services: [service()],
      maintenanceWindows: [window(overrides)],
    });
  }

  it('excludes minutes inside the window', () => {
    // Planned work should not spend the budget that exists to absorb unplanned failure.
    expect(
      registry().inMaintenance('payments.api', new Date('2026-06-01T03:00:00.000Z')),
    ).not.toBeNull();
  });

  it('does not exclude minutes outside it', () => {
    expect(
      registry().inMaintenance('payments.api', new Date('2026-06-01T05:00:00.000Z')),
    ).toBeNull();
  });

  it('does not exclude a window that says it should not be excluded', () => {
    // A window declared for communication only still measures against the objective.
    const scoped = registry({ excludeFromSlo: false });
    expect(scoped.inMaintenance('payments.api', new Date('2026-06-01T03:00:00.000Z'))).toBeNull();
  });

  it('does not exclude a service the window does not cover', () => {
    expect(registry().inMaintenance('ledger.api', new Date('2026-06-01T03:00:00.000Z'))).toBeNull();
  });

  it('refuses a window over an unregistered service', () => {
    expect(
      () => new ServiceRegistry({ runbooks: [runbook()], maintenanceWindows: [window()] }),
    ).toThrow(/not registered/);
  });

  it('refuses a window that ends before it starts', () => {
    expect(() => window({ endsAt: '2026-06-01T01:00:00.000Z' })).toThrow(/ends after it starts/);
  });
});
