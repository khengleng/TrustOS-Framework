import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustsystem/module-sdk/nest';
import { settlementModule } from '../settlement.module';

/**
 * NestJS wiring for the settlement module.
 *
 * Registers the lifecycle and the health indicator. The framework packages are wired by the
 * application, because every one of them takes a store the application supplies.
 */
@Module({})
export class SettlementModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: SettlementModule,
      providers: [...moduleProviders(settlementModule, binding)],
      exports: [],
    };
  }
}
