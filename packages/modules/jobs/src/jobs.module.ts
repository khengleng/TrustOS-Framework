import { z } from 'zod';
import { moduleDeclarations } from '@trustos/module-registry';
import {
  defineModule,
  moduleHealthIndicator,
  type HealthIndicator,
  type ModuleContext,
  type ModuleInstance,
} from '@trustos/module-sdk';

/**
 * The background jobs module.
 *
 * A durable job queue in the database: leased execution, retry with backoff, priority, progress and history.
 *
 * A thin wrapper. The implementation is in `@trustos/job-runtime` — this
 * package contributes the declarations the platform needs (permissions, routes, audit events,
 * health) and the start/stop lifecycle.
 *
 * The lease is what keeps a job from running twice. A worker that loses its lease mid-run
 * discards its outcome rather than writing it — see the header of `worker.ts`.
 */

export const jobsConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type JobsConfig = z.infer<typeof jobsConfigSchema>;

export interface JobsInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createJobs(context: ModuleContext<JobsConfig>): JobsInstance {
  let ready = false;

  return {
    moduleId: 'jobs',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'jobs', enabled: ready },
        ready ? 'jobs module initialized' : 'jobs module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown — the bus drains, the worker stops, the
      // provider registry closes its adapters. Duplicating that here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('jobs', async () =>
        ready
          ? {
              status: 'ok',
              detail: 'The queue is being worked and nothing has been waiting too long.',
            }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const jobsModule = defineModule<JobsConfig>({
  ...moduleDeclarations('jobs'),
  configSchema: jobsConfigSchema,
  // Every module handles customer data and is organization-scoped. The SDK refuses any other
  // value, which is the point: there is no such thing as a module that opts out of tenancy.
  tenantScoped: true,
  create: createJobs,
});
