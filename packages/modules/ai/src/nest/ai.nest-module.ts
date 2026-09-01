import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustsystem/module-sdk/nest';
import { aiModule } from '../ai.module';

/**
 * NestJS wiring for the ai platform module.
 *
 * Registers the lifecycle and the health indicator. The framework packages are wired by the
 * application, because every one of them takes ports — a store, an adapter, a vector database —
 * that only the application knows.
 */
@Module({})
export class AiModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: AiModule,
      providers: [...moduleProviders(aiModule, binding)],
      exports: [],
    };
  }
}
