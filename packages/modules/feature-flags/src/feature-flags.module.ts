import { moduleDeclarations } from '@trustsystem/module-registry';
import {
  defineModule,
  moduleHealthIndicator,
  type HealthIndicator,
  type ModuleContext,
  type ModuleInstance,
} from '@trustsystem/module-sdk';
import { featureFlagsConfigSchema, type FeatureFlagsConfig } from './config';
import { FeatureFlagsService } from './feature-flags.service';
import { PrismaFeatureFlagStore, type FeatureFlagStore } from './store';

export interface FeatureFlagsInstance extends ModuleInstance {
  readonly service: FeatureFlagsService;
}

export interface FeatureFlagsOverrides {
  store?: FeatureFlagStore;
}

export function createFeatureFlags(
  context: ModuleContext<FeatureFlagsConfig>,
  overrides: FeatureFlagsOverrides = {},
): FeatureFlagsInstance {
  const store = overrides.store ?? new PrismaFeatureFlagStore(context);
  const service = new FeatureFlagsService(context, store);

  return {
    moduleId: 'feature-flags',
    service,

    async initialize(): Promise<void> {
      if (!context.prisma && !overrides.store) {
        throw new Error(
          'feature-flags needs a database. Run the module migration and provide the Prisma client.',
        );
      }

      if (
        context.environment === 'production' &&
        context.config.rolloutSalt === featureFlagsConfigSchema.parse({}).rolloutSalt
      ) {
        // Warned, not refused: the default salt is not a security problem — it
        // decides which subjects land in a rollout, not who is allowed in. But two
        // deployments sharing it bucket the same people, which makes a staged
        // rollout no longer independent between environments.
        context.logger.warn(
          { moduleId: 'feature-flags' },
          'feature-flags is using the default rollout salt in production: set FEATURE_FLAGS_ROLLOUT_SALT',
        );
      }
    },

    async shutdown(): Promise<void> {
      // Nothing to release.
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('feature-flags', async () => ({
        status: 'ok',
        detail: `evaluation audit: ${context.config.auditEvaluations ? 'on' : 'off'}`,
      }));
    },
  };
}

export const featureFlagsModule = defineModule<FeatureFlagsConfig>({
  ...moduleDeclarations('feature-flags'),
  configSchema: featureFlagsConfigSchema,
  tenantScoped: true,
  create: (context) => createFeatureFlags(context),
});
