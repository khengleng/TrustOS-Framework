import { Module } from '@nestjs/common';
import {
  BranchesController,
  MerchantMembersController,
  MerchantsController,
  StoresController,
} from './merchant.controller';
import { MerchantService } from './merchant.service';

/**
 * Merchant domain module.
 *
 * One module per template in the inheritance chain. `product.module.ts` next to this folder is
 * the aggregator `AppModule` imports by a fixed name — a template that extends this one adds its
 * own folder beside this and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    MerchantsController,
    StoresController,
    BranchesController,
    MerchantMembersController,
  ],
  providers: [MerchantService],
  exports: [MerchantService],
})
export class MerchantDomainModule {}
