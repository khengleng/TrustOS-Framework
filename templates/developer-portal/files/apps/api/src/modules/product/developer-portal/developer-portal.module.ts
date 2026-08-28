import { Module } from '@nestjs/common';
import {
  ApiApplicationController,
  ApiKeyRecordController,
  ApiUsageRecordController,
  CodeExampleController,
  SdkReleaseController,
} from './developer-portal.controller';
import { DeveloperPortalService } from './developer-portal.service';

/**
 * TrustOS Developer Portal domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    ApiApplicationController,
    ApiKeyRecordController,
    ApiUsageRecordController,
    CodeExampleController,
    SdkReleaseController,
  ],
  providers: [DeveloperPortalService],
  exports: [DeveloperPortalService],
})
export class DeveloperPortalDomainModule {}
