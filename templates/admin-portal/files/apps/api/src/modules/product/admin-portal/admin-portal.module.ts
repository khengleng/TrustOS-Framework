import { Module } from '@nestjs/common';
import { SystemSettingController, OperatorNoteController } from './admin-portal.controller';
import { AdminPortalService } from './admin-portal.service';

/**
 * TrustOS Admin Portal domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [SystemSettingController, OperatorNoteController],
  providers: [AdminPortalService],
  exports: [AdminPortalService],
})
export class AdminPortalDomainModule {}
