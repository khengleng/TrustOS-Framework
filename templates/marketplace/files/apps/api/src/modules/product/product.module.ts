import { Module } from '@nestjs/common';
import { MerchantDomainModule } from './merchant/merchant.module';
import { EcommerceDomainModule } from './ecommerce/ecommerce.module';
import { MarketplaceDomainModule } from './marketplace/marketplace.module';

/**
 * The product module `AppModule` imports.
 *
 * An aggregator over the template chain (merchant -> ecommerce -> marketplace). It exists so the
 * composition root has one fixed name to import, and so a layer can be added without anybody
 * editing app.module.ts.
 */
@Module({
  imports: [MerchantDomainModule, EcommerceDomainModule, MarketplaceDomainModule],
  exports: [MerchantDomainModule, EcommerceDomainModule, MarketplaceDomainModule],
})
export class ProductModule {}
