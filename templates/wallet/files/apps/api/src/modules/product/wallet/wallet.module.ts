import { Module } from '@nestjs/common';
import {
  WalletProfileController,
  WalletTransferController,
  TransferLimitProfileController,
} from './wallet.controller';
import { WalletService } from './wallet.service';

/**
 * TrustOS Wallet domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [WalletProfileController, WalletTransferController, TransferLimitProfileController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletDomainModule {}
