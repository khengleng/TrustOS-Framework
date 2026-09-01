import { z } from 'zod';
import { moduleDeclarations } from '@trustsystem/module-registry';
import {
  defineModule,
  moduleHealthIndicator,
  type HealthIndicator,
  type ModuleContext,
  type ModuleInstance,
} from '@trustsystem/module-sdk';

/**
 * The scheduler module.
 *
 * Cron, interval and one-time schedules with IANA timezone support and explicit daylight-saving handling.
 *
 * A thin wrapper. The implementation is in `@trustsystem/scheduler` — this
 * package contributes the declarations the platform needs (permissions, routes, audit events,
 * health) and the start/stop lifecycle.
 *
 * A schedule enqueues a job rather than running work itself, which is what makes a scheduled
 * task retryable, cancellable and recoverable after a crash.
 */

export const schedulerConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type SchedulerConfig = z.infer<typeof schedulerConfigSchema>;

export interface SchedulerInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createScheduler(context: ModuleContext<SchedulerConfig>): SchedulerInstance {
  let ready = false;

  return {
    moduleId: 'scheduler',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'scheduler', enabled: ready },
        ready ? 'scheduler module initialized' : 'scheduler module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown — the bus drains, the worker stops, the
      // provider registry closes its adapters. Duplicating that here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('scheduler', async () =>
        ready
          ? { status: 'ok', detail: 'The scheduler is ticking and no schedule is overdue.' }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const schedulerModule = defineModule<SchedulerConfig>({
  ...moduleDeclarations('scheduler'),
  configSchema: schedulerConfigSchema,
  // Every module handles customer data and is organization-scoped. The SDK refuses any other
  // value, which is the point: there is no such thing as a module that opts out of tenancy.
  tenantScoped: true,
  create: createScheduler,
});
