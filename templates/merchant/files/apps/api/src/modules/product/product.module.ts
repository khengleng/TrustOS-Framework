import { Module } from '@nestjs/common';
import { MerchantDomainModule } from './merchant/merchant.module';

/**
 * The product module `AppModule` imports.
 *
 * An aggregator with one layer today. It exists so the composition root has one fixed name to
 * import, and so a template extending this one can add a layer without editing app.module.ts.
 */
@Module({
  imports: [MerchantDomainModule],
  exports: [MerchantDomainModule],
})
export class ProductModule {}
