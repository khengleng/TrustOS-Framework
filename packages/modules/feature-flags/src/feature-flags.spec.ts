import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@trustsystem/errors';
import { createTestModuleContext, type RecordingAuditPort } from '@trustsystem/module-sdk';
import { FakeModelDelegate, runInTenantContext } from '@trustsystem/tenancy';
import { featureFlagsConfigSchema } from './config';
import { bucketOf, evaluateFlag } from './evaluate';
import { createFeatureFlags, featureFlagsModule } from './feature-flags.module';
import type { FeatureFlagsService } from './feature-flags.service';

const ACME = 'org_acme';
const RIVAL = 'org_rival';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const timestamps = {
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

interface Harness {
  service: FeatureFlagsService;
  audit: RecordingAuditPort;
  flags: FakeModelDelegate;
}

function buildHarness(
  config: Record<string, unknown> = {},
  environment: 'development' | 'test' | 'production' = 'test',
): Harness {
  const flags = new FakeModelDelegate([
    {
      id: 'flag_rival',
      organizationId: RIVAL,
      key: 'new-checkout',
      description: 'Rival flag',
      enabled: true,
      rolloutPercentage: 100,
      environments: [],
      expiresAt: null,
      ...timestamps,
    },
  ]);
  const overrides = new FakeModelDelegate([]);

  const { context, audit } = createTestModuleContext(featureFlagsModule, {
    config,
    environment,
    now: NOW,
    prisma: { featureFlag: flags, featureFlagOverride: overrides },
  });

  return { service: createFeatureFlags(context).service, audit, flags };
}

const asAcme = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: ACME, actorId: 'user_1', isSuperAdmin: false }, fn);

const asRival = <T>(fn: () => Promise<T>): Promise<T> =>
  runInTenantContext({ organizationId: RIVAL, actorId: 'user_2', isSuperAdmin: false }, fn);

const create = (harness: Harness, overrides: Record<string, unknown> = {}) =>
  asAcme(() =>
    harness.service.create(
      {
        key: 'new-checkout',
        description: 'The new checkout flow.',
        ...overrides,
      },
      ACME,
    ),
  );

describe('evaluateFlag ordering', () => {
  const base = {
    key: 'new-checkout',
    enabled: true,
    rolloutPercentage: 100,
    environments: [] as string[],
    expiresAt: null as Date | null,
  };

  const input = (flag: typeof base | null, extra: Record<string, unknown> = {}) => ({
    flag,
    environment: 'production' as const,
    now: NOW,
    salt: 'salt',
    subjectId: 'user_1',
    ...extra,
  });

  it('returns off for an unknown flag', () => {
    // A typo in a flag key must not enable a feature.
    expect(evaluateFlag(input(null))).toEqual({
      enabled: false,
      reason: 'unknown_flag',
      bucket: null,
    });
  });

  it('returns off once a flag has expired, without anyone deleting it', () => {
    const expired = { ...base, expiresAt: new Date('2025-12-31T00:00:00.000Z') };
    expect(evaluateFlag(input(expired)).reason).toBe('expired');
  });

  it('checks expiry before an override, so an expired flag stays off', () => {
    const expired = { ...base, expiresAt: new Date('2025-12-31T00:00:00.000Z') };
    expect(evaluateFlag(input(expired), true).enabled).toBe(false);
  });

  it('checks the environment before an override', () => {
    // Otherwise a per-subject allow-list in staging leaks the feature into
    // production.
    const staging = { ...base, environments: ['development'] };
    expect(evaluateFlag(input(staging), true).enabled).toBe(false);
    expect(evaluateFlag(input(staging)).reason).toBe('environment_excluded');
  });

  it('lets an override beat a partial rollout, in both directions', () => {
    const partial = { ...base, rolloutPercentage: 1 };
    expect(evaluateFlag(input(partial), true)).toMatchObject({
      enabled: true,
      reason: 'subject_override',
    });

    const full = { ...base, rolloutPercentage: 100 };
    expect(evaluateFlag(input(full), false)).toMatchObject({
      enabled: false,
      reason: 'subject_override',
    });
  });

  it('honours the master switch', () => {
    expect(evaluateFlag(input({ ...base, enabled: false })).reason).toBe('disabled');
  });

  it('is off for a partial rollout with nothing to bucket', () => {
    // Guessing would make the flag flap from request to request.
    expect(
      evaluateFlag(input({ ...base, rolloutPercentage: 50 }, { subjectId: null })),
    ).toMatchObject({ enabled: false, reason: 'no_subject' });
  });

  it('treats 100 as on and 0 as off without bucketing', () => {
    expect(evaluateFlag(input(base)).reason).toBe('full_rollout');
    expect(evaluateFlag(input({ ...base, rolloutPercentage: 0 })).reason).toBe('no_rollout');
  });
});

describe('bucketOf', () => {
  it('is stable for the same subject, flag and salt', () => {
    // A random draw per request would flicker the feature in and out mid-session.
    expect(bucketOf('salt', 'flag-a', 'user_1')).toBe(bucketOf('salt', 'flag-a', 'user_1'));
  });

  it('gives independent buckets per flag', () => {
    // Otherwise the same unlucky cohort receives every experiment.
    const a = bucketOf('salt', 'flag-a', 'user_1');
    const b = bucketOf('salt', 'flag-b', 'user_1');
    expect(a).not.toBe(b);
  });

  it('changes with the salt, so environments do not share a cohort', () => {
    expect(bucketOf('salt-a', 'flag', 'user_1')).not.toBe(bucketOf('salt-b', 'flag', 'user_1'));
  });

  it('stays inside [0, 100)', () => {
    for (let index = 0; index < 200; index += 1) {
      const bucket = bucketOf('salt', 'flag', `user_${index}`);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  it('spreads subjects roughly evenly', () => {
    const subjects = Array.from({ length: 2000 }, (_, index) => `user_${index}`);
    const inFirstHalf = subjects.filter((subject) => bucketOf('salt', 'flag', subject) < 50).length;

    // A hash that clustered would make a 50% rollout reach 5% of users.
    expect(inFirstHalf).toBeGreaterThan(900);
    expect(inFirstHalf).toBeLessThan(1100);
  });

  it('is monotonic: raising a percentage only adds subjects', () => {
    const subjects = Array.from({ length: 500 }, (_, index) => `user_${index}`);
    const at = (percentage: number) =>
      new Set(subjects.filter((subject) => bucketOf('salt', 'flag', subject) < percentage));

    const ten = at(10);
    const twenty = at(20);
    // Nobody who had the feature loses it when the rollout widens.
    for (const subject of ten) expect(twenty.has(subject)).toBe(true);
  });
});

describe('flag management', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('creates a flag off by default', async () => {
    const flag = await create(harness);
    // A flag created enabled has shipped the feature before anyone reviewed the
    // rollout.
    expect(flag.enabled).toBe(false);
    expect(flag.rolloutPercentage).toBe(0);
  });

  it('audits creation, update and deletion with before and after', async () => {
    await create(harness);
    await asAcme(() =>
      harness.service.update('new-checkout', { enabled: true, rolloutPercentage: 100 }, ACME),
    );
    await asAcme(() => harness.service.remove('new-checkout', ACME));

    expect(harness.audit.records.map((record) => record.action)).toEqual([
      'feature-flags.flag.created',
      'feature-flags.flag.updated',
      'feature-flags.flag.deleted',
    ]);

    const update = harness.audit.byAction('feature-flags.flag.updated')[0];
    expect(update?.before).toMatchObject({ enabled: false, rolloutPercentage: 0 });
    expect(update?.after).toMatchObject({ enabled: true, rolloutPercentage: 100 });
  });

  it('refuses a duplicate key within an organization', async () => {
    await create(harness);
    await expect(create(harness)).rejects.toThrow(/already exists/);
  });

  it('rejects an expiry in the past', async () => {
    await expect(
      create(harness, { expiresAt: new Date('2025-01-01T00:00:00.000Z') }),
    ).rejects.toThrow(/in the past/);
  });

  it('rejects an expiry beyond the configured limit', async () => {
    const short = buildHarness({ maxExpiryDays: 30 });
    // A flag with a ten-year expiry is a permanent branch in the code with a date
    // attached, which is the state flags are supposed to prevent.
    await expect(
      create(short, { expiresAt: new Date('2027-01-01T00:00:00.000Z') }),
    ).rejects.toThrow(/more than 30 days/);
  });

  it('reports an unknown flag as not_found when read directly', async () => {
    try {
      await asAcme(() => harness.service.find('nope'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('not_found');
    }
  });
});

describe('evaluation through the service', () => {
  it('evaluates off for an unknown flag rather than raising', async () => {
    const harness = buildHarness();
    // A typo must not take down the code path that was gated by the flag.
    expect(await asAcme(() => harness.service.isEnabled('nope', ACME))).toBe(false);
  });

  it('applies a per-subject override', async () => {
    const harness = buildHarness();
    await create(harness, { enabled: true, rolloutPercentage: 0 });

    expect(
      await asAcme(() => harness.service.isEnabled('new-checkout', ACME, { subjectId: 'u1' })),
    ).toBe(false);

    await asAcme(() => harness.service.setOverride('new-checkout', 'u1', true, ACME));

    expect(
      await asAcme(() => harness.service.isEnabled('new-checkout', ACME, { subjectId: 'u1' })),
    ).toBe(true);
    expect(
      await asAcme(() => harness.service.isEnabled('new-checkout', ACME, { subjectId: 'u2' })),
    ).toBe(false);
  });

  it('scopes an environment restriction to the running environment', async () => {
    const inTest = buildHarness({}, 'test');
    await create(inTest, { enabled: true, rolloutPercentage: 100, environments: ['production'] });

    expect(await asAcme(() => inTest.service.isEnabled('new-checkout', ACME))).toBe(false);

    const inProduction = buildHarness({}, 'production');
    await create(inProduction, {
      enabled: true,
      rolloutPercentage: 100,
      environments: ['production'],
    });
    expect(await asAcme(() => inProduction.service.isEnabled('new-checkout', ACME))).toBe(true);
  });

  it('does not audit evaluations by default', async () => {
    const harness = buildHarness();
    await create(harness, { enabled: true, rolloutPercentage: 100 });
    harness.audit.clear();

    await asAcme(() => harness.service.evaluate('new-checkout', ACME, { subjectId: 'u1' }));
    // Evaluations are hot; the volume would drown the rest of the trail.
    expect(harness.audit.records).toHaveLength(0);
  });

  it('audits evaluations when the organization asks for it', async () => {
    const harness = buildHarness({ auditEvaluations: true });
    await create(harness, { enabled: true, rolloutPercentage: 100 });
    harness.audit.clear();

    await asAcme(() => harness.service.evaluate('new-checkout', ACME, { subjectId: 'u1' }));

    expect(harness.audit.byAction('feature-flags.flag.evaluated')[0]?.after).toMatchObject({
      key: 'new-checkout',
      enabled: true,
      reason: 'full_rollout',
    });
  });

  it('returns the reason, so a caller can tell why a feature is off', async () => {
    const harness = buildHarness();
    await create(harness, { enabled: false });

    expect((await asAcme(() => harness.service.evaluate('new-checkout', ACME))).reason).toBe(
      'disabled',
    );
  });
});

describe('feature-flags tenant isolation', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('keeps a flag key independent between organizations', async () => {
    // RIVAL has `new-checkout` on for everyone; ACME creating its own must not see
    // or be affected by it.
    const acme = await create(harness);
    expect(acme.organizationId).toBe(ACME);
    expect(await asAcme(() => harness.service.isEnabled('new-checkout', ACME))).toBe(false);
    expect(await asRival(() => harness.service.isEnabled('new-checkout', RIVAL))).toBe(true);
  });

  it('lists only the calling organization flags', async () => {
    await create(harness);

    expect((await asAcme(() => harness.service.list())).map((row) => row.description)).toEqual([
      'The new checkout flow.',
    ]);
    expect((await asRival(() => harness.service.list())).map((row) => row.description)).toEqual([
      'Rival flag',
    ]);
  });

  it('cannot read, update or remove another organization flag', async () => {
    // ACME has no flag with this key; RIVAL's must be invisible rather than
    // reachable.
    await expect(asAcme(() => harness.service.find('new-checkout'))).rejects.toThrow(
      /No feature flag/,
    );
    await expect(
      asAcme(() => harness.service.update('new-checkout', { enabled: false }, ACME)),
    ).rejects.toThrow();
    await expect(asAcme(() => harness.service.remove('new-checkout', ACME))).rejects.toThrow();

    expect(harness.flags.snapshot().find((row) => row.id === 'flag_rival')?.enabled).toBe(true);
  });

  it('fails closed when there is no tenant context at all', async () => {
    await expect(harness.service.list()).rejects.toThrow(/Organization context is required/);
  });

  it('attributes every audit record to the acting organization', async () => {
    await create(harness);
    expect(harness.audit.records.every((record) => record.organizationId === ACME)).toBe(true);
  });
});

describe('configuration validation', () => {
  it('installs with no configuration at all', () => {
    expect(featureFlagsConfigSchema.parse({})).toEqual({
      rolloutSalt: 'trustos-default-salt',
      auditEvaluations: false,
      maxExpiryDays: 365,
    });
  });

  it('rejects an unknown configuration key rather than ignoring it', () => {
    expect(featureFlagsConfigSchema.safeParse({ salt: 'x' }).success).toBe(false);
  });

  it('rejects an empty rollout salt', () => {
    expect(featureFlagsConfigSchema.safeParse({ rolloutSalt: '' }).success).toBe(false);
  });
});

describe('lifecycle', () => {
  it('refuses to start without a database', async () => {
    const { context } = createTestModuleContext(featureFlagsModule, { prisma: null });
    await expect(createFeatureFlags(context).initialize()).rejects.toThrow(/needs a database/);
  });

  it('starts with the default salt, warning rather than refusing', async () => {
    const { context } = createTestModuleContext(featureFlagsModule, {
      environment: 'production',
      prisma: { featureFlag: new FakeModelDelegate([]) },
    });

    // The default salt is not a security problem: it decides which subjects land
    // in a rollout, not who is allowed in.
    await expect(createFeatureFlags(context).initialize()).resolves.toBeUndefined();
  });
});
