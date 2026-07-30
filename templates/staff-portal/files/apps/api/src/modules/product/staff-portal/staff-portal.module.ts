import { Module } from '@nestjs/common';
import {
  StaffProfileController,
  StaffTaskController,
  SavedSearchController,
  StaffNotificationController,
} from './staff-portal.controller';
import { StaffPortalService } from './staff-portal.service';

/**
 * TrustOS Staff Portal domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    StaffProfileController,
    StaffTaskController,
    SavedSearchController,
    StaffNotificationController,
  ],
  providers: [StaffPortalService],
  exports: [StaffPortalService],
})
export class StaffPortalDomainModule {}
