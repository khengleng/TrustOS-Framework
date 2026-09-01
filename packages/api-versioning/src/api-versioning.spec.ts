import { describe, expect, it } from 'vitest';
import { apiDefinitionSchema } from '@trustsystem/api-catalog';
import {
  MINIMUM_DEPRECATION_DAYS,
  type CompatibilityAnalysis,
  type MigrationPlan,
  analyseCompatibility,
  assertReleasable,
  bumpBetween,
  migrationPlanSchema,
  unacknowledgedConsumers,
} from './index';

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'listMerchants',
    method: 'GET',
    path: '/api/merchants',
    summary: 'Lists the merchants in the calling organization.',
    scopes: ['merchants:read'],
    classification: 'CONFIDENTIAL',
    idempotent: true,
    ...overrides,
  };
}

function api(overrides: Record<string, unknown> = {}) {
  return apiDefinitionSchema.parse({
    apiId: 'merchant.api',
    name: 'Merchant API',
    description: 'Registration, verification and profile management for merchants.',
    version: '1.0.0',
    domain: 'merchant',
    environment: 'production',
    lifecycle: 'PUBLISHED',
    businessOwnerId: 'usr_business',
    technicalOwnerId: 'usr_tech',
    authentication: 'api_key',
    scopes: ['merchants:read'],
    operations: [operation()],
    openApiRef: 'specs/merchant-api.yaml',
    serviceId: 'merchant.api',
    sloId: 'merchant.api.availability',
    approvedBy: 'usr_governance',
    approvedAt: '2026-02-01T00:00:00.000Z',
    registeredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

function plan(overrides: Record<string, unknown> = {}) {
  return migrationPlanSchema.parse({
    apiId: 'merchant.api',
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    migrationGuide:
      'Move calls from /api/merchants to /api/v2/merchants. The response shape is unchanged; only the path moves. ' +
      'Both paths serve traffic until the retirement date.',
    deprecationPeriodDays: 120,
    consumerImpacts: [
      {
        consumerId: 'con_partner_a',
        impact:
          'Calls /api/merchants on every page load; the path must be updated in their integration.',
        notifiedAt: '2026-03-01T00:00:00.000Z',
      },
    ],
    authorId: 'usr_tech',
    createdAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  });
}

/** The refusal names each problem in `context.problems`; the message is the headline. */
function problemsFrom(input: {
  analysis: CompatibilityAnalysis;
  plan: MigrationPlan | null;
  knownConsumerIds?: readonly string[];
}): string {
  try {
    assertReleasable(input);
  } catch (error) {
    return ((error as { context?: { problems?: string[] } }).context?.problems ?? []).join(' ');
  }
  return '';
}

describe('classifying changes', () => {
  it('calls a removed operation breaking', () => {
    const analysis = analyseCompatibility(
      api({
        operations: [
          operation(),
          operation({ operationId: 'getMerchant', path: '/api/merchants/:id' }),
        ],
      }),
      api({ version: '2.0.0' }),
    );

    expect(analysis.breaking).toBe(true);
    expect(analysis.changes[0]?.kind).toBe('operation_removed');
  });

  it('calls an added operation additive, not breaking', () => {
    const analysis = analyseCompatibility(
      api(),
      api({
        version: '1.1.0',
        operations: [
          operation(),
          operation({ operationId: 'getMerchant', path: '/api/merchants/:id' }),
        ],
      }),
    );

    expect(analysis.breaking).toBe(false);
    expect(analysis.requiredBump).toBe('minor');
  });

  it('calls a newly required scope breaking', () => {
    /*
     * The one that reads as a security improvement. Every existing credential lacks the new scope,
     * so every existing consumer starts receiving 403 — from a change that alters no response.
     */
    const analysis = analyseCompatibility(
      api(),
      api({
        version: '1.0.1',
        operations: [operation({ scopes: ['merchants:read', 'merchants:verify'] })],
      }),
    );

    expect(analysis.breaking).toBe(true);
    expect(analysis.changes[0]?.consumerAction).toContain('403');
  });

  it('calls a removed scope compatible', () => {
    const analysis = analyseCompatibility(
      api({ operations: [operation({ scopes: ['merchants:read', 'merchants:verify'] })] }),
      api({ version: '1.0.1' }),
    );

    expect(analysis.breaking).toBe(false);
  });

  it('calls losing idempotency breaking', () => {
    // Callers built retry behaviour on the old answer; those retries become duplicates.
    const analysis = analyseCompatibility(
      api({ operations: [operation({ method: 'POST', idempotent: true })] }),
      api({ version: '2.0.0', operations: [operation({ method: 'POST', idempotent: false })] }),
    );

    expect(analysis.changes[0]?.consumerAction).toContain('duplicates');
  });

  it('calls a raised classification compatible and a lowered one breaking', () => {
    /*
     * The direction that surprises people. Raising is a tightening consumers can be asked to meet;
     * lowering changes which policy applies to data that did not itself become less sensitive.
     */
    const raised = analyseCompatibility(
      api(),
      api({ version: '1.1.0', operations: [operation({ classification: 'RESTRICTED' })] }),
    );
    const lowered = analyseCompatibility(
      api(),
      api({ version: '1.1.0', operations: [operation({ classification: 'INTERNAL' })] }),
    );

    expect(raised.breaking).toBe(false);
    expect(lowered.breaking).toBe(true);
    expect(lowered.changes[0]?.consumerAction).toContain('reviewed reclassification');
  });

  it('reports a renamed path as one change, not a removal and an addition', () => {
    // A removal-plus-addition reads as "the old one is gone", which understates a move.
    const analysis = analyseCompatibility(
      api(),
      api({ version: '2.0.0', operations: [operation({ path: '/api/v2/merchants' })] }),
    );

    expect(analysis.changes).toHaveLength(1);
    expect(analysis.changes[0]?.kind).toBe('path_changed');
  });

  it('is quiet when nothing changed', () => {
    const analysis = analyseCompatibility(api(), api({ version: '1.0.1' }));
    expect(analysis.changes).toHaveLength(0);
    expect(analysis.requiredBump).toBe('patch');
  });

  it('refuses to compare two different APIs', () => {
    expect(() => analyseCompatibility(api(), api({ apiId: 'wallet.api' }))).toThrow(
      /two different APIs/,
    );
  });
});

describe('the required bump', () => {
  it('is not satisfied when a breaking change ships as a patch', () => {
    /*
     * The core refusal. A breaking change released as 1.0.1 is exactly the silent break the
     * specification names, and it is a code path rather than a review comment.
     */
    const analysis = analyseCompatibility(
      api(),
      api({ version: '1.0.1', operations: [operation({ path: '/api/v2/merchants' })] }),
    );

    expect(analysis.versionSufficient).toBe(false);
    expect(problemsFrom({ analysis, plan: plan() })).toContain('ships as a patch');
  });

  it('is satisfied by a major', () => {
    const analysis = analyseCompatibility(
      api(),
      api({ version: '2.0.0', operations: [operation({ path: '/api/v2/merchants' })] }),
    );

    expect(analysis.versionSufficient).toBe(true);
  });

  it('does not count a version that moved backwards', () => {
    expect(bumpBetween('2.0.0', '1.0.0')).toBe(0);
  });

  it('reads 1.9.0 → 1.10.0 as a minor rather than a patch', () => {
    // Lexical comparison would call 1.10.0 older than 1.9.0.
    expect(bumpBetween('1.9.0', '1.10.0')).toBe(2);
  });
});

describe('what a breaking change owes', () => {
  const breaking = () =>
    analyseCompatibility(
      api(),
      api({ version: '2.0.0', operations: [operation({ path: '/api/v2/merchants' })] }),
    );

  it('refuses a breaking release with no migration plan', () => {
    expect(problemsFrom({ analysis: breaking(), plan: null })).toContain('find out by failing');
  });

  it('refuses a plan that skips a known consumer', () => {
    // "All consumers should review" is not an impact assessment.
    expect(
      problemsFrom({
        analysis: breaking(),
        plan: plan(),
        knownConsumerIds: ['con_partner_a', 'con_partner_b'],
      }),
    ).toContain('con_partner_b');
  });

  it('refuses a plan whose consumers have not been told', () => {
    expect(
      problemsFrom({
        analysis: breaking(),
        plan: plan({
          consumerImpacts: [
            {
              consumerId: 'con_partner_a',
              impact: 'Calls /api/merchants on every page load and must update the path.',
            },
          ],
        }),
      }),
    ).toContain('not been notified');
  });

  it('accepts a complete one', () => {
    expect(() =>
      assertReleasable({ analysis: breaking(), plan: plan(), knownConsumerIds: ['con_partner_a'] }),
    ).not.toThrow();
  });

  it('requires an approved reason for short notice', () => {
    // Sometimes a security fix cannot wait ninety days. Somebody still signs for it.
    expect(() => plan({ deprecationPeriodDays: 14 })).toThrow(
      new RegExp(String(MINIMUM_DEPRECATION_DAYS)),
    );

    expect(
      plan({
        deprecationPeriodDays: 14,
        shortNoticeReason: 'The old path leaks merchant identifiers to an unauthenticated caller.',
        shortNoticeApprovedBy: 'usr_ciso',
      }).deprecationPeriodDays,
    ).toBe(14);
  });

  it('does not require a plan for an additive change', () => {
    const additive = analyseCompatibility(
      api(),
      api({
        version: '1.1.0',
        operations: [
          operation(),
          operation({ operationId: 'getMerchant', path: '/api/merchants/:id' }),
        ],
      }),
    );

    expect(() => assertReleasable({ analysis: additive, plan: null })).not.toThrow();
  });
});

describe('chasing consumers', () => {
  it('lists who has not acknowledged, longest wait first', () => {
    /*
     * What turns a deprecation from a date into a conversation. A consumer notified ninety days
     * ago who never acknowledged has almost certainly not read it.
     */
    const outstanding = unacknowledgedConsumers(
      plan({
        consumerImpacts: [
          {
            consumerId: 'con_partner_a',
            impact: 'Calls /api/merchants on every page load and must update the path.',
            notifiedAt: '2026-03-01T00:00:00.000Z',
          },
          {
            consumerId: 'con_partner_b',
            impact: 'Calls /api/merchants nightly in a batch job.',
            notifiedAt: '2026-05-01T00:00:00.000Z',
            acknowledgedAt: '2026-05-02T00:00:00.000Z',
          },
        ],
      }),
      new Date('2026-06-01T00:00:00.000Z'),
    );

    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]?.consumerId).toBe('con_partner_a');
    expect(outstanding[0]?.daysSinceNotified).toBe(92);
  });

  it('reports a consumer who was never notified at all', () => {
    const outstanding = unacknowledgedConsumers(
      plan({
        consumerImpacts: [
          {
            consumerId: 'con_partner_c',
            impact: 'Calls the removed operation from a mobile client.',
          },
        ],
      }),
      new Date('2026-06-01T00:00:00.000Z'),
    );

    expect(outstanding[0]?.daysSinceNotified).toBeNull();
  });
});
