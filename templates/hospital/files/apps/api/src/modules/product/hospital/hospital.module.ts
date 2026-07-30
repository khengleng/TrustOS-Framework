import { Module } from '@nestjs/common';
import {
  HospitalDepartmentController,
  WardController,
  BedController,
  AdmissionController,
} from './hospital.controller';
import { HospitalService } from './hospital.service';

/**
 * TrustOS Hospital domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [HospitalDepartmentController, WardController, BedController, AdmissionController],
  providers: [HospitalService],
  exports: [HospitalService],
})
export class HospitalDomainModule {}
