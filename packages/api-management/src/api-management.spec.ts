import { describe, expect, it } from 'vitest';
import { ApiCatalog, apiDefinitionSchema } from '@trustsystem/api-catalog';
import { ConsumerRegistry, consumerSchema } from '@trustsystem/api-consumer';
import { InMemoryQuotaUsageStore, quotaSchema } from '@trustsystem/api-quota';
import { InMemoryRateCounterStore, rateLimitSchema } from '@trustsystem/api-rate-limit';
import { classificationCeilingPolicy } from '@trustsystem/api-policy';
import { ApiGateway, InMemoryAnalyticsSink, summariseAnalytics } from './index';

const NOW = new Date('2026-06-20T12:00:00.000Z');

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'listMerchants',
    method: 'GET',
    path: '/api/merchants',
    summary: 'Lists the merchants in the calling organization.',
    scopes: ['merchants:read'],
    classification: 'CONFIDENTIAL',
    idempotent: true,
    deprecated: false,
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

function consumer(overrides: Record<string, unknown> = {}) {
  return consumerSchema.parse({
    consumerId: 'con_partner_a',
    name: 'Partner A',
    kind: 'partner',
    description: 'An onboarding partner that reconciles merchant records against its own system.',
    organizationId: 'org_platform',
    environment: 'production',
    entitlements: [
      {
        apiId: 'merchant.api',
        majorVersion: 1,
        scopes: ['merchants:read'],
        grantedBy: 'usr_governance',
        grantedAt: '2026-01-15T00:00:00.000Z',
        expiresAt: '2027-01-15T00:00:00.000Z',
        justification:
          'The partner reconciles merchant records against their own onboarding system nightly.',
      },
    ],
    credentialIds: ['key_001'],
    planId: 'plan_partner',
    status: 'active',
    ownerId: 'usr_partnerships',
    technicalContact: 'integrations@partner-a.example',
    createdAt: '2026-01-15T00:00:00.000Z',
    lastReviewedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  });
}

function quota(overrides: Record<string, unknown> = {}) {
  return quotaSchema.parse({
    quotaId: 'q.partner_a.monthly',
    scope: 'consumer',
    subjectId: 'con_partner_a',
    apiId: 'merchant.api',
    period: 'monthly',
    resetDayOfMonth: 15,
    limit: 3,
    description: 'The monthly call allowance in the partner plan.',
    ...overrides,
  });
}

function rateLimit(overrides: Record<string, unknown> = {}) {
  return rateLimitSchema.parse({
    limitId: 'rl.consumer',
    scope: 'consumer',
    apiId: 'merchant.api',
    limit: 5,
    unit: 'minute',
    description: 'The default sustained rate for a partner consumer.',
    ...overrides,
  });
}

function gateway(overrides: Record<string, unknown> = {}) {
  const analytics = new InMemoryAnalyticsSink();
  const audited: Array<Record<string, unknown>> = [];

  const gate = new ApiGateway({
    catalog: new ApiCatalog([api()]),
    consumers: new ConsumerRegistry([consumer()]),
    rateLimits: [rateLimit()],
    rateStore: new InMemoryRateCounterStore(),
    quotaFor: () => quota(),
    quotaStore: new InMemoryQuotaUsageStore(),
    analytics,
    audit: {
      record: async (input) => {
        audited.push(input as unknown as Record<string, unknown>);
      },
    },
    ...overrides,
  });

  return { gate, analytics, audited };
}

function call(overrides: Record<string, unknown> = {}) {
  return {
    apiId: 'merchant.api',
    version: '1.0.0',
    method: 'GET',
    path: '/api/merchants',
    consumerId: 'con_partner_a',
    at: NOW,
    correlationId: 'cor_1',
    ...overrides,
  };
}

describe('the gate', () => {
  it('allows a well-formed entitled call', async () => {
    const { gate } = gateway();
    expect((await gate.check(call())).allowed).toBe(true);
  });

  it('refuses an undeclared operation before anything else runs', async () => {
    /*
     * A request for something the catalog does not declare should not reach the consumer registry,
     * the policy engine or — especially — the quota counter.
     */
    const { gate, analytics } = gateway();
    const result = await gate.check(call({ path: '/api/merchants/mer_1/secrets' }));

    expect(result.refusedAt).toBe('catalog');
    expect(analytics.entries[0]?.reasonCode).toBe('operation_not_declared');
  });

  it('refuses an unregistered consumer', async () => {
    const { gate } = gateway();
    expect((await gate.check(call({ consumerId: 'con_unknown' }))).reasonCode).toBe(
      'consumer_not_registered',
    );
  });

  it('refuses an unentitled consumer at the entitlement stage', async () => {
    const { gate } = gateway({ consumers: new ConsumerRegistry([consumer({ entitlements: [] })]) });
    expect((await gate.check(call())).refusedAt).toBe('entitlement');
  });
});

describe('the order of the stages', () => {
  it('does not spend quota on a call it refuses', async () => {
    /*
     * The property the ordering exists for. Counting quota before authorization means a
     * misconfigured integration hammering a 403 exhausts the quota of the party it was refused
     * for — and if the quota is billable, that is an argument about money.
     */
    const quotaStore = new InMemoryQuotaUsageStore();
    const { gate } = gateway({
      consumers: new ConsumerRegistry([consumer({ entitlements: [] })]),
      quotaStore,
    });

    await gate.check(call());
    await gate.check(call());

    expect(await quotaStore.read('q.partner_a.monthly', '2026-06')).toBe(0);
  });

  it('reports a burst as a rate breach, not as an exhausted quota', async () => {
    /*
     * Rate before quota. A rate breach is transient and a quota breach is not; telling a caller
     * their quota is exhausted when they merely burst is a support ticket.
     */
    const { gate } = gateway({ rateLimits: [rateLimit({ limit: 1 })] });

    await gate.check(call());
    expect((await gate.check(call())).refusedAt).toBe('rate');
  });

  it('refuses once the quota is genuinely used up', async () => {
    const { gate } = gateway();

    for (let index = 0; index < 3; index += 1) await gate.check(call());
    const result = await gate.check(call());

    expect(result.refusedAt).toBe('quota');
    expect(result.headers['Quota-Remaining']).toBe('0');
  });

  it('lets a policy refuse a call the entitlement permits', async () => {
    /*
     * Configuration above the code floor. The consumer is entitled; the deployment's policy still
     * says no, because the operation returns data above the ceiling for its kind.
     */
    const restricted = api({ operations: [operation({ classification: 'RESTRICTED' })] });

    const { gate } = gateway({
      catalog: new ApiCatalog([restricted]),
      policies: [
        {
          ...classificationCeilingPolicy({
            owner: 'usr_platform',
            effectiveDate: '2026-01-01T00:00:00.000Z',
            reviewDate: '2026-12-31T00:00:00.000Z',
          }),
          status: 'active' as const,
        },
      ],
    });

    const result = await gate.check(call());
    expect(result.refusedAt).toBe('policy');
  });
});

describe('what gets recorded', () => {
  it('counts refusals as well as successes', async () => {
    // A refusal that is not counted is a credential being probed and nobody knowing.
    const { gate, analytics } = gateway();

    await gate.check(call());
    await gate.check(call({ consumerId: 'con_unknown' }));

    expect(analytics.entries).toHaveLength(2);
    expect(analytics.entries.map((entry) => entry.outcome)).toEqual(['allowed', 'refused']);
  });

  it('audits an authorization refusal', async () => {
    const { gate, audited } = gateway({
      consumers: new ConsumerRegistry([consumer({ entitlements: [] })]),
    });
    await gate.check(call());

    expect(audited[0]?.action).toBe('api.access.refused');
    expect((audited[0]?.metadata as Record<string, unknown>).stage).toBe('entitlement');
  });

  it('does not audit a rate-limit refusal', async () => {
    /*
     * Exceeding a limit is normal traffic. Burying an entitlement refusal among ten thousand
     * rate-limit entries is how the interesting one goes unnoticed.
     */
    const { gate, audited } = gateway({ rateLimits: [rateLimit({ limit: 1 })] });

    await gate.check(call());
    await gate.check(call());

    expect(audited).toHaveLength(0);
  });

  it('does not audit successful calls', async () => {
    // An audit trail with one entry per API call is an audit trail nobody reads.
    const { gate, audited } = gateway();
    await gate.check(call());

    expect(audited).toHaveLength(0);
  });

  it('carries the correlation id through', async () => {
    const { gate, analytics } = gateway();
    await gate.check(call());

    expect(analytics.entries[0]?.correlationId).toBe('cor_1');
  });
});

describe('throwing', () => {
  it('throws not_found for an unknown API', async () => {
    const { gate } = gateway();
    await expect(gate.assertAllowed(call({ apiId: 'wallet.api' }))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('throws forbidden for an entitlement refusal', async () => {
    const { gate } = gateway({ consumers: new ConsumerRegistry([consumer({ entitlements: [] })]) });
    await expect(gate.assertAllowed(call())).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('throws rate_limited for an exhausted quota', async () => {
    const { gate } = gateway();
    for (let index = 0; index < 3; index += 1) await gate.check(call());

    await expect(gate.assertAllowed(call())).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('analytics', () => {
  it('counts deprecated use, which is what makes a retirement date actionable', async () => {
    const { gate, analytics } = gateway({
      catalog: new ApiCatalog([api({ operations: [operation({ deprecated: true })] })]),
    });

    await gate.check(call());
    expect(summariseAnalytics(analytics.entries).deprecatedCalls).toBe(1);
  });

  it('surfaces a consumer generating authorization failures', async () => {
    /*
     * The number worth alerting on: a consumer suddenly failing authorization is either a broken
     * deployment or a credential being probed, and both want a person.
     */
    const { gate, analytics } = gateway({
      consumers: new ConsumerRegistry([consumer({ entitlements: [] })]),
    });

    await gate.check(call());
    await gate.check(call());

    const summary = summariseAnalytics(analytics.entries);
    expect(summary.unauthorizedAttempts[0]).toEqual({ consumerId: 'con_partner_a', attempts: 2 });
  });

  it('breaks refusals down by the stage that refused', async () => {
    const { gate, analytics } = gateway({ rateLimits: [rateLimit({ limit: 1 })] });

    await gate.check(call());
    await gate.check(call());
    await gate.check(call({ apiId: 'wallet.api' }));

    const summary = summariseAnalytics(analytics.entries);
    expect(summary.refusalsByStage).toEqual({ rate: 1, catalog: 1 });
  });

  it('reads usage without consuming it', async () => {
    const { gate } = gateway();
    await gate.check(call());

    const usage = await (
      await gate.usageFor({
        consumerId: 'con_partner_a',
        apiId: 'merchant.api',
        version: '1.0.0',
        at: NOW,
      })
    ).quota;

    expect(usage?.used).toBe(1);
  });
});
