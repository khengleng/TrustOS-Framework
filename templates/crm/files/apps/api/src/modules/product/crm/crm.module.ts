import { Module } from '@nestjs/common';
import {
  CustomerController,
  ContactController,
  LeadController,
  PipelineStageController,
  OpportunityController,
  ActivityController,
  CrmTaskController,
} from './crm.controller';
import { CrmService } from './crm.service';

/**
 * TrustOS CRM domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    CustomerController,
    ContactController,
    LeadController,
    PipelineStageController,
    OpportunityController,
    ActivityController,
    CrmTaskController,
  ],
  providers: [CrmService],
  exports: [CrmService],
})
export class CrmDomainModule {}
