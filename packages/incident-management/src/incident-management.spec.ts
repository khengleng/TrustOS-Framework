import { describe, expect, it } from 'vitest';
import { ServiceRegistry, runbookSchema, serviceSchema } from '@trustsystem/sre-core';
import {
  IncidentManager,
  InMemoryIncidentSink,
  incidentMetrics,
  overdueActions,
  postmortemSchema,
  correctiveActionSchema,
  type Incident,
} from './index';

const NOW = new Date('2026-06-01T12:00:00.000Z');

const runbook = runbookSchema.parse({
  runbookId: 'rb.outage',
  title: 'Service outage',
  trigger: 'The service reports unavailable for more than two minutes.',
  severityHint: 'SEV1',
  steps: [
    {
      title: 'Confirm',
      action: 'Check readiness on every instance before declaring.',
      verification: null,
    },
  ],
  escalateTo: 'Platform on-call.',
  lastReviewedAt: '2026-05-01T00:00:00.000Z',
  ownerId: 'usr_platform',
});

const registry = new ServiceRegistry({
  runbooks: [runbook],
  services: [
    serviceSchema.parse({
      serviceId: 'payments.api',
      name: 'Payments API',
      description: 'Accepts payment requests and posts them to the ledger.',
      tier: 'tier_1',
      ownerTeam: 'payments',
      onCallRotation: 'payments-primary',
      runbookIds: ['rb.outage'],
      supportsProducts: ['merchant-wallet-basic'],
      environment: 'production',
      registeredAt: '2026-01-01T00:00:00.000Z',
    }),
  ],
});

function manager(clock: () => Date = () => NOW) {
  const sink = new InMemoryIncidentSink();
  return { sink, manager: new IncidentManager({ sink, registry, now: clock }) };
}

async function declared(clock: () => Date = () => NOW, severity: 'SEV1' | 'SEV3' = 'SEV1') {
  const { manager: incidents, sink } = manager(clock);
  const incident = await incidents.declare({
    incidentId: 'inc_001',
    title: 'Payments API returning 503 to all merchants',
    severity,
    ownerId: 'usr_commander',
    affectedServiceIds: ['payments.api'],
    impact: 'Merchants cannot accept payments; requests are refused at the ingress.',
    detectionSource: 'alert',
  });
  return { incidents, sink, incident };
}

function postmortem(overrides: Record<string, unknown> = {}) {
  return postmortemSchema.parse({
    summary:
      'A connection pool exhausted during a routine deployment and the new instances could not reach the database.',
    whatHappened:
      'The deployment doubled the instance count while the pool limit stayed fixed, so half the fleet failed readiness and the ingress refused traffic.',
    contributingFactors: [
      'The pool limit was configured per-cluster rather than per-instance, so it did not scale with the fleet.',
    ],
    customerImpact: 'Merchants could not accept payments for 41 minutes.',
    impactMinutes: 41,
    correctiveActions: [
      {
        actionId: 'ca_001',
        description:
          'Make the connection pool limit a function of the instance count rather than a fixed cluster value.',
        ownerId: 'usr_platform',
        dueDate: '2026-06-15T00:00:00.000Z',
        kind: 'prevent',
      },
    ],
    authorId: 'usr_commander',
    filedAt: '2026-06-02T00:00:00.000Z',
    ...overrides,
  });
}

describe('declaring', () => {
  it('opens the timeline with the detection', async () => {
    const { incident } = await declared();
    expect(incident.timeline[0]?.kind).toBe('detection');
  });

  it('names the products affected from the service registry', async () => {
    // Stating impact in terms of components is how a status page says nothing useful.
    const { incident } = await declared();
    expect(incident.affectedProducts).toContain('merchant-wallet-basic');
  });

  it('requires a named commander', async () => {
    const { manager: incidents } = manager();
    await expect(
      incidents.declare({
        incidentId: 'inc_002',
        title: 'Payments API returning 503 to all merchants',
        severity: 'SEV1',
        ownerId: '',
        affectedServiceIds: ['payments.api'],
        impact: 'Merchants cannot accept payments.',
        detectionSource: 'alert',
      }),
    ).rejects.toThrow();
  });
});

describe('the timeline', () => {
  it('appends', async () => {
    const { incidents, incident } = await declared();
    const next = await incidents.note(incident, {
      kind: 'hypothesis',
      actorId: 'usr_engineer',
      note: 'Suspecting the connection pool; the failing instances are all from the new deployment.',
    });

    expect(next.timeline).toHaveLength(2);
  });

  it('does not mutate the incident it was given', async () => {
    /*
     * What makes append-only structural rather than a convention. A caller holding the earlier
     * incident cannot use it to rewrite the record.
     */
    const { incidents, incident } = await declared();
    await incidents.note(incident, {
      kind: 'observation',
      actorId: 'usr_engineer',
      note: 'Half the fleet is failing readiness.',
    });

    expect(incident.timeline).toHaveLength(1);
  });

  it('separates when something happened from when it was written down', async () => {
    // The gap is the interesting part: it is how long nobody was recording.
    const { incidents, incident } = await declared();
    const next = await incidents.note(incident, {
      kind: 'action',
      actorId: 'usr_engineer',
      note: 'Rolled the deployment back.',
      occurredAt: '2026-06-01T11:30:00.000Z',
    });

    const entry = next.timeline[1];
    expect(entry?.occurredAt).toBe('2026-06-01T11:30:00.000Z');
    expect(entry?.recordedAt).toBe(NOW.toISOString());
  });

  it('refuses to add to a closed incident', async () => {
    const { incidents, incident } = await declared(() => NOW, 'SEV3');
    const mitigated = await incidents.transition(incident, {
      to: 'mitigated',
      actorId: 'usr_engineer',
      note: 'Rolled back.',
      mitigation: 'Rolled the deployment back to the previous image.',
    });
    const resolved = await incidents.transition(mitigated, {
      to: 'resolved',
      actorId: 'usr_engineer',
      note: 'Pool limit corrected.',
      resolution: 'Set the pool limit per instance and redeployed.',
    });
    const closed = await incidents.transition(resolved, {
      to: 'closed',
      actorId: 'usr_commander',
      note: 'Done.',
    });

    await expect(
      incidents.note(closed, {
        kind: 'observation',
        actorId: 'usr_engineer',
        note: 'One more thought.',
      }),
    ).rejects.toThrow(/Re-open it/);
  });
});

describe('severity', () => {
  it('is never derived — only stated, and re-stated on the record', async () => {
    /*
     * Severity is a judgement about impact. A rule deriving it from symptoms would be wrong often
     * enough that people would override it, and an overridden field records nothing.
     */
    const { incidents, incident } = await declared();
    const next = await incidents.reassess(incident, {
      severity: 'SEV2',
      actorId: 'usr_commander',
      reason: 'A workaround exists: merchants can retry through the secondary endpoint.',
    });

    expect(next.severity).toBe('SEV2');
    expect(next.timeline.at(-1)?.note).toContain('SEV1 → SEV2');
  });

  it('is a no-op when it does not change', async () => {
    const { incidents, incident } = await declared();
    const next = await incidents.reassess(incident, {
      severity: 'SEV1',
      actorId: 'usr_commander',
      reason: 'Confirmed.',
    });

    expect(next.timeline).toHaveLength(1);
  });
});

describe('transitions', () => {
  it('refuses to jump from detected to resolved', async () => {
    // Something was done. The record should say what.
    const { incidents, incident } = await declared();
    await expect(
      incidents.transition(incident, {
        to: 'resolved',
        actorId: 'usr_engineer',
        note: 'Fixed.',
        resolution: 'It works now.',
      }),
    ).rejects.toThrow(/does not move/);
  });

  it('requires a mitigation to say what was done', async () => {
    const { incidents, incident } = await declared();
    await expect(
      incidents.transition(incident, {
        to: 'mitigated',
        actorId: 'usr_engineer',
        note: 'Mitigated.',
      }),
    ).rejects.toThrow(/mitigation without a description/);
  });

  it('allows re-opening when a mitigation fails', async () => {
    // More honest than opening a second incident, which splits the timeline in two.
    const { incidents, incident } = await declared();
    const mitigated = await incidents.transition(incident, {
      to: 'mitigated',
      actorId: 'usr_engineer',
      note: 'Rolled back.',
      mitigation: 'Rolled the deployment back to the previous image.',
    });

    const reopened = await incidents.transition(mitigated, {
      to: 'investigating',
      actorId: 'usr_engineer',
      note: 'Errors returned twelve minutes after the rollback.',
    });

    expect(reopened.state).toBe('investigating');
  });
});

describe('closing', () => {
  async function resolvedSev1() {
    const { incidents, incident } = await declared();
    const mitigated = await incidents.transition(incident, {
      to: 'mitigated',
      actorId: 'usr_engineer',
      note: 'Rolled back.',
      mitigation: 'Rolled the deployment back to the previous image.',
      at: '2026-06-01T11:41:00.000Z',
    });
    const resolved = await incidents.transition(mitigated, {
      to: 'resolved',
      actorId: 'usr_engineer',
      note: 'Pool limit corrected.',
      resolution: 'Set the pool limit per instance and redeployed.',
      at: '2026-06-01T12:00:00.000Z',
    });
    return { incidents, resolved };
  }

  it('refuses to close a SEV1 without a postmortem', async () => {
    /*
     * The one thing this package refuses that an operator might want. "Monitor and see" is how the
     * same incident happens twice, and the second time nobody remembers the first.
     */
    const { incidents, resolved } = await resolvedSev1();

    await expect(
      incidents.transition(resolved, { to: 'closed', actorId: 'usr_commander', note: 'Done.' }),
    ).rejects.toThrow(/closes with a postmortem/);
  });

  it('closes once one is filed', async () => {
    const { incidents, resolved } = await resolvedSev1();
    const filed = await incidents.filePostmortem(resolved, postmortem(), 'usr_commander');
    const closed = await incidents.transition(filed, {
      to: 'closed',
      actorId: 'usr_commander',
      note: 'Reviewed.',
    });

    expect(closed.state).toBe('closed');
  });

  it('closes a SEV3 without one', async () => {
    // Requiring a postmortem for everything is how postmortems become a formality.
    const { incidents, incident } = await declared(() => NOW, 'SEV3');
    const resolved = await incidents
      .transition(incident, {
        to: 'investigating',
        actorId: 'usr_engineer',
        note: 'One instance was serving stale configuration.',
      })
      .then((investigating) =>
        incidents.transition(investigating, {
          to: 'resolved',
          actorId: 'usr_engineer',
          note: 'Restarted.',
          resolution: 'Restarted the affected instance and confirmed the configuration reloaded.',
        }),
      );

    expect(
      (
        await incidents.transition(resolved, {
          to: 'closed',
          actorId: 'usr_engineer',
          note: 'Minor.',
        })
      ).state,
    ).toBe('closed');
  });

  it('refuses a postmortem before the incident is resolved', async () => {
    const { incidents, incident } = await declared();
    await expect(incidents.filePostmortem(incident, postmortem(), 'usr_commander')).rejects.toThrow(
      /once the incident is resolved/,
    );
  });

  it('requires at least one corrective action', async () => {
    expect(() => postmortem({ correctiveActions: [] })).toThrow();
  });

  it('requires a cancelled action to say why', async () => {
    expect(() =>
      correctiveActionSchema.parse({
        actionId: 'ca_002',
        description: 'Add an alert on connection pool saturation before it exhausts.',
        ownerId: 'usr_platform',
        dueDate: '2026-07-01T00:00:00.000Z',
        kind: 'detect_faster',
        status: 'cancelled',
      }),
    ).toThrow(/says why/);
  });
});

describe('what the review reads', () => {
  it('measures how long customers were affected, not how long the ticket was open', async () => {
    const { incidents, incident } = await declared();
    const mitigated = await incidents.transition(incident, {
      to: 'mitigated',
      actorId: 'usr_engineer',
      note: 'Rolled back.',
      mitigation: 'Rolled the deployment back.',
      at: '2026-06-01T12:41:00.000Z',
    });

    expect(incidentMetrics(mitigated).timeToMitigateMinutes).toBe(41);
  });

  it('records when a customer found it first', async () => {
    // For a tier-1 service this is the most useful line in the review, and it is a fact.
    const { manager: incidents } = manager();
    const incident = await incidents.declare({
      incidentId: 'inc_003',
      title: 'Merchant reports payments failing intermittently',
      severity: 'SEV2',
      ownerId: 'usr_commander',
      affectedServiceIds: ['payments.api'],
      impact: 'A merchant reports one in five payments failing.',
      detectionSource: 'customer_report',
    });

    expect(incidentMetrics(incident).customerDetected).toBe(true);
  });

  it('finds corrective actions that quietly went past due', async () => {
    /*
     * The list nobody maintains. The same incident recurs while its prevention sits at 20% done,
     * and the second postmortem writes the same action again.
     */
    const incident = {
      incidentId: 'inc_001',
      postmortem: postmortem(),
    } as unknown as Incident;

    const overdue = overdueActions([incident], new Date('2026-06-30T00:00:00.000Z'));
    expect(overdue[0]?.daysOverdue).toBe(15);
  });

  it('does not chase actions that are done or deliberately cancelled', async () => {
    const incident = {
      incidentId: 'inc_001',
      postmortem: postmortem({
        correctiveActions: [
          {
            actionId: 'ca_001',
            description: 'Make the connection pool limit a function of the instance count.',
            ownerId: 'usr_platform',
            dueDate: '2026-06-15T00:00:00.000Z',
            kind: 'prevent',
            status: 'done',
          },
        ],
      }),
    } as unknown as Incident;

    expect(overdueActions([incident], new Date('2026-06-30T00:00:00.000Z'))).toHaveLength(0);
  });
});
