import { Module } from '@nestjs/common';
import {
  CatalogController,
  ProductController,
  ProductVariantController,
  OrderController,
  OrderLineController,
} from './ecommerce.controller';
import { EcommerceService } from './ecommerce.service';

/**
 * TrustOS E-commerce domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    CatalogController,
    ProductController,
    ProductVariantController,
    OrderController,
    OrderLineController,
  ],
  providers: [EcommerceService],
  exports: [EcommerceService],
})
export class EcommerceDomainModule {}
