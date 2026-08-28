import { describe, expect, it } from 'vitest';
import {
  InMemoryPolicyDecisionSink,
  PolicyDecisionLog,
  assertVersioned,
  hashAttribute,
  policyDecisionRecordSchema,
  reDerivable,
} from './index';

const NOW = new Date('2026-06-01T12:00:00.000Z');

const decision = {
  decision: 'DENY' as const,
  policyId: 'data.export-approval',
  policyVersion: '2.1.0',
  ruleId: 'deny-highly-restricted',
  reasons: ['Highly restricted data does not leave the system.'],
  obligations: [],
  trace: [],
  missingAttributes: [],
};

function log(): { log: PolicyDecisionLog; sink: InMemoryPolicyDecisionSink } {
  const sink = new InMemoryPolicyDecisionSink();
  return { log: new PolicyDecisionLog(sink), sink };
}

function input(overrides: Record<string, unknown> = {}) {
  let counter = 0;

  return {
    decision,
    actorId: 'usr_finance',
    organizationId: 'org_a',
    action: 'data.export',
    resourceId: 'db.core.ledger',
    attributes: { classification: 'HIGHLY_RESTRICTED', customerRef: 'cus_1' },
    correlationId: 'cor_1',
    decidedAt: NOW,
    durationMicros: 120,
    newDecisionId: () => `dec_${(counter += 1)}`,
    ...overrides,
  };
}

describe('recording a decision', () => {
  it('records the policy version, which is what makes it evidence', async () => {
    // Without it, "we denied this in March" is unfalsifiable: the policy has changed since.
    const { log: decisionLog, sink } = log();
    await decisionLog.record(input());

    expect(sink.records[0]?.policyVersion).toBe('2.1.0');
    expect(sink.records[0]?.ruleId).toBe('deny-highly-restricted');
  });

  it('records an allow as well as a deny', async () => {
    // A decision point that logged only denials answers "what did we refuse" and not "what did
    // we permit", and the second is the question about a breach.
    const { log: decisionLog, sink } = log();

    await decisionLog.record(
      input({ decision: { ...decision, decision: 'ALLOW', ruleId: 'allow-internal' } }),
    );
    expect(sink.records[0]?.decision).toBe('ALLOW');
  });

  it('hashes sensitive attributes rather than storing them', async () => {
    // A decision about whether to reveal a customer's identifier must not record the identifier.
    const { log: decisionLog, sink } = log();
    await decisionLog.record(input({ sensitiveAttributes: ['customerRef'] }));

    const record = sink.records[0]!;
    expect(record.attributes.customerRef).toBeUndefined();
    expect(record.hashedAttributes.customerRef).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(JSON.stringify(record)).not.toContain('cus_1');
  });

  it('keeps non-sensitive attributes verbatim', async () => {
    const { log: decisionLog, sink } = log();
    await decisionLog.record(input({ sensitiveAttributes: ['customerRef'] }));

    expect(sink.records[0]?.attributes.classification).toBe('HIGHLY_RESTRICTED');
  });

  it('records the attributes the policy read and nobody supplied', async () => {
    const { log: decisionLog, sink } = log();
    await decisionLog.record(
      input({ decision: { ...decision, missingAttributes: ['amountMinorUnits'] } }),
    );

    expect(sink.records[0]?.missingAttributes).toEqual(['amountMinorUnits']);
  });

  it('does not swallow a failed write', async () => {
    // The opposite trade from the audit trail, deliberately: a permission granted with no record
    // of why is worse than a permission refused.
    const failing = new PolicyDecisionLog({
      append: async () => {
        throw new Error('the sink is down');
      },
      query: async () => [],
    });

    await expect(failing.record(input())).rejects.toThrow(/the sink is down/);
  });
});

describe('hashing', () => {
  it('is stable', () => {
    expect(hashAttribute('cus_1')).toBe(hashAttribute('cus_1'));
  });

  it('differs across values', () => {
    expect(hashAttribute('cus_1')).not.toBe(hashAttribute('cus_2'));
  });

  it('is a correlation token rather than a commitment', () => {
    // Sixteen hex characters. A full digest would invite somebody to treat it as proof of a
    // value, and it is unsalted — see the note on entropy.
    expect(hashAttribute('cus_1')).toHaveLength('sha256:'.length + 16);
  });
});

describe('the sink', () => {
  it('has no update and no delete', () => {
    // The append-only rule is structural, so no amount of autocomplete leads somebody to a
    // method that rewrites a decision.
    const sink = new InMemoryPolicyDecisionSink();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(sink));

    expect(surface).toContain('append');
    expect(surface).not.toContain('update');
    expect(surface).not.toContain('delete');
  });

  it('filters a query by policy, version, actor and decision', async () => {
    const { log: decisionLog } = log();
    const sink = new InMemoryPolicyDecisionSink();
    const scoped = new PolicyDecisionLog(sink);
    void decisionLog;

    await scoped.record(input());
    await scoped.record(
      input({ actorId: 'usr_other', decision: { ...decision, decision: 'ALLOW' } }),
    );

    expect(await scoped.query({ limit: 10, decision: 'DENY' })).toHaveLength(1);
    expect(await scoped.query({ limit: 10, actorId: 'usr_other' })).toHaveLength(1);
    expect(await scoped.query({ limit: 10, policyVersion: '9.9.9' })).toHaveLength(0);
  });
});

describe('re-derivation', () => {
  it('says a fully-recorded decision can be replayed', () => {
    const record = policyDecisionRecordSchema.parse({
      decisionId: 'dec_1',
      policyId: 'data.export-approval',
      policyVersion: '2.1.0',
      ruleId: 'deny-highly-restricted',
      decision: 'DENY',
      reasons: ['No.'],
      obligations: [],
      actorId: 'usr_finance',
      organizationId: 'org_a',
      action: 'data.export',
      resourceId: null,
      attributes: { classification: 'HIGHLY_RESTRICTED' },
      correlationId: 'cor_1',
      decidedAt: NOW.toISOString(),
      durationMicros: 100,
    });

    expect(reDerivable(record).possible).toBe(true);
  });

  it('says a decision with hashed attributes cannot, and why', () => {
    // The trade the hashing made deliberately: the alternative was a decision log containing the
    // data the decision was about.
    const record = policyDecisionRecordSchema.parse({
      decisionId: 'dec_1',
      policyId: 'data.export-approval',
      policyVersion: '2.1.0',
      ruleId: null,
      decision: 'DENY',
      reasons: ['No.'],
      obligations: [],
      actorId: 'usr_finance',
      organizationId: 'org_a',
      action: 'data.export',
      resourceId: null,
      attributes: {},
      hashedAttributes: { customerRef: hashAttribute('cus_1') },
      correlationId: 'cor_1',
      decidedAt: NOW.toISOString(),
      durationMicros: 100,
    });

    const result = reDerivable(record);
    expect(result.possible).toBe(false);
    expect(result.reason).toContain('deliberately');
  });
});

describe('versioning', () => {
  it('refuses a record with no policy version', () => {
    expect(() =>
      assertVersioned({
        decisionId: 'dec_1',
        policyId: 'p',
        decision: 'DENY',
        reasons: [],
        obligations: [],
        actorId: 'usr_1',
        organizationId: null,
        action: 'x',
        resourceId: null,
        attributes: {},
        correlationId: 'cor_1',
        decidedAt: NOW.toISOString(),
        durationMicros: 1,
        ruleId: null,
      }),
    ).toThrow(/unfalsifiable/);
  });
});
