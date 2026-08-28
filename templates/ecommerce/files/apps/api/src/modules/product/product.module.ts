import { Module } from '@nestjs/common';
import { MerchantDomainModule } from './merchant/merchant.module';
import { EcommerceDomainModule } from './ecommerce/ecommerce.module';

/**
 * The product module `AppModule` imports.
 *
 * An aggregator over the template chain (merchant -> ecommerce). It exists so the composition
 * root has one fixed name to import, and so a layer can be added without anybody editing
 * app.module.ts.
 */
@Module({
  imports: [MerchantDomainModule, EcommerceDomainModule],
  exports: [MerchantDomainModule, EcommerceDomainModule],
})
export class ProductModule {}
