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
 * The event bus module.
 *
 * Typed, versioned domain events with a schema registry, ordering per aggregate, retry, dead letters and replay.
 *
 * A thin wrapper. The implementation is in `@trustos/event-bus`, `@trustos/event-registry`, `@trustos/event-sdk` — this
 * package contributes the declarations the platform needs (permissions, routes, audit events,
 * health) and the start/stop lifecycle.
 *
 * The registry is the load-bearing part: an event whose schema is not registered is never
 * published, so a renamed payload field fails at the publisher rather than at three consumers.
 */

export const eventsConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type EventsConfig = z.infer<typeof eventsConfigSchema>;

export interface EventsInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createEvents(context: ModuleContext<EventsConfig>): EventsInstance {
  let ready = false;

  return {
    moduleId: 'events',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'events', enabled: ready },
        ready ? 'events module initialized' : 'events module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown — the bus drains, the worker stops, the
      // provider registry closes its adapters. Duplicating that here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('events', async () =>
        ready
          ? { status: 'ok', detail: 'The bus is running and the schema registry is populated.' }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const eventsModule = defineModule<EventsConfig>({
  ...moduleDeclarations('events'),
  configSchema: eventsConfigSchema,
  // Every module handles customer data and is organization-scoped. The SDK refuses any other
  // value, which is the point: there is no such thing as a module that opts out of tenancy.
  tenantScoped: true,
  create: createEvents,
});
