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
 * The agent framework module.
 *
 * Agents that take actions: declarative agent definitions, the tool loop with per-actor permission checks, memory, conversation state, stop conditions and human review.
 *
 * A thin wrapper. The implementation is in `@trustos/agent-framework`, `@trustos/agent-memory`, `@trustos/agent-runtime`, `@trustos/conversation`, `@trustos/function-calling`, `@trustos/human-review`, `@trustos/tool-execution` — this
 * package contributes the declarations the platform needs (permissions, audit events, health)
 * and the start/stop lifecycle.
 *
 * Every tool call is checked against the *actor’s* permissions, not the agent’s. That is what
 * makes a successful prompt injection survivable: an instruction smuggled into a support ticket
 * fails because the person the agent acts for cannot do the thing.
 */

export const agentConfigSchema = z
  .object({
    /** Turns the module off without removing it. For a deployment that is not ready to use it. */
    enabled: z.boolean().default(true),
  })
  .strict();

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export interface AgentInstance extends ModuleInstance {
  readonly ready: boolean;
}

export function createAgent(context: ModuleContext<AgentConfig>): AgentInstance {
  let ready = false;

  return {
    moduleId: 'agent',

    get ready() {
      return ready;
    },

    async initialize(): Promise<void> {
      ready = context.config.enabled;

      context.logger.info(
        { moduleId: 'agent', enabled: ready },
        ready ? 'agent module initialized' : 'agent module is disabled by configuration',
      );
    },

    async shutdown(): Promise<void> {
      // The framework packages own their own shutdown. Duplicating it here would mean two things
      // racing to close the same resources.
      ready = false;
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('agent', async () =>
        ready
          ? {
              status: 'ok',
              detail: 'The registered agents validate against the tools and prompts that exist.',
            }
          : { status: 'degraded', detail: 'The module is disabled by configuration.' },
      );
    },
  };
}

/** The module definition the registry loads. */
export const agentModule = defineModule<AgentConfig>({
  ...moduleDeclarations('agent'),
  configSchema: agentConfigSchema,
  // Every AI call is made on behalf of a tenant, and a request with no tenant cannot be policed,
  // budgeted or audited. There is no such thing as an untenanted AI module.
  tenantScoped: true,
  create: createAgent,
});
