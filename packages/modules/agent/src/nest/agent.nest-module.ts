import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustos/module-sdk/nest';
import { agentModule } from '../agent.module';

/**
 * NestJS wiring for the agent framework module.
 *
 * Registers the lifecycle and the health indicator. The framework packages are wired by the
 * application, because every one of them takes ports — a store, an adapter, a vector database —
 * that only the application knows.
 */
@Module({})
export class AgentModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: AgentModule,
      providers: [...moduleProviders(agentModule, binding)],
      exports: [],
    };
  }
}
