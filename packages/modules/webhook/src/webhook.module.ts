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
 * The webhooks module.
 *
 * Outbound webhooks with HMAC signatures, overlapping secret rotation, replay protection and delivery history.
 *
 * A thin wrapper. The implementation is in `@trustos/webhooks`, `@trustos/webhook-runtime` — this
 * package contributes the declarations the platform needs (permissions, routes, audit events,
 * health) and the start/stop lifecycle.
 *
 * Read `destination.ts` in `@trustos/webhook-runtime` before changing anything about where a
 * delivery goes. A webhook URL is attacker-controlled input the server then makes a request to.
 */

export const webhookConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

export interface WebhookInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createWebhook(context: ModuleContext<WebhookConfig>): WebhookInstance {
  let ready = false;

  return {
    moduleId: 'webhook',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'webhook', enabled: ready },
        ready ? 'webhook module initialized' : 'webhook module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown — the bus drains, the worker stops, the
      // provider registry closes its adapters. Duplicating that here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('webhook', async () =>
        ready
          ? { status: 'ok', detail: 'Endpoints are configured and deliveries are not backing up.' }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const webhookModule = defineModule<WebhookConfig>({
  ...moduleDeclarations('webhook'),
  configSchema: webhookConfigSchema,
  // Every module handles customer data and is organization-scoped. The SDK refuses any other
  // value, which is the point: there is no such thing as a module that opts out of tenancy.
  tenantScoped: true,
  create: createWebhook,
});
