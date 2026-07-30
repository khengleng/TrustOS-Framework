import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustos/module-sdk/nest';
import { jobsModule } from '../jobs.module';

/**
 * NestJS wiring for the background jobs module.
 *
 * Registers the lifecycle and the health indicator. The framework packages have their own Nest
 * modules for the services themselves — importing this one does not import those, so an
 * application chooses what it actually wires.
 */
@Module({})
export class JobsModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: JobsModule,
      providers: [...moduleProviders(jobsModule, binding)],
      exports: [],
    };
  }
}
