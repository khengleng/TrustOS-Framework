import { Module } from '@nestjs/common';
import {
  PolicyHolderController,
  InsuranceProductController,
  PolicyController,
  PremiumController,
  ClaimController,
} from './insurance.controller';
import { InsuranceService } from './insurance.service';

/**
 * TrustOS Insurance domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    PolicyHolderController,
    InsuranceProductController,
    PolicyController,
    PremiumController,
    ClaimController,
  ],
  providers: [InsuranceService],
  exports: [InsuranceService],
})
export class InsuranceDomainModule {}
