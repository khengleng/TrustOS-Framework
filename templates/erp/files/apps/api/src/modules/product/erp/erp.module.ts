import { Module } from '@nestjs/common';
import {
  DepartmentController,
  EmployeeController,
  ProjectController,
  InventoryItemController,
  PurchaseRequestController,
} from './erp.controller';
import { ErpService } from './erp.service';

/**
 * TrustOS ERP domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    DepartmentController,
    EmployeeController,
    ProjectController,
    InventoryItemController,
    PurchaseRequestController,
  ],
  providers: [ErpService],
  exports: [ErpService],
})
export class ErpDomainModule {}
