import { Module } from '@nestjs/common';
import {
  CollectorController,
  CollectionCaseController,
  CaseAssignmentController,
  PaymentPromiseController,
  FieldVisitController,
} from './collection.controller';
import { CollectionService } from './collection.service';

/**
 * TrustOS Collections domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    CollectorController,
    CollectionCaseController,
    CaseAssignmentController,
    PaymentPromiseController,
    FieldVisitController,
  ],
  providers: [CollectionService],
  exports: [CollectionService],
})
export class CollectionDomainModule {}
