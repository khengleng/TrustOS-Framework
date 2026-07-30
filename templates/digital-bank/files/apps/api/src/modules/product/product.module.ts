import { Module } from '@nestjs/common';
import { WalletDomainModule } from './wallet/wallet.module';
import { DigitalBankDomainModule } from './digital-bank/digital-bank.module';

/**
 * The product module `AppModule` imports.
 *
 * An aggregator over the template chain (wallet -> digital-bank). It exists so the composition
 * root has one fixed name to import, and so a layer can be added without anybody editing
 * app.module.ts.
 */
@Module({
  imports: [WalletDomainModule, DigitalBankDomainModule],
  exports: [WalletDomainModule, DigitalBankDomainModule],
})
export class ProductModule {}
