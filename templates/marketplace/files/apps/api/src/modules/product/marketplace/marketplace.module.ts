import { Module } from '@nestjs/common';
import {
  SellerController,
  ListingController,
  SellerPayoutController,
  DisputeController,
} from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';

/**
 * TrustOS Marketplace domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [SellerController, ListingController, SellerPayoutController, DisputeController],
  providers: [MarketplaceService],
  exports: [MarketplaceService],
})
export class MarketplaceDomainModule {}
