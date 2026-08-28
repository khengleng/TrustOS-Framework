import { describe, expect, it } from 'vitest';
import { AuditService, InMemoryAuditSink } from '@trustos/audit';
import {
  AUDIT_ON_REFUSAL,
  GOVERNANCE_AUDIT_ACTIONS,
  GovernanceAuditBridge,
  governanceAuditEntry,
  governanceAuditSchema,
} from './index';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function entry(overrides: Record<string, unknown> = {}) {
  return governanceAuditEntry({
    appId: 'customer-support-console',
    appName: 'Customer Support Console',
    environment: 'prod',
    action: GOVERNANCE_AUDIT_ACTIONS.PII_REVEALED,
    resourceType: 'Customer',
    resourceId: 'cus_1',
    actorId: 'usr_support',
    actorType: 'human',
    organizationId: 'org_a',
    outcome: 'allowed',
    correlationId: 'cor_1',
    now: NOW,
    reason: 'Customer called about a payment they say never arrived.',
    ...overrides,
  } as never);
}

describe('the audit bridge', () => {
  it('writes into the TrustOS trail, not a trail of its own', async () => {
    const sink = new InMemoryAuditSink();
    const bridge = new GovernanceAuditBridge({
      audit: new AuditService({ sink }),
      application: 'governance-tool',
      environment: 'prod',
    });

    await bridge.record(entry());

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.action).toBe('governance.pii.revealed');
  });

  it('adds the provenance TrustOS could not have known', async () => {
    const sink = new InMemoryAuditSink();
    const bridge = new GovernanceAuditBridge({
      audit: new AuditService({ sink }),
      application: 'governance-tool',
      environment: 'prod',
    });

    await bridge.record(entry());
    const metadata = sink.records[0]?.metadata as Record<string, unknown>;

    // "usr_support revealed cus_1" versus "…from the support console, in production, because a
    // customer called, correlated to cor_1". The second is what an investigation can act on.
    expect(metadata.governanceAppId).toBe('customer-support-console');
    expect(metadata.governanceEnvironment).toBe('prod');
    expect(metadata.correlationId).toBe('cor_1');
    expect(metadata.reason).toContain('Customer called');
  });

  it('carries the reason verbatim rather than paraphrasing it', () => {
    const built = entry({ reason: 'Investigating case cas_9 following a chargeback notice.' });
    expect(built.reason).toBe('Investigating case cas_9 following a chargeback notice.');
  });

  it('records a refusal as well as a success', async () => {
    const sink = new InMemoryAuditSink();
    const bridge = new GovernanceAuditBridge({
      audit: new AuditService({ sink }),
      application: 'governance-tool',
      environment: 'prod',
    });

    await bridge.record(
      entry({ action: GOVERNANCE_AUDIT_ACTIONS.PII_REVEAL_REFUSED, outcome: 'refused' }),
    );

    expect((sink.records[0]?.metadata as Record<string, unknown>).outcome).toBe('refused');
  });

  it('names every action specifically rather than generically', () => {
    const actions = Object.values(GOVERNANCE_AUDIT_ACTIONS);

    // An auditor searching for reveals searches for the action name.
    expect(actions).toContain('governance.pii.revealed');
    expect(actions).toContain('governance.export.produced');
    expect(actions).toContain('governance.mutation.refused');
    expect(actions).not.toContain('governance.action');
  });

  it('lists the refusals that must still be audited', () => {
    for (const action of AUDIT_ON_REFUSAL) {
      expect(action).toMatch(/refused$/);
    }
    expect(AUDIT_ON_REFUSAL).toHaveLength(4);
  });

  it('bounds before and after to scalars, so an audit record cannot carry a payload', () => {
    expect(() =>
      governanceAuditSchema.parse({
        ...entry(),
        after: { nested: { deeply: 'no' } },
      }),
    ).toThrow();
  });

  it('has no update and no delete', () => {
    const bridge = new GovernanceAuditBridge({
      audit: new AuditService({ sink: new InMemoryAuditSink() }),
      application: 'governance-tool',
      environment: 'prod',
    });

    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(bridge));
    expect(surface).not.toContain('update');
    expect(surface).not.toContain('delete');
    expect(surface).not.toContain('amend');
  });
});
