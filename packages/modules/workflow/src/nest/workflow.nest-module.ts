import { DynamicModule, Module } from '@nestjs/common';
import {
  moduleProviders,
  moduleServiceProvider,
  type ModuleHostBinding,
} from '@trustsystem/module-sdk/nest';
import { workflowModule, type WorkflowInstanceModule } from '../workflow.module';
import { WorkflowController } from './workflow.controller';
import { WORKFLOW_SERVICE } from './tokens';

/** NestJS wiring for the workflow module. */
@Module({})
export class WorkflowModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: WorkflowModule,
      controllers: [WorkflowController],
      providers: [
        ...moduleProviders(workflowModule, binding),
        moduleServiceProvider<WorkflowInstanceModule, WorkflowInstanceModule['service']>(
          'workflow',
          WORKFLOW_SERVICE,
          (instance) => instance.service,
        ),
      ],
      // Exported so product code can start a workflow for its own subject — a
      // payout, a merchant onboarding — without a second approval engine.
      exports: [WORKFLOW_SERVICE],
    };
  }
}
