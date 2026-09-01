import { ModuleRepository, type ModuleContext } from '@trustsystem/module-sdk';
import type { FeatureFlagsConfig } from './config';

/** Where flags and per-subject overrides live. */

export interface FeatureFlagRow {
  id: string;
  organizationId: string;
  key: string;
  description: string;
  enabled: boolean;
  rolloutPercentage: number;
  /** Empty means every environment. */
  environments: string[];
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * A pinned decision for one subject.
 *
 * The reason this table exists rather than being folded into the flag row: an
 * allow-list of beta testers is per-subject data with its own lifetime, and
 * storing it as an array on the flag would make adding one tester a rewrite of the
 * flag — losing the audit granularity of who was added when.
 */
export interface FeatureFlagOverrideRow {
  id: string;
  organizationId: string;
  flagKey: string;
  subjectId: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface FeatureFlagStore {
  list(): Promise<FeatureFlagRow[]>;
  findByKey(key: string): Promise<FeatureFlagRow | null>;
  create(
    row: Omit<FeatureFlagRow, 'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<FeatureFlagRow>;
  update(id: string, patch: Partial<FeatureFlagRow>): Promise<FeatureFlagRow>;
  softDelete(id: string, now: Date): Promise<FeatureFlagRow>;

  findOverride(flagKey: string, subjectId: string): Promise<FeatureFlagOverrideRow | null>;
  listOverrides(flagKey: string): Promise<FeatureFlagOverrideRow[]>;
  upsertOverride(
    row: Omit<
      FeatureFlagOverrideRow,
      'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
    >,
  ): Promise<FeatureFlagOverrideRow>;
}

export class PrismaFeatureFlagStore implements FeatureFlagStore {
  private readonly flags: ModuleRepository<FeatureFlagRow>;
  private readonly overrides: ModuleRepository<FeatureFlagOverrideRow>;

  constructor(context: ModuleContext<FeatureFlagsConfig>) {
    const { prisma, moduleId } = context;
    this.flags = new ModuleRepository(prisma, 'featureFlag', moduleId);
    this.overrides = new ModuleRepository(prisma, 'featureFlagOverride', moduleId);
  }

  list(): Promise<FeatureFlagRow[]> {
    return this.flags.list({ orderBy: { key: 'asc' } });
  }

  findByKey(key: string): Promise<FeatureFlagRow | null> {
    return this.flags.findFirst({ key });
  }

  create(
    row: Omit<FeatureFlagRow, 'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<FeatureFlagRow> {
    return this.flags.create({ ...row });
  }

  update(id: string, patch: Partial<FeatureFlagRow>): Promise<FeatureFlagRow> {
    return this.flags.update(id, { ...patch });
  }

  softDelete(id: string, now: Date): Promise<FeatureFlagRow> {
    return this.flags.softDelete(id, now);
  }

  findOverride(flagKey: string, subjectId: string): Promise<FeatureFlagOverrideRow | null> {
    return this.overrides.findFirst({ flagKey, subjectId });
  }

  listOverrides(flagKey: string): Promise<FeatureFlagOverrideRow[]> {
    return this.overrides.list({ where: { flagKey } });
  }

  async upsertOverride(
    row: Omit<
      FeatureFlagOverrideRow,
      'id' | 'organizationId' | 'createdAt' | 'updatedAt' | 'deletedAt'
    >,
  ): Promise<FeatureFlagOverrideRow> {
    const existing = await this.overrides.findFirst({
      flagKey: row.flagKey,
      subjectId: row.subjectId,
    });

    return existing
      ? this.overrides.update(existing.id, { enabled: row.enabled })
      : this.overrides.create({ ...row });
  }
}
