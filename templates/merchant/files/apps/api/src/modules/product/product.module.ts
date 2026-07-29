import { Module } from '@nestjs/common';
import {
  BranchesController,
  MerchantMembersController,
  MerchantsController,
  StoresController,
} from './product.controller';
import { ProductService } from './product.service';

/**
 * Merchant product module.
 *
 * `AppModule` imports this by a fixed name, so replacing the domain is a
 * change inside this folder rather than a change to the composition root.
 */
@Module({
  controllers: [
    MerchantsController,
    StoresController,
    BranchesController,
    MerchantMembersController,
  ],
  providers: [ProductService],
  exports: [ProductService],
})
export class ProductModule {}
