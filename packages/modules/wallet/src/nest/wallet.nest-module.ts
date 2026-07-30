import { DynamicModule, Module } from '@nestjs/common';
import { moduleProviders, type ModuleHostBinding } from '@trustos/module-sdk/nest';
import { walletModule } from '../wallet.module';

/**
 * NestJS wiring for the wallets module.
 *
 * Registers the lifecycle and the health indicator. The framework packages are wired by the
 * application, because every one of them takes a store the application supplies.
 */
@Module({})
export class WalletModule {
  static forRoot(binding: ModuleHostBinding): DynamicModule {
    return {
      module: WalletModule,
      providers: [...moduleProviders(walletModule, binding)],
      exports: [],
    };
  }
}
