import { moduleDeclarations } from '@trustos/module-registry';
import {
  defineModule,
  moduleHealthIndicator,
  type HealthIndicator,
  type ModuleContext,
  type ModuleInstance,
} from '@trustos/module-sdk';
import { workflowConfigSchema, type WorkflowConfig } from './config';
import { RecordingEscalationHook, type EscalationHook } from './escalation';
import { PrismaWorkflowStore, type WorkflowStore } from './store';
import { WorkflowService } from './workflow.service';

export interface WorkflowInstanceModule extends ModuleInstance {
  readonly service: WorkflowService;
  readonly escalation: EscalationHook;
}

export interface WorkflowOverrides {
  store?: WorkflowStore;
  escalation?: EscalationHook;
}

export function createWorkflow(
  context: ModuleContext<WorkflowConfig>,
  overrides: WorkflowOverrides = {},
): WorkflowInstanceModule {
  const escalation = overrides.escalation ?? new RecordingEscalationHook();
  const store = overrides.store ?? new PrismaWorkflowStore(context);
  const service = new WorkflowService(context, store, escalation);

  return {
    moduleId: 'workflow',
    service,
    escalation,

    async initialize(): Promise<void> {
      if (!context.prisma && !overrides.store) {
        throw new Error(
          'workflow needs a database. Run the module migration and provide the Prisma client.',
        );
      }

      if (escalation.id === 'recording') {
        // Said at start-up rather than left in the documentation: an SLA that
        // breaches and notifies nobody looks like a working control.
        context.logger.warn(
          { moduleId: 'workflow', hook: escalation.id },
          'workflow escalations are recorded but not delivered: wire an EscalationHook',
        );
      }
    },

    async shutdown(): Promise<void> {
      // Nothing to release; the module owns no timer.
    },

    healthIndicator(): HealthIndicator {
      return moduleHealthIndicator('workflow', async () => ({
        status: 'ok',
        detail: `escalation hook: ${escalation.id}`,
      }));
    },
  };
}

export const workflowModule = defineModule<WorkflowConfig>({
  ...moduleDeclarations('workflow'),
  configSchema: workflowConfigSchema,
  tenantScoped: true,
  create: (context) => createWorkflow(context),
});
