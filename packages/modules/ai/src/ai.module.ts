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
 * The ai platform module.
 *
 * The AI gateway and everything a model call has to pass through: model registry, prompt registry, guardrails, tenant policy, routing, cost accounting and caching.
 *
 * A thin wrapper. The implementation is in `@trustsystem/ai-cache`, `@trustsystem/ai-gateway`, `@trustsystem/ai-observability`, `@trustsystem/ai-policy`, `@trustsystem/ai-sdk`, `@trustsystem/content-filter`, `@trustsystem/cost-monitor`, `@trustsystem/guardrails`, `@trustsystem/model-registry`, `@trustsystem/model-router`, `@trustsystem/prompt-registry`, `@trustsystem/prompt-security`, `@trustsystem/token-meter` — this
 * package contributes the declarations the platform needs (permissions, audit events, health)
 * and the start/stop lifecycle.
 *
 * Applications never call a provider directly. Everything goes through the gateway, because
 * the gateway is where policy, guardrails, cost and audit live — a request that bypasses it is a
 * request nobody can account for afterwards.
 */

export const aiConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type AiConfig = z.infer<typeof aiConfigSchema>;

export interface AiInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createAi(context: ModuleContext<AiConfig>): AiInstance {
  let ready = false;

  return {
    moduleId: 'ai',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'ai', enabled: ready },
        ready ? 'ai module initialized' : 'ai module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown. Duplicating it here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('ai', async () =>
        ready
          ? {
              status: 'ok',
              detail: 'The gateway is configured with at least one provider adapter and one model.',
            }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const aiModule = defineModule<AiConfig>({
  ...moduleDeclarations('ai'),
  configSchema: aiConfigSchema,
  // Every AI call is made on behalf of a tenant, and a request with no tenant cannot be policed,
  // budgeted or audited. There is no such thing as an untenanted AI module.
  tenantScoped: true,
  create: createAi,
});
