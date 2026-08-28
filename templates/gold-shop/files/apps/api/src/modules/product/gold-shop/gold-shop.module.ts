import { Module } from '@nestjs/common';
import {
  GoldPriceController,
  GoldItemController,
  GoldOrderController,
  GoldInvoiceController,
} from './gold-shop.controller';
import { GoldShopService } from './gold-shop.service';

/**
 * TrustOS Gold Shop domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    GoldPriceController,
    GoldItemController,
    GoldOrderController,
    GoldInvoiceController,
  ],
  providers: [GoldShopService],
  exports: [GoldShopService],
})
export class GoldShopDomainModule {}
