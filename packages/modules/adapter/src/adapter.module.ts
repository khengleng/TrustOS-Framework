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
 * The provider adapters module.
 *
 * The five-method provider contract with a registry, circuit-breaker-guarded calls and lifecycle management.
 *
 * A thin wrapper. The implementation is in `@trustos/adapter-framework`, `@trustos/provider-sdk` — this
 * package contributes the declarations the platform needs (permissions, routes, audit events,
 * health) and the start/stop lifecycle.
 *
 * The framework ships no provider implementation. That is the phase 6 boundary: the seam is
 * the deliverable, and the adapter belongs to whatever product is built on this.
 */

export const adapterConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type AdapterConfig = z.infer<typeof adapterConfigSchema>;

export interface AdapterInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createAdapter(context: ModuleContext<AdapterConfig>): AdapterInstance {
  let ready = false;

  return {
    moduleId: 'adapter',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'adapter', enabled: ready },
        ready ? 'adapter module initialized' : 'adapter module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown — the bus drains, the worker stops, the
      // provider registry closes its adapters. Duplicating that here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('adapter', async () =>
        ready
          ? { status: 'ok', detail: 'Every registered provider is reachable.' }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const adapterModule = defineModule<AdapterConfig>({
  ...moduleDeclarations('adapter'),
  configSchema: adapterConfigSchema,
  // Every module handles customer data and is organization-scoped. The SDK refuses any other
  // value, which is the point: there is no such thing as a module that opts out of tenancy.
  tenantScoped: true,
  create: createAdapter,
});
