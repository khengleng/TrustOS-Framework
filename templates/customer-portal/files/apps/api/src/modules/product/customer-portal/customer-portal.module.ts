import { Module } from '@nestjs/common';
import {
  PortalProfileController,
  PortalDocumentController,
  PortalNotificationController,
  SupportRequestController,
} from './customer-portal.controller';
import { CustomerPortalService } from './customer-portal.service';

/**
 * TrustOS Customer Portal domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    PortalProfileController,
    PortalDocumentController,
    PortalNotificationController,
    SupportRequestController,
  ],
  providers: [CustomerPortalService],
  exports: [CustomerPortalService],
})
export class CustomerPortalDomainModule {}
