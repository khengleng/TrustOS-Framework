import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustos/module-sdk/nest';
import { adapterModule } from '../adapter.module';

/**
 * NestJS wiring for the provider adapters module.
 *
 * Registers the lifecycle and the health indicator. The framework packages have their own Nest
 * modules for the services themselves — importing this one does not import those, so an
 * application chooses what it actually wires.
 */
@Module({})
export class AdapterModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: AdapterModule,
      providers: [...moduleProviders(adapterModule, binding)],
      exports: [],
    };
  }
}
