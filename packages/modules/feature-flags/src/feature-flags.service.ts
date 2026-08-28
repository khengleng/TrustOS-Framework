import { ApiError } from '@trustos/errors';
import type { ModuleContext } from '@trustos/module-sdk';
import type { FeatureFlagsConfig } from './config';
import { evaluateFlag, type Evaluation } from './evaluate';
import type { FeatureFlagOverrideRow, FeatureFlagRow, FeatureFlagStore } from './store';

/**
 * Feature flags for one application.
 *
 * Flags are per-organization rows, so "tenant-specific" is not a mode — it is the
 * only thing a flag can be. There is no platform-wide flag that a single mistake
 * could enable for every customer at once.
 *
 * `evaluate` is the hot path and does no writing unless the organization has asked
 * for evaluation audit. Everything it depends on is a pure function in
 * `evaluate.ts`, which is where the ordering rules are stated and tested.
 */

export interface CreateFlagInput {
  key: string;
  description: string;
  enabled?: boolean;
  rolloutPercentage?: number;
  environments?: string[];
  expiresAt?: Date | null;
}

export interface EvaluateOptions {
  subjectId?: string | null;
}

export class FeatureFlagsService {
  constructor(
    private readonly context: ModuleContext<FeatureFlagsConfig>,
    private readonly store: FeatureFlagStore,
  ) {}

  list(): Promise<FeatureFlagRow[]> {
    return this.store.list();
  }

  async find(key: string): Promise<FeatureFlagRow> {
    const flag = await this.store.findByKey(key);
    if (!flag) throw ApiError.notFound(`No feature flag with key "${key}".`);
    return flag;
  }

  async create(input: CreateFlagInput, organizationId: string): Promise<FeatureFlagRow> {
    const config = await this.context.resolveConfig(organizationId);
    this.assertExpiryWithinLimit(input.expiresAt ?? null, config);

    if (await this.store.findByKey(input.key)) {
      throw ApiError.conflict(`A feature flag with key "${input.key}" already exists.`);
    }

    const flag = await this.store.create({
      key: input.key,
      description: input.description,
      // A new flag is off unless it says otherwise: a flag created enabled has
      // shipped the feature before anyone reviewed the rollout.
      enabled: input.enabled ?? false,
      rolloutPercentage: input.rolloutPercentage ?? 0,
      environments: input.environments ?? [],
      expiresAt: input.expiresAt ?? null,
    });

    await this.context.audit.record({
      action: 'feature-flags.flag.created',
      entityType: 'FeatureFlag',
      entityId: flag.id,
      organizationId,
      after: this.snapshot(flag),
    });

    return flag;
  }

  async update(
    key: string,
    input: Partial<CreateFlagInput>,
    organizationId: string,
  ): Promise<FeatureFlagRow> {
    const config = await this.context.resolveConfig(organizationId);
    const existing = await this.find(key);

    if (input.expiresAt !== undefined) this.assertExpiryWithinLimit(input.expiresAt, config);

    // Snapshot before the write. Turning a flag on for 100% of an organization is
    // a change an incident review will ask about, and the trail has to show what
    // it was before.
    const before = this.snapshot(existing);

    const updated = await this.store.update(existing.id, {
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.rolloutPercentage === undefined
        ? {}
        : { rolloutPercentage: input.rolloutPercentage }),
      ...(input.environments === undefined ? {} : { environments: input.environments }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });

    await this.context.audit.record({
      action: 'feature-flags.flag.updated',
      entityType: 'FeatureFlag',
      entityId: existing.id,
      organizationId,
      before,
      after: this.snapshot(updated),
    });

    return updated;
  }

  async remove(key: string, organizationId: string): Promise<FeatureFlagRow> {
    const existing = await this.find(key);
    const removed = await this.store.softDelete(existing.id, this.context.clock());

    await this.context.audit.record({
      action: 'feature-flags.flag.deleted',
      entityType: 'FeatureFlag',
      entityId: existing.id,
      organizationId,
      before: this.snapshot(existing),
    });

    return removed;
  }

  /**
   * Pins a subject on or off, regardless of the rollout percentage.
   *
   * The only way an evaluation can return true against a partial rollout, and it
   * requires a row someone deliberately created.
   */
  async setOverride(
    key: string,
    subjectId: string,
    enabled: boolean,
    organizationId: string,
  ): Promise<FeatureFlagOverrideRow> {
    const flag = await this.find(key);

    const override = await this.store.upsertOverride({
      flagKey: flag.key,
      subjectId,
      enabled,
    });

    await this.context.audit.record({
      action: 'feature-flags.flag.updated',
      entityType: 'FeatureFlag',
      entityId: flag.id,
      organizationId,
      after: { key: flag.key, override: { subjectId, enabled } },
    });

    return override;
  }

  listOverrides(key: string): Promise<FeatureFlagOverrideRow[]> {
    return this.store.listOverrides(key);
  }

  /**
   * Evaluates a flag for a subject.
   *
   * An unknown flag evaluates to off rather than raising: a typo in a flag key
   * must not take down the code path that was gated by it, and it must not enable
   * the feature either.
   */
  async evaluate(
    key: string,
    organizationId: string,
    options: EvaluateOptions = {},
  ): Promise<Evaluation> {
    const config = await this.context.resolveConfig(organizationId);
    const flag = await this.store.findByKey(key);

    const override = options.subjectId
      ? await this.store.findOverride(key, options.subjectId)
      : null;

    const evaluation = evaluateFlag(
      {
        flag,
        subjectId: options.subjectId ?? null,
        environment: this.context.environment,
        now: this.context.clock(),
        salt: config.rolloutSalt,
      },
      override ? override.enabled : null,
    );

    if (config.auditEvaluations) {
      await this.context.audit.record({
        action: 'feature-flags.flag.evaluated',
        entityType: 'FeatureFlag',
        entityId: flag?.id ?? null,
        organizationId,
        after: {
          key,
          enabled: evaluation.enabled,
          reason: evaluation.reason,
          subjectId: options.subjectId ?? null,
        },
      });
    }

    return evaluation;
  }

  /** Convenience for call sites that only need the boolean. */
  async isEnabled(
    key: string,
    organizationId: string,
    options: EvaluateOptions = {},
  ): Promise<boolean> {
    return (await this.evaluate(key, organizationId, options)).enabled;
  }

  // --- internals ------------------------------------------------------------

  private snapshot(flag: FeatureFlagRow): Record<string, unknown> {
    return {
      key: flag.key,
      enabled: flag.enabled,
      rolloutPercentage: flag.rolloutPercentage,
      environments: flag.environments,
      expiresAt: flag.expiresAt ? flag.expiresAt.toISOString() : null,
    };
  }

  private assertExpiryWithinLimit(expiresAt: Date | null, config: FeatureFlagsConfig): void {
    if (!expiresAt) return;

    const now = this.context.clock();
    if (expiresAt.getTime() <= now.getTime()) {
      const message = 'The expiry date is in the past.';
      throw ApiError.validation([{ path: 'expiresAt', message }], message);
    }

    const days = (expiresAt.getTime() - now.getTime()) / (24 * 60 * 60_000);
    if (days > config.maxExpiryDays) {
      // A flag with a ten-year expiry is a permanent branch in the code with a
      // date attached, which is the state flags are supposed to prevent.
      const message = `The expiry date is more than ${config.maxExpiryDays} days away.`;
      throw ApiError.validation([{ path: 'expiresAt', message }], message);
    }
  }
}
