import { Module } from '@nestjs/common';
import {
  CitizenController,
  GovernmentServiceController,
  ServiceApplicationController,
  ServiceAppointmentController,
  PublicNoticeController,
} from './government.controller';
import { GovernmentService } from './government.service';

/**
 * TrustOS Government Services domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    CitizenController,
    GovernmentServiceController,
    ServiceApplicationController,
    ServiceAppointmentController,
    PublicNoticeController,
  ],
  providers: [GovernmentService],
  exports: [GovernmentService],
})
export class GovernmentDomainModule {}
