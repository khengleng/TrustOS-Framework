import { Module } from '@nestjs/common';
import { ChangeRequestController } from './change-request.controller';
import { ChangeRequestService } from './change-request.service';
import { ChangeRequestWorkflowService } from './change-request-workflow.service';

/**
 * The workflow-governed feature module.
 *
 * Named `ProductModule` at `modules/product/` because `AppModule` imports it by that fixed
 * path — the same contract every TrustOS template follows. Replacing `ChangeRequest` with
 * your own business object is a change inside this folder rather than a change to the
 * composition root.
 *
 * The workflow *engine* is not provided here. It is a global provider from `AppModule`,
 * because one engine per process shares one compiled-definition cache and a second would
 * compile every published definition twice.
 */
@Module({
  controllers: [ChangeRequestController],
  providers: [ChangeRequestService, ChangeRequestWorkflowService],
  exports: [ChangeRequestService, ChangeRequestWorkflowService],
})
export class ProductModule {}
